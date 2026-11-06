# Registro de picks y aprendizaje automático: diseño

Fecha: 2026-11-03. Estado: **aprobado**. El usuario aprobó el enfoque en el chat y pidió que yo revisara y mejorara el plan antes de implementarlo ("sea como quede, que quede luego de tu última revisión"). Las decisiones abiertas son mías y están marcadas.

## Intención
Mejores apuestas muestra hoy lo que el modelo cree, con un "Se cumplió" sacado del backtest de la temporada pasada. Nadie puede ver si los picks que Oddsy publicó ayer salieron. El usuario quiere ese registro porque ver "7 de 10", con las ganadas y las perdidas a la vista, da confianza a quien entra y a su grupo de WhatsApp.

También quiere que el modelo aprenda solo de lo que falla, sin una persona y sin un LLM (ni Claude, ni ChatGPT, ni Gemini) encima. Si mañana nadie toca el código, Oddsy sigue guardando, cerrando y aprendiendo, y si algo de eso se cae, los picks siguen saliendo.

## Objetivos
1. Guardar cada pick de Mejores apuestas antes de que empiece su partido, tal como se mostró, sin poder cambiarlo después.
2. Cerrarlo solo con el resultado de ESPN: ganado, perdido o anulado, con el marcador y, si se perdió, por qué.
3. Mostrar en Mejores apuestas el registro de la liga: el último día ("Ayer: 7 de 10") con cada pick, y los últimos 7 y 30 días comparados con lo que Oddsy prometía.
4. Aprender cada noche de los picks cerrados y usar lo aprendido en los picks del día siguiente, solo si en las dos semanas más recientes eso hubiera acertado mejor que el modelo sin ajustes.
5. Que todo corra solo: cron de Supabase → rutas de Oddsy en Vercel, matemática en JavaScript, sin dependencias nuevas.

## No-objetivos
- Prometer un porcentaje fijo de aciertos (el 94 de 100 del chat era un ejemplo). Un modelo bien calibrado acierta lo que promete; para ganar 94 de 100 habría que mostrar solo picks del 94 % o más, que pagan ~1.05 y Oddsy ya no publica (`MAX_P`). El registro dice la verdad, sea el número que sea.
- Registrar los props de jugadores (Props) o las apuestas de Mis apuestas. Solo Mejores apuestas.
- Reajustar los parámetros internos del modelo base (σ, encogimiento, ventaja local, Elo) en línea. Esos se miden con los scripts de backtest. Los ratings de equipos ya se actualizan solos con cada resultado (calendarios de ESPN, caché de 6 h).
- Usar la cuota de la casa como señal. Se habló en el chat, pero ESPN solo la trae en algunas ligas (NBA sí, Liga BetPlay casi nunca) y pedirla por partido en cada visita a Mejores apuestas costaría un summary de ESPN por partido. Queda para después (ver al final).
- Cuentas de usuario o un registro por persona: el registro es de Oddsy, público y el mismo para todos.

## Anti-objetivos (fallaría aunque funcione)
- **Registro acomodado.** Guardar o cambiar un pick después de que empezó su partido, esconder pérdidas o anular picks perdidos. Un pick se congela antes del inicio y su resultado sale de ESPN; las anulaciones dicen por qué.
- **Aprender de la suerte.** Ajustar con 5 picks y empeorar el modelo. El ajuste necesita datos mínimos, va regularizado hacia "no cambiar nada", tiene tope y se valida en días que no vio.
- **Que Oddsy dependa del aprendizaje.** Sin Supabase, sin cron o con un modelo aprendido roto, los picks salen igual que hoy.
- **Mostrar como registro lo que nunca se publicó.** Los picks reconstruidos del pasado (relleno, ver abajo) sirven para aprender y nunca entran al registro público.

## Lo que decidió el usuario
- Registro de las predicciones de Mejores apuestas: cuántas se ganaron y cuántas se perdieron, a la vista de todos.
- Aprendizaje automático y autónomo de los errores, incluidas las situaciones raras ("estadísticas anómalas"), sin personas ni LLM.
- Aprobó el enfoque del chat: congelar antes del partido, cerrar con ESPN, aprender cada noche por deporte y mercado, señales raras, mínimo de datos y tope, validación en días aparte, y que nada deje de funcionar si el aprendizaje falla.

