// Jugadas de ESPN: normPlays con fixtures recortados de un partido real de cada deporte (test/fixtures/plays-*.json). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normPlays } from '../lib/plays.mjs';
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

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

test('normPlays fútbol: posición y destino se espejan para el visitante y quedan igual para el local', () => {
  const plays = normPlays(fixture('plays-epl.json'), 'soccer');
  const away = plays.find((p) => p.id === '54731593'); // Everton: (92.7, 68.5) → destino (98.8, 50.2) en su propio marco
  assert.equal(away.side, 'away');
  [away.x, away.y, away.tx, away.ty].forEach((v, i) => near(v, [7.3, 31.5, 1.2, 49.8][i]));
  const home = plays.find((p) => p.id === '54727191'); // Newcastle: ya está en el marco del local
  assert.equal(home.side, 'home');
  [home.x, home.y, home.tx, home.ty].forEach((v, i) => near(v, [82.3, 43.3, 92.5, 46.8][i]));
});

test('normPlays fútbol: "wins a free kick" es un tiro libre del equipo que lo gana, en la misma posición que la falta', () => {
  const json = fixture('plays-epl.json');
  const plays = normPlays(json, 'soccer');
  const foul = plays.find((p) => p.seq === 2), fk = plays.find((p) => p.seq === 3);
  assert.equal(foul.kind, 'foul'); // ESPN repite la falta con las dos frases, las dos con el equipo que la cometió
  assert.equal(foul.side, 'home'); // Newcastle
  assert.equal(fk.kind, 'free-kick');
  assert.equal(fk.label, 'Tiro libre');
  assert.equal(fk.side, 'away'); // Everton
  assert.deepEqual([fk.x, fk.y], [foul.x, foul.y]);
  assert.deepEqual([foul.who, fk.who], ['Harvey Barnes', "Jake O'Brien"]); // el tiro libre es del que recibió la falta
  assert.equal(fk.id, `${foul.id}-fk`); // ESPN repite el play.id: sin sufijo, la repetición saltaría el tiro libre
  assert.match(fk.text, /wins a free kick/);
  assert.equal(new Set(plays.map((p) => p.id)).size, plays.length);
  const wins = json.commentary.filter((c) => /wins a free kick/i.test(c.text ?? c.play?.text ?? '')).length;
  assert.equal(plays.filter((p) => p.kind === 'free-kick').length, wins);
});

test('normPlays fútbol: un autogol cuenta para el rival', () => {
  const json = fixture('plays-epl.json');
  const og = { sequence: 999, time: { value: 600 }, play: { id: 'og1', type: { text: 'Own Goal' }, clock: { value: 600, displayValue: "10'" }, period: { number: 1 }, team: { displayName: 'Newcastle United' }, fieldPositionX: 5, fieldPositionY: 50 } };
  const p = normPlays({ ...json, commentary: [og] }, 'soccer')[0];
  assert.equal(p.kind, 'goal');
  assert.equal(p.side, 'away');
  assert.deepEqual([p.x, p.y], [5, 50]); // la posición sigue en el marco de quien lo metió: su propio arco, a la izquierda
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
  near(s.x, 26.6); // visitante: x = 25·100/94 = 26.595…, redondeado a un decimal
  near(s.y, 24); // 100 − 38·2
  const h = plays.find((p) => p.id === '40190992128'); // triple de los Lakers (local) en (13, 22)
  assert.equal(h.side, 'home');
  near(h.x, 76.6); // 100 − 22·100/94
  near(h.y, 26); // 13·2
  assert.equal(s.t, 91); // 12:00 − 10:29
  assert.deepEqual(plays.at(-1).score, [117, 138]);
});

test('normPlays NBA: el rebote defensivo y la falta de la defensa van en el aro del que atacaba', () => {
  // ESPN copia en el rebote las coordenadas del tiro fallado, medidas desde el aro de quien tiró.
  const plays = normPlays(fixture('plays-nba.json'), 'basketball');
  const def = plays.filter((p) => p.label === 'Rebote' && p.x != null);
  let checked = 0;
  for (const r of def) {
    const shot = plays.filter((p) => p.seq < r.seq && p.kind === 'shot' && p.x != null).at(-1);
    if (shot?.side === r.side) continue; // rebote ofensivo: mismo equipo, mismo marco
    assert.deepEqual([r.x, r.y], [shot.x, shot.y], `rebote ${r.id}`);
    checked++;
  }
  assert.ok(checked > 30, `rebotes defensivos revisados: ${checked}`);
  const foul = plays.find((p) => p.id === '40190992119'); // falta de tiro del local: la jugada es en el aro que ataca el visitante
  assert.equal(foul.side, 'home');
  assert.ok(foul.x < 50, `x = ${foul.x}`);
});

test('normPlays NBA: tiros libres y centinelas sin posición', () => {
  const plays = normPlays(fixture('plays-nba.json'), 'basketball');
  const ft = plays.filter((p) => p.kind === 'ft');
  assert.equal(ft.length, 59);
  assert.ok(ft.every((p) => p.x == null && p.y == null));
  assert.ok(plays.every((p) => p.x == null || (p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100)));
  const shots = plays.filter((p) => p.kind === 'shot');
  assert.ok(shots.every((p) => p.x != null)); // incluye los dos triples de esquina que ESPN pone en y = -3
  const corner = plays.find((p) => p.id === '401909921461'); // visitante en (49, -3): detrás de la línea de fondo, y se toma como 0
  assert.deepEqual([corner.zone, corner.side], ['corner3', 'away']);
  near(corner.x, 0);
  near(corner.y, 2);
});

