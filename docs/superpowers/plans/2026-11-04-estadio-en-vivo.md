# Estadio en vivo: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** una vista por partido (`#/<liga>/live/<id>`) con la cancha de fútbol o de básquet en perspectiva 3D, donde el balón viaja a cada jugada real que publica ESPN, los tiros dibujan su trayectoria, los goles se celebran y se puede rebobinar el partido entero.

**Arquitectura:** el servidor lee el summary de ESPN que ya usa la vista En vivo, lo reduce a una lista compacta de jugadas con posición absoluta en la cancha (`lib/plays.mjs`) y la sirve en `/api/plays` con 10 s de caché en la CDN. El navegador pregunta cada 10 s mientras la pestaña está visible, calcula presión, calor y rachas con funciones puras (`public/estadio.js`) y anima todo con CSS 3D (`public/views/stadium.js`).

**Tecnología:** Node ≥ 22, JavaScript sin build en `public/`, `node --test`, CSS 3D y Web Animations API. Cero dependencias nuevas.

**Especificación:** este plan. El usuario pidió el plan directo después de revisar qué datos trae ESPN; las decisiones de diseño están abajo.

## Qué trae ESPN (medido el 2026-11-04)

- **Fútbol** (`summary.commentary[].play`, Premier, Champions y Liga BetPlay): ~115 jugadas por partido, 75 a 80 % con `fieldPositionX/Y` (0 a 100). La posición está en el marco del equipo que hace la jugada, atacando hacia x = 100: los córners y remates de los dos equipos caen cerca de 100. Los remates traen además destino (`fieldPosition2X/Y`) y `goalPositionY`. `play.team` en commentary solo trae `displayName`, sin id. Llega más o menos una jugada por minuto. Partido de prueba: Newcastle 0-1 Everton, `eng.1`, evento `401878762`.
- **NBA** (`summary.plays`): ~490 jugadas. `coordinate` en pies de media cancha (x 0 a 50 a lo ancho, y 0 a 47 desde la línea de fondo); los tiros libres y otras jugadas traen el centinela `-214748340`. `shootingPlay`, `scoringPlay`, `scoreValue`, `pointsAttempted`, `awayScore/homeScore` y `winprobability[]` por `playId`. Partido de prueba: Heat 117-138 Lakers, evento `401909921`.
- **Tenis**: solo marcador por sets, sin summary (400). Queda fuera.
- ESPN publica cada jugada con unos 6 minutos de atraso (ya lo dice la vista En vivo).

## Decisiones de diseño (criterio mío; el usuario puede cambiarlas)

1. **Sondeo en vez de Supabase Realtime.** El atraso lo pone ESPN (~6 min), no el transporte. Un canal push no adelanta nada visible y sumaría un cron y carga a la base prestada de vivir-mejor. `/api/plays` con `s-maxage=10` hace que ESPN reciba como mucho una petición cada 10 s por partido, sin importar cuánta gente mire.
2. **CSS 3D, no WebGL.** Una cancha SVG inclinada con `perspective` y `rotateX`, y el balón como elemento con sombra, se ven en 3D, corren en cualquier celular y no agregan dependencias.
3. **Repetición honesta.** El balón solo va a posiciones que ESPN publicó. Entre jugadas no se inventa movimiento: el balón espera en la última posición. La vista dice que es una repetición con atraso.
4. **Fútbol:** el local ataca hacia la derecha. **NBA:** el local ataca la canasta derecha todo el partido (no se cambia de lado en el medio tiempo).

## Restricciones globales

- Cero dependencias nuevas; `public/` sin build; todo el texto visible en español.
- Solo fútbol y básquet usan esta vista. El tenis no tiene la vista En vivo (`viewsOf` en `public/app.js`) y así sigue.
- Ninguna posición inventada: una jugada sin coordenadas válidas no mueve el balón ni se dibuja en la cancha.
- `prefers-reduced-motion: reduce` desactiva vuelos, arcos y confeti: el balón salta a su sitio.
- La vista deja de pedir datos cuando la pestaña está oculta y al desmontarse (la función que devuelve `render` limpia intervalos y animaciones).
- Árbol compartido: `server.mjs` y `public/app.js` tienen cambios sin commit de otra sesión. Haz `git add` solo de tus archivos y revisa `git diff --cached` antes de cada commit; si tu cambio y el ajeno caen en el mismo archivo, pregunta antes de commitear. No hagas push sin permiso: push a `main` despliega en Vercel.