## Mis decisiones (marcadas como mías)
1. **Qué cuenta en el "7 de 10": el pick del partido.** Por partido, el pick con la probabilidad mostrada más alta, si llega al 70 % (`FEATURED_MIN`). Un pick por partido; el día tiene tantos como partidos con un pick fuerte. En la vista lleva una estrella. Los demás picks de la lista también se guardan y se cierran: alimentan el aprendizaje y una línea aparte del registro ("Todos los picks de la lista: 210 de 300").
2. **Validación contra el modelo sin ajustes, no contra el ajuste de ayer.** En el chat dije "mejor que el actual", pero el ajuste de ayer ya aprendió de esos mismos días y siempre parecería mejor. La prueba honesta es: aprender sin las últimas dos semanas y ver si en esas dos semanas acierta mejor que el modelo solo. Si sí, se aprende con todo y se usa; si no, se usa el modelo solo.
3. **Relleno de 120 días hacia atrás.** Sin él, el aprendizaje no arranca hasta tener ~3 semanas de datos. El cron reconstruye los picks de los últimos 120 días con los ratings de antes de cada partido (como el backtest, sin fuga) y los cierra con el resultado real. Solo para aprender (`source = 'backfill'`); nunca en el registro público. Son 120 y no 60 porque la NBA empezó el 21 de octubre: con 60, todo su básquet caería en las dos semanas de prueba y el entrenamiento solo tendría la WNBA (julio a octubre entra con 120).
4. **Lo que se guarda es lo que sirvió `/api/picks`, y la última versión antes del inicio gana.** Cada tick pide `/api/picks` al dominio de producción (la misma respuesta de la CDN que ve la gente, con los mismos parámetros en el mismo orden) para las ligas con partidos que empiezan en menos de 3 h, y sobrescribe los picks de esos partidos. Así el registro guarda lo que se mostraba ≤ 15 min antes del inicio, con las bajas ya puestas, y nunca se toca después del inicio. Cada liga y fecha es una petición aparte en paralelo, cada una con sus 60 s de Vercel, así que un arranque en frío de una liga no deja sin foto a las demás. Si ningún tick corre en esas 3 h (Vercel o Supabase caídos), ese partido queda sin registro: nunca se guarda tarde. Sin dominio de producción (local, tests), el tick calcula `getPicks` en el mismo proceso.
5. **Señales raras de la primera versión:** pocos partidos jugados en la temporada actual (inicio de temporada, equipo recién ascendido, equipos de copa) y tenista con poca historia, en los tres deportes, y el tamaño del ajuste por bajas en la NBA. Se calculan donde ya se calcula el partido, sin pedirle nada nuevo a ESPN. El aprendizaje lleva además un término por liga, para que "pocos partidos" no aprenda en realidad "es la Champions".
6. **"Ayer" es el día en hora de Colombia** (UTC−5, sin horario de verano) de la hora de inicio.
7. **El secreto de las rutas del cron es `TRACK_TICK_SECRET`**, el mismo del seguimiento (ya está en Vercel y en el Vault de Supabase). Sin variables nuevas.
8. **Prórroga en fútbol (`STATUS_FINAL_AET`, `STATUS_FINAL_PEN`) → anulado.** Los mercados son a 90 minutos y el scoreboard de ESPN solo trae el marcador final. En la caché de ESPN son 45 de ~45 000 partidos.

## Arquitectura

### Datos (Supabase, el mismo proyecto prestado de `/api/track`)
Migración `supabase/migrations/20261103000000_picklog.sql`. RLS activado sin políticas, como `track_*`: solo entra la service role key del servidor.

