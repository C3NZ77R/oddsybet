# Registro de picks y aprendizaje automático: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guardar cada pick de Mejores apuestas antes de su partido, cerrarlo con ESPN, mostrar el registro y aprender cada noche de lo cerrado, sin personas ni LLM.

**Architecture:** Supabase (tablas `pick_log`, `pick_model`, `pick_state`) + dos rutas POST que dispara pg_cron (`/api/picklog/tick` cada 15 min, `/api/picklog/learn` a diario) + `GET /api/record`. El ajuste aprendido es una regresión logística por deporte que `getPicks` aplica a la p del modelo; sin modelo o sin base, todo sale como hoy.

**Tech Stack:** Node ≥ 22 sin dependencias nuevas, PostgREST con `fetch`, vanilla JS en `public/`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-03-registro-picks-design.md`

## Global Constraints
- Sin dependencias npm nuevas; Supabase por REST con `fetch` (`lib/db.mjs`).
- Español (es-CO) en toda la UI y en `reason`. Escapar todo texto externo con `h`/`esc`.
- `node --test` corre en el build de Vercel **con las variables de producción puestas**: ningún test puede tocar la red ni asumir entorno vacío; todo lo externo se inyecta.
- Constantes: `FREEZE_MS` = 3 h, `FEATURED_MIN` = 0.70, `SETTLE_AFTER_MS` = 2 h, `VOID_AFTER_MS` = 3 días, `BACKFILL_DAYS` = 120, `LEARN_DAYS` = 120, `TEST_DAYS` = 14, `MIN_ROWS` (mercado o liga) = 30, `MIN_TRAIN` = 100, `MIN_TEST` = 40, `LAMBDA` = 5, `MAX_SHIFT` = 1 (logit), `FEW_N` = { soccer: 10, basketball: 10, tennis: 20 }, plazo del tick 40 s, timeout del fetch a `/api/picks` 50 s.
- "Día" = fecha de Colombia (UTC−5) de la hora de inicio.
- Secreto de las rutas POST: `TRACK_TICK_SECRET` en `x-tick-secret`, comparación en tiempo constante.

## Review Focus
1. Un partido aplazado que ESPN vuelve a poner otro día: el pick queda `nula` "ESPN no dio el resultado" a los 3 días, nunca `perdida`. → test en Task 5 (`settle: sin resultado a los 3 días → nula`).
2. `/api/record` o Supabase caídos mientras alguien abre Mejores apuestas: los picks salen igual y la tarjeta no aparece. → test en Task 7.
3. Un modelo guardado con basura (NaN, estado raro, mercado sin `b`): `parseModel` lo rechaza y los picks salen sin ajuste. → test en Task 3.
4. Doble oportunidad con una selección sobre `MAX_P`: el `side` sigue siendo el de su nombre. → test en Task 4.
5. Un tick que corre dos veces a la vez o repite un día del relleno: no duplica filas ni cambia un pick de un partido ya empezado. → tests en Task 5.

---

### Task 1: Tablas y cliente de Supabase

**Files:**
- Create: `supabase/migrations/20261103000000_picklog.sql` (tablas, índices, RLS sin políticas y la purga `oddsy-picks-purge` `40 9 * * *`, tal como el spec)
- Modify: `lib/db.mjs`
- Test: `test/db.test.mjs`

**Interfaces:**
- Produces, en `lib/db.mjs`:
  - `dbFromEnv(env = process.env) → db | null` (null si falta `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`).
  - En el objeto de `createDb`: `upsertPicks(rows)` (`pick_log?on_conflict=id`, `merge-duplicates`), `insertPicks(rows)` (`ignore-duplicates`), `dropMissing(league, gameId, keepIds)` (DELETE `pendiente` del partido con `id=not.in.(…)`), `pendingPicks(beforeIso)`, `savePicks(rows)` (PATCH por id: status, margin, score, reason, settledAt), `rowsSince({ sport?, league?, since, select, settled?, source? })` paginado de a 1 000 con `limit`/`offset` hasta una página corta, `latestModel()`, `saveModel(model)`, `getState()`, `setState(backfill)`.
  - Filas en camelCase hacia afuera (`pRaw`, `gameStart`, `espnDate`, `minOdds`), snake_case en la base (los helpers `camel`/`snake` que ya existen).

- [ ] **Step 1:** Tests en `test/db.test.mjs` con el `fake()` que ya existe: `upsertPicks` manda `prefer: resolution=merge-duplicates` y snake_case; `insertPicks` manda `ignore-duplicates`; `dropMissing('nba','401',['a','b'])` pide `league=eq.nba&game_id=eq.401&status=eq.pendiente&id=not.in.("a","b")`; `rowsSince` con 1 000 + 3 filas hace dos pedidos (`offset=0` y `offset=1000`) y devuelve 1 003; `dbFromEnv({})` → null.
- [ ] **Step 2:** `node --test test/db.test.mjs` → FAIL (funciones no existen).
- [ ] **Step 3:** Implementar en `lib/db.mjs` con el mismo `rest`.
- [ ] **Step 4:** `node --test test/db.test.mjs` → PASS.
- [ ] **Step 5:** Commit `Registro de picks: tablas y cliente de Supabase`.

### Task 2: Señales `few` y `abs` en cada partido

**Files:**
- Modify: `lib/espn.mjs` (`getSeasonResults`: `cur: true` en los resultados de las consultas de la temporada vigente), `lib/ratings.mjs` (`ratingsFromResults`: `gpNow` por equipo = partidos `cur` antes del corte), `lib/markets.mjs` (`atpElo`: `preN`; `getMarkets` y `tennisMarkets`: `x` por partido), `lib/learn.mjs` (nuevo: `fewOf`)
- Test: `test/ratings.test.mjs`, `test/markets.test.mjs`, `test/espn.test.mjs`

**Interfaces:**
- Produces: `fewOf(sport, n) → number` en `lib/learn.mjs` = `max(0, 1 − n/FEW_N[sport])`; cada item de `getMarkets(...).data` lleva `x: { few, abs }`; `atpElo()` devuelve también `preN: Map<matchId, number>`.

- [ ] **Step 1:** Tests: `ratingsFromResults` con 3 resultados `cur` y 5 sin `cur` → `gp` 8 y `gpNow` 3 para el equipo; con `asOf` antes del 2.º `cur` → `gpNow` 1. `fewOf('soccer', 0)` = 1, `fewOf('soccer', 5)` = 0.5, `fewOf('soccer', 12)` = 0, `fewOf('tennis', 10)` = 0.5. `getSeasonResults` con fixtures marca `cur` solo en lo de la consulta sin `season=`.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar. `abs = Math.min(1, Math.abs(deltas[g.id] ?? 0) / 5)`. Tenis: `few = fewOf('tennis', preN.get(m.id) ?? min(.n actuales))`.
- [ ] **Step 4:** `node --test` completo → PASS (el campo nuevo no rompe los tests de `/api/markets`).
- [ ] **Step 5:** Commit `Registro de picks: señales de pocos partidos y bajas por partido`.

### Task 3: El ajuste aprendido (`lib/learn.mjs`)

**Files:**
- Modify: `lib/learn.mjs`
- Test: `test/learn.test.mjs`

**Interfaces:**
- Produces:
  - `applyModel(model, { sport, league, market, p, x }) → number` (spec: cambio en logit limitado a ±`MAX_SHIFT`, tope `MAX_P`; sin `status: 'en_uso'` devuelve p).
  - `parseModel(raw) → model | null` (exige `sports.<deporte>.status` en `en_uso|sin_mejora|pocos_datos` y números finitos en `markets.*.a/b`, `leagues.*`, `w.few/w.abs`).
  - `fitSport(rows, { now }) → { status, n, nTest, llBase, llModel, markets, leagues, w }` con `rows = [{ league, market, pRaw, x, won: boolean, gameStart }]`.
  - `learnModel(rowsBySport, { now }) → { version: 1, at, sports }`.
  - `currentModel({ db, now } = {}) → Promise<model|null>`: memo 10 min, timeout 3 s, último bueno ante error.

- [ ] **Step 1:** Tests:
  - `applyModel(null, …)` devuelve p; con `{ a: 0, b: 0.5 }` en `dc`, p = 0.8 → σ(0.5·logit 0.8) ≈ 0.6667; con `a = 5` el cambio queda en +1 logit (0.7 → σ(logit 0.7 + 1) ≈ 0.8638); nunca supera `MAX_P`.
  - `parseModel` rechaza `{ sports: { soccer: { status: 'x' } } }`, `b: NaN` y un string; acepta el que devuelve `learnModel`.
  - `fitSport` con 2 000 filas sintéticas de `dc` donde dice 0.8 y gana el 65 % (semilla fija, 60 días, las últimas 14 de prueba) → `status 'en_uso'`, `markets.dc.b < 1`, `llModel < llBase`.
  - Filas donde `won` no depende de nada y p ≈ 0.5 → `status !== 'en_uso'` o |b − 1| < 0.2 y |a| < 0.2.
  - Filas con `x.few = 1` que pierden más → `w.few < 0`.
  - 50 filas → `pocos_datos`.
- [ ] **Step 2:** `node --test test/learn.test.mjs` → FAIL.
- [ ] **Step 3:** Implementar Newton con L2 hacia (a 0, b 1, c 0, w 0), λ = 5, ≤ 25 iteraciones o paso < 1e-8, eliminación gaussiana con pivoteo parcial; columnas solo para mercados y ligas con ≥ `MIN_ROWS` filas de entrenamiento (los demás fijos). Validación: prueba = `gameStart ≥ now − TEST_DAYS`; acepta si `llModel < llBase` en la prueba y entonces reajusta con todas.
- [ ] **Step 4:** `node --test test/learn.test.mjs` → PASS.
- [ ] **Step 5:** Commit `Registro de picks: ajuste aprendido por deporte, mercado y liga`.

### Task 4: Picks con la p ajustada

**Files:**
- Modify: `lib/markets.mjs` (`picksOf`, `getPicks`), `server.mjs` (`/api/picks` pasa `model: await currentModel()`)
- Test: `test/markets.test.mjs`

**Interfaces:**
- Consumes: `applyModel`, `currentModel` (Task 3); `x` por partido (Task 2).
- Produces: `picksOf(sport, markets, { min = 0.5, model = null, league = null, x = {} })` → picks `{ market, label, name, line, side, raw, p, fair, minOdds, record }` con `raw ≥ min`, ordenados por `p`. `getPicks(league, { date, model })` → `{ …, data: [{ gameId, x, picks }] }` con `picks[0].featured = true` si `picks[0].p ≥ FEATURED_MIN`.

- [ ] **Step 1:** Tests: sin modelo, `p === raw` y el orden de hoy se mantiene (los tests de `picksOf` existentes siguen pasando); con un modelo que encoge `dc`, la p baja y `minOdds` sale de la p nueva; `side` de "Empate o visitante" en un `dc` donde `publishable` quitó "Local o empate" es 2; `side` de "Visitante" en `1x2` es 2; `featured` solo si el primero llega a 0.70.
- [ ] **Step 2:** Correr → FAIL.
- [ ] **Step 3:** Implementar. `const DC = ['Local o empate', 'Local o visitante', 'Empate o visitante']`.
- [ ] **Step 4:** `node --test` → PASS.
- [ ] **Step 5:** Commit `Registro de picks: Mejores apuestas usa lo aprendido`.

### Task 5: Congelar, cerrar, rellenar, aprender y registro (`lib/picklog.mjs`)

**Files:**
- Create: `lib/picklog.mjs`
- Test: `test/picklog.test.mjs`

**Interfaces:**
- Consumes: db (Task 1), `getPicks` (Task 4), `learnModel` (Task 3), `getGames`, `getTennisGames`, `getToday`.
- Produces:
  - `gradePick({ sport, market, side, line }, result) → { status, margin }`; `result` = `{ home, away, name }` (goles o puntos, `name` = `status.name` de ESPN) o `{ sets, winner, retired }` (tenis). Tabla del spec.
  - `reasonOf(row, margin) → string`; `scoreOf(result) → string`.
  - `runTick(deps, { now })` y `runLearn(deps, { now })` con `deps = { db, games(league, date), picks(league, date), tennisDay(isoDate), backfillPicks(league, date) }`; devuelven un resumen `{ frozen, settled, backfilled, … }`.
  - `getRecord(db, league, { now }) → record` con la forma del spec, y `recordOf(rows, model, league, now)` (pura, para testear).
  - `picklogFromEnv(env) → { tick(), learn(), record(league) } | null`; en producción `picks` pide `https://${VERCEL_PROJECT_PRODUCTION_URL}/api/picks?league=…&date=…`; sin esa variable llama a `getPicks` con `currentModel`.