test('normPlays NBA: un tiro con centinela no tiene posición ni zona', () => {
  const json = fixture('plays-nba.json');
  const sentinel = { ...json.plays.find((p) => p.id === '40190992126'), id: 'x1', coordinate: { x: -214748340, y: -214748365 } };
  const p = normPlays({ ...json, plays: [sentinel] }, 'basketball')[0];
  assert.deepEqual([p.kind, p.x, p.y, p.zone], ['shot', null, null, null]);
});

test('normPlays: ninguna etiqueta queda en inglés', () => {
  const eplFx = fixture('plays-epl.json'), nbaFx = fixture('plays-nba.json');
  const raw = new Map([...eplFx.commentary.filter((c) => c.play).map((c) => [c.play.id, c.play.type.text]), ...nbaFx.plays.map((p) => [p.id, p.type.text])]);
  const plays = [...normPlays(eplFx, 'soccer'), ...normPlays(nbaFx, 'basketball')];
  assert.ok(plays.length > 600);
  assert.ok(plays.every((p) => p.label !== raw.get(p.id)), 'el type.text de ESPN no pasa tal cual a label');
  assert.deepEqual(['Halftime', 'Start 2nd Half', 'End Regular Time', 'Start Delay', 'End Delay', 'VAR - Referee decision confirmed']
    .map((t) => normPlays(eplFx, 'soccer').find((p) => raw.get(p.id) === t).label),
  ['Descanso', 'Segundo tiempo', 'Fin del tiempo reglamentario', 'Pausa', 'Se reanuda', 'Revisión del VAR']);
  assert.deepEqual(['End Period', 'End Game', 'Jumpball', "Coach's Challenge (Stands)", 'Lane']
    .map((t) => normPlays(nbaFx, 'basketball').find((p) => raw.get(p.id) === t).label),
  ['Fin del periodo', 'Final del partido', 'Salto entre dos', 'Revisión (challenge)', 'Violación']);
  const kicked = normPlays(nbaFx, 'basketball').find((p) => raw.get(p.id) === 'Kicked Ball');
  assert.equal(kicked.label, 'Jugada'); // tipo desconocido: etiqueta genérica y el inglés queda en text
  assert.ok(kicked.text);
});

test('normPlays NBA: el jugador sale del boxscore cuando el play solo trae su id', () => {
  const json = fixture('plays-nba.json');
  assert.equal(normPlays(json, 'basketball').find((p) => p.id === '40190992126').who, null); // sin boxscore, no se inventa
  const boxscore = { players: [{ statistics: [{ athletes: [{ athlete: { id: '4278053', displayName: 'Davion Mitchell' } }, { athlete: { id: '1' } }] }] }] };
  const s = normPlays({ ...json, boxscore }, 'basketball').find((p) => p.id === '40190992126');
  assert.equal(s.who, 'Davion Mitchell');
});

test('normPlays NBA: la WNBA juega cuartos de 10 minutos', () => {
  const json = fixture('plays-nba.json');
  const base = json.plays.find((p) => p.id === '40190992126');
  const at = (period, clock, league) => normPlays({ ...json, plays: [{ ...base, period: { number: period }, clock: { displayValue: clock } }] }, 'basketball', league)[0].t;
  assert.equal(at(2, '9:30', 'wnba'), 630); // 10:00 + (10:00 − 9:30)
  assert.equal(at(2, '9:30'), 870); // misma jugada con cuartos de 12 min
  assert.equal(at(5, '4:00', 'wnba'), 2460); // la prórroga sigue siendo de 5 min: 4 × 600 + (5:00 − 4:00)
});

test('normPlays: made solo en tiros; "Goal Kick" no es gol', () => {
  const nba = normPlays(fixture('plays-nba.json'), 'basketball');
  assert.ok(nba.filter((p) => p.kind !== 'shot' && p.kind !== 'ft').every((p) => p.made === null));
  assert.ok(nba.filter((p) => p.kind === 'ft').some((p) => p.made === true) && nba.filter((p) => p.kind === 'ft').some((p) => p.made === false));
  const json = fixture('plays-epl.json');
  const kind = (text) => normPlays({ ...json, commentary: [{ sequence: 1, play: { id: 'k', type: { text } } }] }, 'soccer')[0];
  assert.deepEqual([kind('Goal').kind, kind('Goal - Header').kind, kind('Penalty - Scored').kind], ['goal', 'goal', 'goal']);
  assert.deepEqual([kind('Goal Kick').kind, kind('Goal Kick').label], ['other', 'Jugada']);
});

test('normPlays: summary sin jugadas da lista vacía', () => {
  assert.deepEqual(normPlays({ header: fixture('plays-nba.json').header }, 'basketball'), []);
  assert.deepEqual(normPlays(null, 'soccer'), []);
});