```sql
create table pick_log (
  id text primary key,                  -- '<liga>:<partido>:<mercado>': un pick por mercado y partido
  source text not null default 'live',  -- 'live' (se mostró) | 'backfill' (reconstruido, solo para aprender)
  league text not null,
  sport text not null,
  game_id text not null,
  espn_date text not null,              -- YYYYMMDD con el que se pidió el partido: se cierra con el mismo
  game_start timestamptz not null,
  home text, away text,                 -- nombres para mostrar (tenis: los dos jugadores)
  market text not null, label text not null, name text not null,
  side int not null,                    -- índice de la selección en su mercado (0 = Local/A/Más/Sí)
  line numeric,
  p_raw numeric not null,               -- probabilidad del modelo base
  p numeric not null,                   -- la mostrada (con lo aprendido); en backfill = p_raw
  min_odds numeric not null,
  x jsonb not null default '{}',        -- señales: { few, abs }
  featured boolean not null default false,
  status text not null default 'pendiente', -- pendiente | ganada | perdida | nula
  margin numeric, score text, reason text,
  logged_at timestamptz not null default now(),
  settled_at timestamptz
);
create index pick_log_pending on pick_log (status, game_start);
create index pick_log_league on pick_log (league, game_start);
create index pick_log_sport on pick_log (sport, game_start);

create table pick_model (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  model jsonb not null
);

create table pick_state (               -- una fila: por dónde va el relleno
  id int primary key default 1 check (id = 1),
  backfill jsonb not null default '{}'  -- { day: 'YYYYMMDD', league: índice en LEAGUES, until: 'YYYYMMDD' }
);
insert into pick_state default values;
```
Purga diaria `oddsy-picks-purge`: filas de `pick_log` y `pick_model` de más de 400 días. Volumen esperado: ~150–300 filas por día (el tenis pone la mayoría), < 100 000 al año.

Los métodos nuevos van en `lib/db.mjs` (mismo `rest` con fetch y la service key) más `dbFromEnv(env)` (null si falta `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`). Las lecturas largas paginan de a 1 000 filas (tope por defecto de PostgREST en Supabase).

### Probabilidad mostrada y señales (`lib/learn.mjs` + `lib/markets.mjs`)
- `getMarkets` agrega a cada partido `x = { few, abs }`. `few = max(0, 1 − n/FEW_N)`, con n = partidos del equipo con menos desde su último parón de temporada, o partidos en la historia Elo del tenista con menos antes de ese partido; `FEW_N` = 10 en fútbol y básquet, 20 en tenis. `abs = min(1, |ajuste por bajas| / 5)` en la NBA (`deltas[g.id]`, en puntos de margen); 0 en el resto. Es un campo nuevo de `/api/markets`, aditivo.
  - `gp` de `ratingsFromResults` no sirve para esto: cuenta también la temporada anterior que suma `getSeasonResults` (siempre en fútbol; en básquet mientras la temporada es corta). `ratingsFromResults` cuenta aparte `gpNow`: los partidos del equipo antes del corte (sin corte, antes de ahora) hasta el primer parón de 45 días o más (`SEASON_GAP`). No depende de cuándo ESPN cambia de temporada, que era el problema de marcar la temporada vigente: en el relleno, un partido de la temporada anterior habría salido con "pocos partidos" aunque fuera de fin de temporada. Las pausas de selecciones duran menos de 45 días.
  - Tenis: `atpElo()` guarda en la misma pasada `preN` (Map partido → el menor `.n` de los dos antes de jugarlo), igual que `pre`. Con el `.n` de hoy, el relleno sabría el futuro.
- `applyModel(model, sport, market, p, x)`: si el deporte no tiene estado `en_uso`, devuelve p. Si no: L = logit(p); η = a_m + b_m·L (o L si el mercado no tiene ajuste propio) + w_few·few + w_abs·abs; el cambio η − L se limita a ±1 en logit (de 70 % no pasa de 86 % ni baja de 46 %) y el resultado no supera `MAX_P`.
- `picksOf(sport, markets, { model, x })`: lo de hoy, más `raw` (p del modelo), `p` = la ajustada, `side`, `fair` y `minOdds` desde la ajustada, ordenados por la ajustada. El filtro de p ≥ 0.5 sigue siendo sobre `raw`: así el registro guarda también los picks que el ajuste dejó por debajo del 50 % y el aprendizaje no se queda solo con los que ya le gustan.
  - `side` es la posición de la selección en el mercado completo. En `dc` sale del nombre (`['Local o empate', 'Local o visitante', 'Empate o visitante']`), porque `publishable` quita las selecciones de doble oportunidad sobre `MAX_P` y corre las posiciones. Los demás mercados de pick son de dos o tres lados que suman 1 y `publishable` los deja enteros o los quita enteros, así que ahí la posición en `m.selections` sirve (en tenis es la única opción: los nombres son los de los jugadores).