- [ ] **Step 1:** Tests de `gradePick`, uno por fila de la tabla del spec y por lado, más: `dnb` empatado → nula; `spread` justo en la línea → nula; `STATUS_POSTPONED` → nula; `STATUS_FINAL_AET` en fútbol → nula; tenis `retired` → nula; un set 7-6 cuenta 13 games.
- [ ] **Step 2:** Tests de `reasonOf`: fútbol margin −1 → "Se perdió por poco (por 1 gol)"; básquet −12 → "Resultado lejos de lo esperado"; `x.few = 0.8` agrega "inicio de temporada: pocos partidos para medir"; `x.abs = 0.5` agrega "bajas importantes".
- [ ] **Step 3:** Tests de `runTick` con db y deps falsas: un partido `pre` a 2 h se guarda con `featured`, `p`, `pRaw`, `side`, `x`, `espnDate`; uno a 4 h y uno ya empezado no; un segundo tick con otra p sobrescribe y borra el mercado que desapareció; cerrar marca ganada/perdida con `score` y `reason`; un pendiente sin resultado a los 3 días queda `nula` "ESPN no dio el resultado"; el relleno inserta `source: 'backfill'` ya calificados, avanza `{ day, league }` y para en `until`; con el plazo vencido no rellena.
- [ ] **Step 4:** Tests de `recordOf`: "ayer" con 7 ganadas y 3 perdidas → `day.yesterday`, `windows[0]` 7/10; los `backfill` nunca cuentan; `promised` = promedio de `p`; sin filas → `since: null`; `all` cuenta solo `p ≥ 0.5`.
- [ ] **Step 5:** Correr → FAIL; implementar; correr → PASS.
- [ ] **Step 6:** Commit `Registro de picks: congelar, cerrar, rellenar y aprender`.