## Foco de revisión

1. Partido recién empezado o sin jugadas con posición: la vista muestra la cancha vacía y el aviso, sin errores ni `NaN` en estilos (test en la Tarea 1 y verificación en la Tarea 4).
2. Jugadas sin equipo (saque inicial, medio tiempo, pausas, VAR): `side` es `null`, no se dibujan y el balón no se mueve (test en la Tarea 1).
3. Coordenadas centinela de la NBA y tiros libres: `x` e `y` quedan en `null` (test en la Tarea 1).
4. Autogol: ESPN pone en `team` al equipo del jugador que lo hizo; el gol cuenta para el rival (test en la Tarea 1).
5. ESPN caído o partido inexistente: la vista muestra `errorBox` y sigue intentando cada 10 s; `/api/plays` devuelve 404 si el summary no existe (test en la Tarea 2).

---

### Tarea 1: Normalizar las jugadas de ESPN

**Archivos:**
- Crear: `lib/plays.mjs`
- Crear: `test/fixtures/plays-epl.json`, `test/fixtures/plays-nba.json`
- Test: `test/plays.test.mjs`

**Interfaces:**
- Produce: `normPlays(json, sport: 'soccer'|'basketball') → Play[]`, ordenado por `seq` ascendente.
- `Play = { id: string, seq: number, t: number|null, at: string|null, period: number|null, clock: string|null, kind: string, label: string, text: string|null, who: string|null, side: 'home'|'away'|null, x: number|null, y: number|null, tx: number|null, ty: number|null, made: boolean|null, pts: number, zone: 'paint'|'mid'|'corner3'|'arc3'|null, score: [number, number]|null, wp: number|null }`
  - `x`, `y`, `tx`, `ty`: posición absoluta 0 a 100 (x a lo largo, y a lo ancho). `t`: segundos de partido jugados. `at`: `wallclock` ISO. `label`: texto en español de `KIND_ES`. `who`: primer participante. `score`: `[visitante, local]`. `wp`: probabilidad de ganar del local tras la jugada.
- Produce: `KIND_ES: Record<string, string>` exportado (lo usa la vista).

- [ ] **Paso 1: Crear los fixtures recortados**

```bash
node -e "
const S='https://site.api.espn.com/apis/site/v2/sports', fs=require('fs');
const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));
(async()=>{
  const e=await (await fetch(S+'/soccer/eng.1/summary?event=401878762')).json();
  fs.writeFileSync('test/fixtures/plays-epl.json',JSON.stringify({header:e.header,commentary:e.commentary}));
  const n=await (await fetch(S+'/basketball/nba/summary?event=401909921')).json();
  const K=['id','sequenceNumber','type','text','period','clock','team','participants','wallclock','shootingPlay','scoringPlay','scoreValue','pointsAttempted','coordinate','awayScore','homeScore'];
  fs.writeFileSync('test/fixtures/plays-nba.json',JSON.stringify({header:n.header,plays:n.plays.map(p=>pick(p,K)),winprobability:n.winprobability.map(w=>pick(w,['playId','homeWinPercentage']))}));
})()"
ls -la test/fixtures/plays-*.json
```

Esperado: dos archivos, cada uno de menos de 300 KB.

- [ ] **Paso 2: Escribir los tests que fallan**