- `getPicks(league, { date, model })`: `model` lo pasa el servidor (`currentModel()`); sin él no hay ajuste (los tests y el relleno). Cada partido sale con `x` y sus picks; el primero (el de mayor p) lleva `featured` si su p ajustada ≥ 0.50. Devuelve todos los picks con `raw` ≥ 0.5; la vista y `dayText` muestran solo los de p ≥ 0.5 (lo que ve la gente) y el cron guarda todos.
- `currentModel()`: la última fila de `pick_model`, en memoria 10 min. Sin variables, con error, timeout (3 s) o forma inválida (`parseModel` valida números y estados) devuelve el último bueno o null. Nunca tumba `/api/picks`.

### Ciclo cada 15 min: `POST /api/picklog/tick`
Con `x-tick-secret` igual a `TRACK_TICK_SECRET` (comparación en tiempo constante); sin variables → 503, secreto malo → 401. Corre tres pasos con un plazo común de 40 s (el de Vercel es 60 s); un paso que no alcanza sigue en el próximo tick. Todo es idempotente, así que no necesita candado.
1. **Congelar.** Para cada liga, los partidos de hoy y mañana (hora de Colombia, YYYYMMDD) de `getGames` (tenis: `getTennisGames`), en el proceso: es un scoreboard por fecha. Las ligas y fechas con algún partido en `pre` que empieza en menos de 3 h piden `/api/picks?league=…&date=…` al dominio de producción (`VERCEL_PROJECT_PRODUCTION_URL`), todas en paralelo, con timeout de 50 s. Por cada partido de esos con picks: upsert de sus filas (`on_conflict=id`, `merge-duplicates`) y borrado de las filas `pendiente` de ese partido que ya no están (un mercado cuyo pick desapareció). Nunca se toca un partido que ya empezó.
2. **Cerrar.** Filas `pendiente` con inicio de hace más de 2 h, agrupadas por liga y `espn_date`: un scoreboard por grupo (`getGames`; tenis: `getToday` de ese día y del siguiente, por si la lluvia lo corrió). Partido `post` → `gradePick`. `STATUS_POSTPONED`, `STATUS_CANCELED`, prórroga de fútbol o retiro en tenis → `nula` con su razón. Sin resultado 3 días después del inicio → `nula` "ESPN no dio el resultado". Si el scoreboard falla (403, timeout), ese grupo se salta y se reintenta: un error de ESPN nunca anula. Al congelar, cada fila vuelve a `pendiente`: si ESPN reprograma un partido aplazado con el mismo id, se califica cuando se juegue.
3. **Rellenar.** Hasta 8 pasos por tick (`BACKFILL_STEPS`) y mientras quede plazo: toma la liga y el día del cursor `pick_state.backfill` (`{ league, day, from, until, fails }`), `getPicks(liga, { date: día })` en el proceso y sin modelo, califica los partidos `post` en el momento con el scoreboard de ese día, los inserta como `backfill` (`ignore-duplicates`) y avanza el cursor. Recorre una liga entera hacia atrás (de ayer a 120 días antes del primer relleno) antes de pasar a la siguiente, para que cada tick reuse los calendarios de ESPN que ya bajó. 120 días × 8 ligas ≈ 960 pasos; a 8 por tick, ~30 horas. Un paso que falla se reintenta en el próximo tick y a la tercera falla se salta. El tope existe porque ESPN responde 403 a las ráfagas: al verificar con datos reales, dos corridas seguidas del relleno (~400 calendarios cada una) bastaron para que el tenis respondiera 403 por un rato.

### Calificar un pick (`gradePick`)
`margin` > 0 ganó por esa cantidad, < 0 perdió, 0 devolvió (→ `nula`). d = local − visita; t = local + visita. `line` es la de la selección elegida.

| Mercado | Lado 0 | Lado 1 | Lado 2 |
|---|---|---|---|
| `1x2` | d | d = 0 ? 1 : −\|d\| | −d |
| `dc` | d + 0.5 | \|d\| − 0.5 | −d + 0.5 |
| `dnb` | d (0 → nula) | −d | |
| `ou` (fútbol y básquet) | t − line | line − t | |
| `btts` | ambos marcan ? 1 : −(equipos en 0) | ambos marcan ? −min(local, visita) : 1 | |
| `ml` (básquet) | d | −d | |
| `spread` | d + line | −d + line | |
| tenis `ml` | sets de A − sets de B | al revés | |
| `first_set` | games de A − de B en el 1.er set | al revés | |
| `games_hcp` | dg + line | −dg + line | |
| `ou_sets` | sets − line | line − sets | |
| `ou_games` | games − line | line − games | |
| `ou_set1` | games del 1.er set − line | al revés | |