### Task 6: Rutas

**Files:**
- Modify: `server.mjs` (`/api/record` en `ROUTES` y en `EDGE_S` con 300; rama `/api/picklog/` solo POST, `no-store`, 503 sin configurar, 401 con secreto malo)
- Create: `api/picklog/[...path].mjs`
- Test: `test/server.test.mjs`

- [ ] **Step 1:** Tests: sin variables (borrar `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRACK_TICK_SECRET` y restaurarlas, como el test del 503 del seguimiento), `POST /api/picklog/tick` → 503 `no-store`; `/api/record?league=nba` → 200 `{ data: null }`; `/api/record?league=xx` → 400; `GET /api/picklog/tick` → 405; el test de catch-alls anidados incluye `picklog`.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Commit `Registro de picks: rutas del cron y del registro`.

### Task 7: Vista

**Files:**
- Modify: `public/views/picks.js`, `public/styles.css` (solo si faltan clases para ✓/✗)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `/api/record` (Task 6); `featured`, `p` (Task 4).
- Produces: `recordHtml(record) → string` exportada; `dayText(title, rows, max = 8, record = null)`.

- [ ] **Step 1:** Tests: `recordHtml` con 7/10 ayer muestra "Ayer", "7 de 10", una ✗ con su razón y "prometía"; `recordHtml(null)` → ''; con `since` y sin día cerrado → "El registro empezó"; la vista con `/api/record` que falla sigue mostrando "Gana Millonarios" (el test existente) y no muestra la tarjeta; el pick `featured` lleva ★; un pick con p 0.45 no se muestra; `dayText` con record agrega "Ayer: 7 de 10".
- [ ] **Step 2:** FAIL → implementar (pedir `/api/record` después de lanzar los pedidos de los días, con `.catch(() => null)`) → PASS.
- [ ] **Step 3:** Commit `Registro de picks: tarjeta del registro en Mejores apuestas`.