```js
// test/plays.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normPlays } from '../lib/plays.mjs';
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));

test('normPlays fútbol: jugadas del commentary con posición absoluta', () => {
  const plays = normPlays(fixture('plays-epl.json'), 'soccer');
  assert.equal(plays.length, 115); // las 4 entradas sin play se descartan
  assert.equal(plays.filter((p) => p.x != null).length, 88);
  const goal = plays.find((p) => p.kind === 'goal');
  assert.equal(goal.side, 'away'); // Everton
  assert.equal(goal.label, 'Gol');
  assert.equal(goal.t, 2903);
  assert.equal(goal.seq, 57);
  assert.ok(Math.abs(goal.x - 1.2) < 1e-9 && Math.abs(goal.y - 50.4) < 1e-9); // el visitante ataca hacia x = 0
  assert.equal(goal.who, 'Thierno Barry');
  assert.ok(plays.every((p, i) => i === 0 || p.seq > plays[i - 1].seq));
});

test('normPlays fútbol: jugadas sin equipo no tienen lado ni posición', () => {
  const kick = normPlays(fixture('plays-epl.json'), 'soccer').find((p) => p.label === 'Saque inicial');
  assert.equal(kick.side, null);
  assert.equal(kick.x, null);
});

test('normPlays fútbol: un autogol cuenta para el rival', () => {
  const json = fixture('plays-epl.json');
  const og = { sequence: 999, time: { value: 600 }, play: { id: 'og1', type: { text: 'Own Goal' }, clock: { value: 600, displayValue: "10'" }, period: { number: 1 }, team: { displayName: 'Newcastle United' }, fieldPositionX: 5, fieldPositionY: 50 } };
  const p = normPlays({ ...json, commentary: [og] }, 'soccer')[0];
  assert.equal(p.kind, 'goal');
  assert.equal(p.side, 'away');
});

test('normPlays NBA: tiros con zona, marcador y probabilidad de ganar', () => {
  const plays = normPlays(fixture('plays-nba.json'), 'basketball');
  const shots = plays.filter((p) => p.kind === 'shot');
  assert.equal(shots.length, 165);
  assert.equal(shots.filter((p) => p.made).length, 89);
  assert.equal(shots.filter((p) => p.zone === 'corner3' || p.zone === 'arc3').length, 85);
  const s = plays.find((p) => p.id === '40190992126'); // triple del Heat (visitante) en (38, 25)
  assert.deepEqual([s.side, s.made, s.pts, s.zone, s.wp], ['away', true, 3, 'arc3', 0.489]);
  assert.deepEqual(s.score, [4, 0]);
  assert.equal(s.t, 91); // 12:00 − 10:29
  assert.deepEqual(plays.at(-1).score, [117, 138]);
});

test('normPlays NBA: tiros libres y centinelas sin posición', () => {
  const plays = normPlays(fixture('plays-nba.json'), 'basketball');
  const ft = plays.filter((p) => p.kind === 'ft');
  assert.equal(ft.length, 59);
  assert.ok(ft.every((p) => p.x == null && p.y == null));
  assert.ok(plays.every((p) => p.x == null || (p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100)));
});

test('normPlays: summary sin jugadas da lista vacía', () => {
  assert.deepEqual(normPlays({ header: fixture('plays-nba.json').header }, 'basketball'), []);
  assert.deepEqual(normPlays(null, 'soccer'), []);
});
```

- [ ] **Paso 3: Verificar que fallan**

Ejecuta: `node --test test/plays.test.mjs`
Esperado: FAIL, `Cannot find module '../lib/plays.mjs'`.

- [ ] **Paso 4: Implementar `normPlays(json, sport)` y `KIND_ES` en `lib/plays.mjs`**

- Lados: `header.competitions[0].competitors`, emparejando `play.team.id` con `competitor.id` o `play.team.displayName` con `competitor.team.displayName`.
- Fútbol: fuente `json.commentary[]` con `play`; `seq = sequence`; `t = play.clock.value`. Tipo por `play.type.text`, en este orden (el primero que coincide gana):

| Regex sobre `type.text` | `kind` | `KIND_ES[kind]` |
|---|---|---|
| `/Own Goal/` | `goal` (lado invertido) | Gol |
| `/^Goal\|Penalty - Scored/` | `goal` | Gol |
| `/Penalty - (Saved\|Missed)/` | `pen-miss` | Penal fallado |
| `/Shot On Target/` | `shot-on` | Remate al arco |
| `/Shot Off Target/` | `shot-off` | Remate desviado |
| `/Shot Blocked/` | `blocked` | Remate bloqueado |
| `/Woodwork/` | `post` | Al palo |
| `/Corner/` | `corner` | Córner |
| `/Foul/` | `foul` | Falta |
| `/Offside/` | `offside` | Fuera de lugar |
| `/Yellow/` | `yellow` | Amarilla |
| `/Red Card/` | `red` | Roja |
| `/Substitution/` | `sub` | Cambio |
| `/Kickoff/` | `kickoff` | Saque inicial |
| otro | `other` | (`type.text` tal cual) |