dg = games de A − games de B en todo el partido. Un set con tie-break cuenta 7-6. `score`: "2-1" (local-visita) o los sets del tenis ("6-4 3-6 7-6").

### Por qué se perdió (`reasonOf`)
Una frase por pick perdido, guardada en `reason`:
- Por poco si |margin| ≤ 1 en fútbol (goles), ≤ 5 en básquet (puntos), ≤ 1 en mercados de sets del tenis y ≤ 2 en los de games: "Se perdió por poco (por 1 gol)". Si no: "Resultado lejos de lo esperado".
- Más las señales que tenía: "inicio de temporada: pocos partidos para medir" (few ≥ 0.5) y "bajas importantes" (abs ≥ 0.4).

### Aprendizaje diario: `POST /api/picklog/learn`
Mismo secreto. Cron diario a las 09:20 UTC (4:20 a. m. en Colombia, con los partidos de la noche ya cerrados). Por deporte:
1. Filas `ganada` o `perdida` de los últimos 120 días (`live` y `backfill`), con `league`, `p_raw`, `x`, `market` y `game_start`.
2. Prueba = las de los últimos 14 días; entrenamiento = las anteriores. Con menos de 100 de entrenamiento o 40 de prueba → `pocos_datos` (sin ajuste).
3. Ajuste: regresión logística con L2 hacia "no cambiar nada" (a = 0, b = 1, c = 0, w = 0; λ = 5), por Newton (≤ 25 iteraciones, sistema lineal chico por eliminación gaussiana). η = a_m + b_m·logit(p_raw) + c_liga + w_few·few + w_abs·abs. Un `a, b` por mercado y un `c` por liga con ≥ 30 filas de entrenamiento; los demás quedan fijos en (0, 1) y 0. `w_few` y `w_abs` comunes al deporte.
4. Si el log-loss del ajuste en la prueba es menor que el del modelo solo → `en_uso`: se vuelve a ajustar con todas las filas y eso se publica. Si no → `sin_mejora` (sin ajuste).
5. Se guarda una fila en `pick_model` siempre, con cada deporte `{ status, n, nTest, llBase, llModel, markets: { m: { a, b, n } }, leagues: { liga: c }, w: { few, abs } }`, para que se vea en el registro y quede la historia. `applyModel` suma `c` de la liga del partido (0 si no tiene).

Como los picks son siempre el lado más probable, una señal con peso negativo baja su probabilidad hacia el 50 %: así "tener más cuidado" se vuelve número. Un mercado que falla más de lo que promete queda con p más baja, sale menos como pick del partido y, si cae bajo el 50 %, deja de mostrarse.

### Registro público: `GET /api/record?league=<id>`
Ruta normal de `ROUTES` (GET, caché de borde 300 s). Sin variables → `{ source: 'oddsy', data: null }`. Lee las filas `live` de la liga de los últimos 31 días y el último `pick_model`:
```
{ since: 'YYYY-MM-DD' | null,                    // primer día con picks en vivo de la liga
  day: { date, yesterday: bool, picks: [{ home, away, market, label, name, line, p, status, score, reason }] } | null,
  windows: [{ days: 7, won, lost, voided, promised, hit }, { days: 30, … }],   // solo picks del partido
  all: { days: 30, won, lost, promised, hit },     // todos los mostrados (p ≥ 0.5)
  markets: [{ market, n, promised, hit }],         // 30 días, todos los mostrados
  model: { at, status, n, nTest, llBase, llModel } | null }   // del deporte de la liga
```
`day` = el último día (de los 7 previos) con algún pick del partido cerrado; `yesterday` dice si es ayer. Los pendientes de ese día van en la lista sin contar. `promised` = promedio de la p mostrada; `hit` = ganadas / (ganadas + perdidas).

