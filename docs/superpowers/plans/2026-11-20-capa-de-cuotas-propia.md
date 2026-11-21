# Capa de cuotas propia (consenso, historial y CLV): plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tomar de Oddspapi las ideas que valen (consenso de varias casas sin clones, historial de cada precio, sello de frescura, liquidación) y aplicarlas a las fuentes que Oddsy ya tiene, sin usar su API.

**Architecture:** Tres cambios pequeños sobre lo que existe. (1) `lib/pinnacle.mjs` deja de leer una sola casa y saca el consenso de las que ya vienen en la misma llamada. (2) Las lecturas de Betano dejan de pisarse: se guarda el historial. (3) Con ese historial, el registro de picks mide el valor contra el cierre (CLV).

**Tech Stack:** Node ≥ 22 sin dependencias nuevas, Supabase por REST, `node --test`.

## Qué hace Oddspapi y qué copiamos

| Lo que hacen | Qué tenemos | Qué haremos |
|---|---|---|
| Juntan ~300 casas por partido | Una casa (Pinnacle por The Odds API) o DraftKings (ESPN) | Consenso de hasta 10 casas en la misma llamada (Task 1 y 2) |
| Agrupan clones: 122 casas eran 32 precios distintos | Nada | Deduplicar duplas de cuotas idénticas antes de la mediana (Task 1) |
| Historial de cada precio (movimiento de línea) | `betano_read` pisa cada lectura y borra a los 7 días | Tabla de historial (Task 3) |
| Sello de tiempo de la casa y marca de casa inactiva | `readAt` y `freshness` | Ya está: no se toca |
| Liquidación por mercado | `lib/picklog.mjs` cierra los picks con ESPN | Ya está: se le suma el CLV (Task 4) |

Donde no podemos igualarlos gratis: amplitud (300 casas, 60 deportes) y tiempo real. Donde sí podemos ser mejores para nuestro uso: ellos no tienen modelo ni miden ventaja; nosotros medimos la cuota de la casa del usuario (Betano Colombia) contra el modelo y contra el cierre.

## Global Constraints

- Sin dependencias nuevas ni fuentes nuevas: solo The Odds API (plan gratis), ESPN y el lector de Betano.
- Ningún test toca la red: `fetch` y la base se inyectan.
- El consenso es insumo del modelo y nunca se muestra (Ruling 11, `lib/book.mjs`).
- El gasto de créditos de The Odds API no puede subir. Si la Task 0 dice que sube, la Task 2 no se hace.
- Fuera de alcance: liga UTR, tenis (The Odds API solo trae los torneos grandes), cuotas en vivo.

## Review Focus

1. Clones: dos marcas con la misma dupla de cuotas cuentan una vez. → test en Task 1.
2. Menos de 3 precios independientes: se usa Pinnacle sola, como hoy, nunca una mediana de dos. → test en Task 1.
3. El historial no puede crecer sin tope ni duplicar una lectura idéntica a la anterior. → test en Task 3.
4. Un pick sin cierre de Betano queda con CLV nulo, nunca 0. → test en Task 4.

---

### Task 0: Verificar el costo en créditos (manual, 2 llamadas)

- [ ] Llamar a The Odds API para una liga con `bookmakers=pinnacle` y luego con 10 casas (`pinnacle,betfair_ex_eu,williamhill,unibet_eu,betsson,marathonbet,sport888,betclic,nordicbet,matchbook`). Comparar la cabecera `x-requests-last` de las dos.
- [ ] Si las dos cuestan lo mismo, seguir. Si la segunda cuesta más, saltar la Task 2 y dejar constancia aquí.

**Resultado (2026-11-20):** las dos llamadas costaron 2 créditos cada una (Premier, `h2h,totals`). De las 10 casas, 8 traían precio. Hecho.

**Resultado de la Task 2 (2026-11-20), sin activar:** en 20 partidos de la Premier el consenso se aparta de Pinnacle 0.36 puntos de probabilidad de media (máximo 0.79). No hay cierres de varias casas guardados para medir si acierta más, y la diferencia es muy chica para justificar activarlo a ciegas. `consensusLine` queda escrita y probada; `pinnacleLines` sigue usando Pinnacle sola.

### Task 1: Consenso sin margen (puro)

**Files:** `lib/pinnacle.mjs`, `test/pinnacle.test.mjs`.

- [ ] Test primero: tres casas distintas → mediana por mercado; dos con la misma dupla cuentan una; con menos de 3 independientes devuelve la línea de Pinnacle; totales y hándicaps solo se juntan si la línea coincide con la de Pinnacle.
- [ ] Implementación junto a `pinnacleLine`:

```js
export const MIN_BOOKS = 3;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const lineOfBook = (ev, book) => pinnacleLine({ ...ev, bookmakers: [{ ...book, key: 'pinnacle' }] });

// Mediana de las casas con precio distinto; la línea de Pinnacle fija qué hándicap y qué total se comparan.
export function consensusLine(ev) {
  const pin = pinnacleLine(ev);
  const seen = new Set();
  const lines = (ev?.bookmakers ?? []).map((b) => lineOfBook(ev, b)).filter((l) => l && !seen.has(JSON.stringify(l)) && seen.add(JSON.stringify(l)));
  const ref = pin ?? lines[0];
  if (!ref || lines.length < MIN_BOOKS) return pin;
  const med = (pick) => { const xs = lines.map(pick).filter(Number.isFinite); return xs.length >= MIN_BOOKS ? median(xs) : null; };
  const ml = ref.ml && ref.ml.map((_, i) => med((l) => l.ml?.length === ref.ml.length ? l.ml[i] : NaN));
  const two = (k) => { const p = ref[k] && med((l) => (l[k]?.line === ref[k].line ? l[k].p : NaN)); return p == null ? ref[k] : { line: ref[k].line, p }; };
  const sum = ml?.every((x) => x != null) ? ml.reduce((s, x) => s + x, 0) : 0;
  return { ...(ref.ml && { ml: sum ? ml.map((x) => x / sum) : ref.ml }), ...(ref.spread && { spread: two('spread') }), ...(ref.total && { total: two('total') }) };
}
```

- [ ] `node --test test/pinnacle.test.mjs` en verde. Commit.

### Task 2: Pedir las 10 casas y usar el consenso

**Files:** `lib/pinnacle.mjs`, `test/pinnacle.test.mjs`. Depende de la Task 0.

- [ ] En `eventsOf`, cambiar `bookmakers=pinnacle` por la lista de la Task 0 (constante `BOOKS`).
- [ ] En `pinnacleLines`, cambiar `pinnacleLine(ev)` por `consensusLine(ev)`.
- [ ] Medir antes de activar: `scripts/market-backtest.mjs` con consenso contra Pinnacle sola en los cierres guardados. Se activa solo si el log-loss no empeora; el resultado va a `docs/accuracy.json`.

### Task 3: Historial de las lecturas de Betano

**Files:** `supabase/migrations/2026112x_betano_history.sql`, `lib/db.mjs`, `lib/betano-read.mjs`, `test/betano-read.test.mjs`.

- [ ] Migración: `betano_history (key text, read_at timestamptz, start_at timestamptz, game jsonb, primary key (key, read_at))`, RLS sin políticas y purga por cron a los 120 días (lo que usa `LEARN_DAYS`).
- [ ] `ingest` guarda también en el historial, solo si `game` cambió frente a la última lectura de esa `key` (comparar el JSON; una consulta por lote).
- [ ] Test: dos lecturas iguales dejan una fila; una cuota distinta deja dos.

### Task 4: CLV en el registro de picks

**Files:** `lib/picklog.mjs`, `lib/db.mjs`, migración de `pick_log`, `test/picklog.test.mjs`, `public/views/` del registro.

- [ ] Al cerrar un pick, buscar en `betano_history` la última lectura anterior al inicio del partido y sacar la cuota de cierre de su selección con `priceFor` (`public/betano.js`).
- [ ] Guardar `close_price` y `clv = precio del pick / close_price − 1` (nulo sin cierre).
- [ ] El registro muestra el CLV medio junto al acierto. Es la señal temprana de si el modelo gana: llega con decenas de picks, no con cientos.
- [ ] Test: pick a 2.00 con cierre 1.80 → CLV +11.1 %; sin lectura previa al inicio → nulo.

## Verificación final

- [ ] `node --test` completo en verde.
- [ ] Tras el push a main: `x-requests-remaining` de The Odds API baja al mismo ritmo que antes durante 3 días.
- [ ] `betano_history` crece solo cuando cambian cuotas.

## Auditoría (2026-11-20)

- **CLV casi siempre 0 (corregido).** El tick vuelve a fotografiar el pick cada 15 min hasta el inicio, así que `betano_odds` ya es casi el cierre. Ahora el CLV sale solo del historial: la cuota que regía 3 h antes del inicio (cuando el pick entra al registro) contra la última antes del inicio.
- **El historial perdía la hora del cambio (corregido).** Con la clave (partido, hash) una cuota repetida movía su `read_at` y una cuota que volvía (A → B → A) no se registraba. Ahora la tabla es (partido, read_at) y se inserta solo si la cuota cambió frente a la lectura guardada, comparando el JSON con las claves ordenadas (Postgres reordena el jsonb).
- **Lecturas en juego (corregido).** El lector guarda partidos empezados hasta 12 h; el historial ahora solo guarda los que no empezaron.
- **Tenis sin cierre (corregido).** El pick guarda el nombre del jugador; la búsqueda usa el lado (A o B).
- **Fechas comparadas como texto (corregido).** Ahora se comparan como fechas.
- **Pendiente:** `consensusLine` y `BOOKS` no se usan en producción hasta medir (Task 2).