- Fútbol, posición: con `fieldPositionX/Y` y lado conocido, local `(x, y)`, visitante `(100 − x, 100 − y)`. Igual para `fieldPosition2X/Y → tx, ty`. Sin lado, todo `null`.
- NBA: fuente `json.plays`; `seq = Number(sequenceNumber)`; `kind`: `ft` si `shootingPlay` y `/Free Throw/`, `shot` si `shootingPlay`, luego `reb` (`/Rebound/`), `tov` (`/Turnover/`), `foul` (`/Foul/`), `sub`, `timeout`, `other`. `KIND_ES`: Tiro, Tiro libre, Rebote, Pérdida, Falta, Cambio, Tiempo muerto.
- NBA, posición válida solo si `0 ≤ coordinate.x ≤ 50` y `0 ≤ coordinate.y ≤ 47`. Absoluta: local `x = 100 − y·100/94`, `y = x·2`; visitante `x = y·100/94`, `y = 100 − x·2`.
- NBA, zona (solo `kind === 'shot'`, con las coordenadas de media cancha): `pointsAttempted === 3` → `corner3` si `y ≤ 14`, si no `arc3`; con 2 puntos → `paint` si `|x − 25| ≤ 8` y `y ≤ 19`, si no `mid`.
- NBA: `made = scoringPlay`, `pts = scoreValue`, `score = [awayScore, homeScore]`, `wp` desde `winprobability` por `playId`. `t`: con `clockSecs` de `public/live.js`, periodos 1 a 4 de 720 s y prórrogas de 300 s.
- `text` recortado a 200 caracteres, `who = participants[0].athlete.displayName`.

- [ ] **Paso 5: Verificar que pasan**

Ejecuta: `node --test test/plays.test.mjs`
Esperado: PASS, 6 tests.

- [ ] **Paso 6: Commit**

```bash
git add lib/plays.mjs test/plays.test.mjs test/fixtures/plays-epl.json test/fixtures/plays-nba.json
git diff --cached --stat
git commit -m "Estadio en vivo: jugadas de ESPN con posición absoluta"
```

### Tarea 2: `/api/plays`

**Archivos:**
- Modificar: `lib/espn.mjs` (sección fetch wrappers, junto a `getLive`)
- Modificar: `server.mjs` (`ROUTES` y `EDGE_S`)
- Test: `test/server.test.mjs`

**Interfaces:**
- Consume: `normPlays` de la Tarea 1; `summaryOf` y `normLive` de `lib/espn.mjs`.
- Produce: `getPlays(league, id) → { game: LiveGame sin players, plays: Play[] }`; `GET /api/plays?league=<id>&id=<evento>` → `{ source: 'espn', data: { game, plays } }` con `cache-control` `s-maxage=10`.

- [ ] **Paso 1: Escribir el test que falla**

En `test/server.test.mjs`, con `globalThis.fetch` simulado que devuelve `plays-epl.json` para `/summary` (mismo patrón que `withNba`):

```js
test('server: /api/plays trae el partido y sus jugadas con 10 s de CDN', async () => {
  // fetch simulado → fixture('plays-epl.json') para .../soccer/eng.1/summary?event=401878762
  const { status, body, headers } = await call('/api/plays?league=epl&id=401878762');
  assert.equal(status, 200);
  assert.equal(body.source, 'espn');
  assert.equal(body.data.plays.length, 115);
  assert.equal(body.data.game.home.abbr, 'NEW');
  assert.equal(body.data.game.players, undefined);
  assert.match(headers['cache-control'], /s-maxage=10/);
});

test('server: /api/plays valida liga e id, y rechaza tenis', async () => {
  assert.equal((await call('/api/plays?league=epl')).status, 400);
  assert.equal((await call('/api/plays?league=epl&id=abc')).status, 400);
  assert.equal((await call('/api/plays?league=atp&id=1')).status, 400);
});
```

Agrega también el caso 404: con fetch simulado que devuelve `{}` para el summary, `call('/api/plays?league=epl&id=1')` da 404.

- [ ] **Paso 2: Verificar que falla**

Ejecuta: `node --test test/server.test.mjs`
Esperado: FAIL con 404 en `/api/plays` (la ruta no existe).

- [ ] **Paso 3: Implementar**

`getPlays(league, id)` en `lib/espn.mjs`: `L(league)`, `summaryOf(lg, id)`, `const { players, ...game } = normLive(json, lg.id)`, `plays: normPlays(json, lg.sport)`. Ruta en `server.mjs`: `'/api/plays': async (url) => ({ source: 'espn', data: await espn.getPlays(teamLeague(url), param(url, 'id', RX.id, true)) })` y `'/api/plays': 10` en `EDGE_S`. `teamLeague` ya responde 400 al tenis.