### Vista (`public/views/picks.js`)
- Arriba, una tarjeta "Registro de Oddsy": "Ayer · 7 de 10" (o la fecha), la lista con ✓/✗/anulado, el marcador y la razón de cada perdida; "Últimos 7 días: 31 de 40 (78 %) · prometía 76 %" y lo mismo a 30 días; "Todos los picks de la lista: …". Un `<details>` "Cómo aprende Oddsy" con la tabla por mercado (prometía / salió) y el estado del último aprendizaje en palabras ("En uso desde hoy 4:20 a. m.: en las últimas 2 semanas acertó mejor que el modelo solo").
- Sin datos todavía: "El registro empezó el 3 nov. El primer resultado sale cuando termine el primer partido con pick." `data: null` o error → no se muestra la tarjeta; los picks salen igual.
- En cada partido, el pick del partido con ★ y una leyenda: "★ Pick del partido: es el que cuenta en el registro".
- `dayText` (WhatsApp) toma los picks del partido y, si hay registro, agrega "Ayer: 7 de 10 · últimos 30 días: 78 %".

### Rutas y despliegue
- `server.mjs`: `/api/record` en `ROUTES`; `/api/picklog/*` aparte, como `/api/track/*` (solo POST, `no-store`).
- `api/picklog/[...path].mjs`: el catch-all de la raíz no atrapa rutas anidadas.
- Cron en Supabase (se crean a mano, como el del seguimiento, porque llevan la URL y el Vault): `oddsy-picks-tick` `*/15 * * * *` y `oddsy-picks-learn` `20 9 * * *`, con `net.http_post` a `https://oddsybet.vercel.app/api/picklog/{tick,learn}`, el secreto de `vault.decrypted_secrets` (`track_tick_secret`) y `timeout_milliseconds := 55000`.

## Pruebas y verificación
- `test/picklog.test.mjs` (sin red, dependencias inyectadas): `gradePick` por cada mercado y lado (incluidas devoluciones), `reasonOf`, congelar (ventana de 3 h, ignora los ya empezados, sobrescribe hasta el inicio y borra los picks que desaparecieron, guarda `featured`), cerrar (aplazado, prórroga, retiro, sin resultado a los 3 días), rellenar (avanza el cursor, se detiene en `until`, respeta el plazo) y el agregado del registro.
- `test/learn.test.mjs`: datos sintéticos de un modelo sobreconfiado (dice 80 %, sale 65 %) → b < 1, `en_uso` y el log-loss baja en la prueba; resultados al azar → `sin_mejora` o un ajuste casi nulo; señal `few` que de verdad predice pérdidas → `w_few < 0`; tope de ±1 en logit, `MAX_P` y `parseModel` con basura.
- `test/db.test.mjs`: los métodos nuevos (ignore-duplicates, paginación, upsert del cierre).
- `test/server.test.mjs`: `/api/picklog/tick` sin variables → 503, con secreto malo → 401; `/api/record` sin variables → `data: null`.
- `test/ui.test.mjs`: la tarjeta del registro y la ★, y que un error de `/api/record` no tumba los picks.
- Verificación con datos reales antes de desplegar: correr congelar + cerrar contra ESPN de verdad con una base falsa en memoria sobre los partidos de ayer y de hoy, y comparar a mano varios marcadores con su calificación.
- Después de desplegar: `cron.job_run_details` en 200, filas nuevas en `pick_log`, el relleno avanzando en `pick_state`, el primer `pick_model` a la mañana siguiente y la tarjeta en `oddsybet.vercel.app`.

## Límites conocidos
- Si el cron no corre en las 3 h previas a un partido, ese partido no entra al registro.
- Prórroga en fútbol y retiro en tenis se anulan aunque una casa los pague de otra forma.
- El relleno no tiene el ajuste por bajas de la NBA del pasado (el reporte de lesiones es solo el de hoy): `abs` = 0 en esas filas. Y en tenis, el largo del set (`setLength`, que mueve `ou_set1`) es el ajuste de hoy: una fuga chica, solo en las filas de relleno de ese mercado.
- `/api/picks` vive hasta 30 min en la CDN (más `stale-while-revalidate`): lo que se congela es lo que la CDN servía en ese momento, que puede tener hasta ~30 min respecto de lo que el modelo diría al instante. Es lo que la gente veía, que es lo que el registro promete.
- La base sigue en el proyecto de Supabase prestado (ver memoria `seguimiento-infra`).

## Después
- La cuota de la casa como señal en la NBA (summary de ESPN en la foto de las 3 h, no en cada visita).
- Un aviso visible en los picks con señales raras ("pocos partidos").
- Registrar los props de la NBA con el mismo ciclo.