### Task 8: Documentación y verificación con datos reales

**Files:**
- Modify: `docs/architecture.md` (sección "Registro de picks y aprendizaje")

- [ ] **Step 1:** Escribir la sección: tablas, ciclo, aprendizaje, rutas, cron y variables.
- [ ] **Step 2:** Con un script desechable en el scratchpad (no en el repo): `runTick` con una db en memoria y las deps reales en el proceso, sobre los partidos de ayer y de hoy; revisar a mano 5 calificaciones contra los marcadores de ESPN y que el relleno de un día cierra todo.
- [ ] **Step 3:** `node --test` completo → PASS. Commit `Docs: registro de picks`.

### Task 9: Producción (necesita el visto bueno del usuario)

- [ ] **Step 1:** `apply_migration` en el proyecto de Supabase (`icrmgzjhmeumvysvfync`) y `get_advisors` de seguridad sin avisos nuevos.
- [ ] **Step 2:** Merge a `main` (revisando `git diff --cached`: el índice es compartido) y push; esperar el deploy; `GET https://oddsybet.vercel.app/api/record?league=nba` → 200.
- [ ] **Step 3:** Crear `oddsy-picks-tick` (`*/15 * * * *`) y `oddsy-picks-learn` (`20 9 * * *`) con el patrón de `oddsy-track-tick`; `cron.job_run_details` en `succeeded`; filas en `pick_log`; `pick_state` avanzando; `POST …/learn` a mano una vez → fila en `pick_model`.