- [ ] **Paso 4: Verificar que pasan**

Ejecuta: `node --test`
Esperado: todos los tests en PASS.

- [ ] **Paso 5: Commit** solo de tus hunks en `lib/espn.mjs`, `server.mjs` y `test/server.test.mjs` (ver Restricciones globales).

### Tarea 3: Presión, calor, rachas y zonas de tiro

**Archivos:**
- Crear: `public/estadio.js` (funciones puras, sin DOM)
- Test: `test/estadio.test.mjs`

**Interfaces:**
- Consume: `Play` de la Tarea 1.
- Produce:
  - `danger(play) → number` (fútbol)
  - `momentum(plays, bucket = 300) → Array<{ t0: number, home: number, away: number }>` (fútbol; al menos 18 tramos de 5 min)
  - `runs(plays, min = 8) → Array<{ side, pts, fromSeq, toSeq }>` (NBA, puntos sin respuesta)
  - `heat(plays, side, cols = 12, rows = 8) → number[][]` (filas × columnas, 0 a 1)
  - `shotZones(plays, side) → { paint, mid, corner3, arc3 }`, cada una `{ made, att }`
  - `newPlays(seen: Set<string>, plays, max = 12) → Play[]` (las que no están en `seen`, en orden, solo las últimas `max`)

- [ ] **Paso 1: Escribir los tests que fallan**

```js
// test/estadio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../public/estadio.js';
const P = (o) => ({ id: String(o.seq ?? 1), seq: 1, t: 0, kind: 'other', side: 'home', x: null, y: null, pts: 0, made: null, zone: null, ...o });

test('danger: pesa el tipo y la cercanía al arco rival', () => {
  assert.equal(T.danger(P({ kind: 'goal', x: 90 })), 5 * 1.4);
  assert.equal(T.danger(P({ kind: 'shot-on', side: 'away', x: 10 })), 3 * 1.4); // el visitante ataca hacia 0
  assert.equal(T.danger(P({ kind: 'foul', x: 50 })), 0); // falta lejos del área
  assert.equal(T.danger(P({ kind: 'foul', x: 70 })), 1 * 1.2);
  assert.equal(T.danger(P({ kind: 'corner' })), 1.5); // sin posición: factor 1
  assert.equal(T.danger(P({ kind: 'sub' })), 0);
});

test('momentum: tramos de 5 min con la presión de cada lado', () => {
  const m = T.momentum([P({ seq: 1, t: 100, kind: 'corner' }), P({ seq: 2, t: 400, kind: 'corner', side: 'away' })]);
  assert.equal(m.length, 18);
  assert.deepEqual(m[0], { t0: 0, home: 1.5, away: 0 });
  assert.deepEqual(m[1], { t0: 300, home: 0, away: 1.5 });
});

test('runs: rachas de 8 o más puntos sin respuesta', () => {
  const s = (seq, side, pts) => P({ seq, side, pts, made: true, kind: 'shot' });
  const r = T.runs([s(1, 'home', 2), s(2, 'away', 3), s(3, 'away', 3), s(4, 'away', 2), s(5, 'home', 2)]);
  assert.deepEqual(r, [{ side: 'away', pts: 8, fromSeq: 2, toSeq: 4 }]);
  assert.deepEqual(T.runs([s(1, 'home', 3), s(2, 'home', 3), s(3, 'home', 2)]), [{ side: 'home', pts: 8, fromSeq: 1, toSeq: 3 }]); // racha abierta
});

test('heat: densidad normalizada por lado', () => {
  const g = T.heat([P({ x: 1, y: 1 }), P({ x: 1, y: 1 }), P({ x: 99, y: 99 }), P({ side: 'away', x: 50, y: 50 })], 'home');
  assert.equal(g.length, 8);
  assert.equal(g[0].length, 12);
  assert.equal(g[0][0], 1);
  assert.equal(g[7][11], 0.5);
});

test('shotZones y newPlays', () => {
  const z = T.shotZones([P({ kind: 'shot', zone: 'paint', made: true }), P({ kind: 'shot', zone: 'paint', made: false }), P({ kind: 'shot', zone: 'arc3', side: 'away', made: true })], 'home');
  assert.deepEqual(z.paint, { made: 1, att: 2 });
  assert.deepEqual(z.arc3, { made: 0, att: 0 });
  const plays = [1, 2, 3, 4].map((seq) => P({ seq, id: `p${seq}` }));
  assert.deepEqual(T.newPlays(new Set(['p1']), plays, 2).map((p) => p.id), ['p3', 'p4']);
});
```

- [ ] **Paso 2: Verificar que fallan**

Ejecuta: `node --test test/estadio.test.mjs`
Esperado: FAIL, módulo inexistente.

- [ ] **Paso 3: Implementar en `public/estadio.js`**

`danger`: peso por tipo `{ goal: 5, 'shot-on': 3, post: 3, 'pen-miss': 3, 'shot-off': 2, blocked: 2, corner: 1.5, offside: 0.5 }`; `foul` vale 1 solo si `ax ≥ 66`, si no 0; resto 0. Con posición, multiplica por `0.5 + ax / 100`, donde `ax` es la x en el marco del que ataca (`side === 'home' ? x : 100 − x`). Sin posición, factor 1. `runs`: recorre las jugadas con `pts > 0` en orden y acumula mientras anota el mismo lado; al cambiar de lado (o al final) guarda la racha si llega a `min`. `heat`: celda `col = min(cols − 1, floor(x / 100 · cols))`, igual para filas con `y`; divide por el máximo (todo 0 si no hay jugadas).

- [ ] **Paso 4: Verificar que pasan**

Ejecuta: `node --test test/estadio.test.mjs`
Esperado: PASS, 5 tests.

- [ ] **Paso 5: Commit**

```bash
git add public/estadio.js test/estadio.test.mjs
git commit -m "Estadio en vivo: presión, calor, rachas y zonas de tiro"
```

### Tarea 4: La vista con la cancha 3D

**Archivos:**
- Crear: `public/views/stadium.js`, `public/css/stadium.css`
- Modificar: `public/app.js` (`DETAIL_VIEWS`), `public/views/live.js` (botón y delegación), `public/index.html` (link al CSS)

**Interfaces:**
- Consume: `/api/plays` (Tarea 2; cada jugada ya trae su `label` en español), y `h`, `teamLogo`, `errorBox`, `empty` de `public/ui.js`.
- Produce: `export default async function stadium(el, ctx) → () => void` en `public/views/stadium.js`.

- [ ] **Paso 1: Enrutar.** `DETAIL_VIEWS = ['props', 'games', 'live']`. En `public/views/live.js`, al inicio de `render`: si `ctx.params.id`, `return (await import('./stadium.js')).default(el, ctx)`. En `gameCard`, agrega `<a class="btn" href="#/${lg}/live/${g.id}">Ver estadio</a>` en el encabezado (necesita el id de la liga: pásalo a `gameCard`).
- [ ] **Paso 2: Escenario estático.** `stadium.js` pinta: encabezado con equipos (color de `game.home.color` y `game.away.color`, gris si es `null`), marcador y estado; el aviso fijo «ESPN publica cada jugada con unos minutos de atraso: esto es una repetición de lo que ya pasó, no la transmisión.»; el escenario `.st-stage` (`perspective: 900px`) con `.st-field` inclinado (`rotateX(52deg)`), que contiene un SVG de cancha (fútbol 105 × 68 con áreas, círculo y arcos; NBA 94 × 50 con pintura, línea de triples y aros); y el balón `.st-ball` con su sombra, ubicado con `left/top` en % sobre la última jugada con posición. Sin jugadas con posición: cancha vacía y «Todavía no hay jugadas con posición. En cuanto ESPN publique la primera, aparece aquí.». Debajo, la lista de las últimas 8 jugadas (minuto o reloj, `label`, `who`).
- [ ] **Paso 3: Datos.** `api.get('/api/plays', { league, id }, { fresh: true })` al montar y cada 10 s con `document.hidden === false`; si el partido terminó (`game.status.state === 'post'`), no vuelve a pedir. Error: `errorBox` encima de la cancha y sigue intentando. La función devuelta limpia el intervalo.
- [ ] **Paso 4: Verificar en el navegador.** Arranca el servidor de `.claude/launch.json` con `preview_start` (sirve el checkout principal) y abre `#/epl/live/401878762` y `#/nba/live/401909921`. Esperado: cancha inclinada, balón en la última jugada (gol de Everton cerca del arco izquierdo en el primero), lista de jugadas, consola sin errores. Repite a 375 px de ancho y en modo oscuro.
- [ ] **Paso 5: Commit** de `public/views/stadium.js`, `public/css/stadium.css`, `public/index.html` y tus hunks de `public/app.js` y `public/views/live.js`.

### Tarea 5: Animación y rebobinar

**Archivos:**
- Modificar: `public/views/stadium.js`, `public/css/stadium.css`

**Interfaces:**
- Consume: `newPlays` (Tarea 3).

- [ ] **Paso 1: Cola de repetición.** Al llegar datos, `newPlays(seen, plays)` encola lo nuevo (en la primera carga, solo las últimas 5). Cada 1,4 s sale una jugada: el balón vuela a su `(x, y)` con `element.animate` (700 ms, arco con `translateZ` de 0 a 40 px y vuelta a 0), aparece un anillo del color del equipo en el punto y una tarjeta con `label`, `who` y minuto. Jugada sin posición: solo la tarjeta.
- [ ] **Paso 2: Remates y goles.** Si la jugada trae `tx, ty`, dibuja la trayectoria como trazo SVG que se va dibujando (`stroke-dashoffset`), verde si fue gol, blanco al arco, gris desviado o bloqueado. Gol: destello en el arco, confeti de 30 partículas en el color del equipo (CSS, 1,2 s) y el marcador del encabezado cambia con un giro.
- [ ] **Paso 3: Rebobinar.** Un `<input type="range">` con la etiqueta «Rebobinar» recorre las jugadas; al moverlo, la cola se detiene y el balón salta a la jugada elegida. El botón «Volver al vivo» vacía la cola y vuelve a la última.
- [ ] **Paso 4: Movimiento reducido.** Con `matchMedia('(prefers-reduced-motion: reduce)')`, sin vuelos, trazos animados ni confeti: el balón salta y la tarjeta cambia.
- [ ] **Paso 5: Verificar en el navegador.** En `#/epl/live/401878762`: arrastra «Rebobinar» hasta el minuto 49 y luego suelta en la jugada anterior al gol; «Volver al vivo» debe reproducir el gol con trayectoria y confeti azul de Everton. Emula `prefers-reduced-motion` y comprueba que no hay animaciones. Sin errores en consola.
- [ ] **Paso 6: Commit.**

### Tarea 6: Capas de presión, calor y tiros

**Archivos:**
- Modificar: `public/views/stadium.js`, `public/css/stadium.css`

**Interfaces:**
- Consume: `momentum`, `runs`, `heat`, `shotZones` (Tarea 3).

- [ ] **Paso 1: Fútbol, «Quién presiona».** Debajo de la cancha, barras SVG por tramo de 5 min (`momentum`), las del local hacia arriba y las del visitante hacia abajo, en su color; una marca en el tramo actual.
- [ ] **Paso 2: NBA, probabilidad y rachas.** Línea SVG de `wp` por jugada con el título «Probabilidad de ganar (ESPN)» y etiquetas de las rachas de `runs` («Racha 10-0 de MIA») sobre la línea.
- [ ] **Paso 3: Botones «Calor» y «Tiros».** «Calor» pinta sobre la cancha la cuadrícula de `heat` del equipo elegido (opacidad = valor). «Tiros» marca en la cancha cada remate (fútbol) o cada tiro de campo (NBA: círculo lleno si entró, × si no), y en NBA muestra la tabla de `shotZones` por equipo: Pintura, Media distancia, Triple de esquina, Triple frontal, con aciertos/intentos.
- [ ] **Paso 4: Verificar en el navegador** con los dos partidos de prueba: barras de presión con el pico del Everton cerca del gol, línea de probabilidad que termina arriba para los Lakers, al menos una racha, calor y tiros visibles y legibles a 375 px. Sin errores en consola.
- [ ] **Paso 5: Commit.**

### Tarea 7: Cierre

- [ ] **Paso 1:** `node --test` completo en PASS.
- [ ] **Paso 2:** si hay un partido de fútbol o NBA en juego, ábrelo en el estadio y deja pasar 2 minutos: deben llegar jugadas nuevas sin recargar y la red debe mostrar una petición a `/api/plays` cada 10 s, ninguna con la pestaña oculta.
- [ ] **Paso 3:** pide permiso al usuario antes de hacer push a `main`.
