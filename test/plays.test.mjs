// Jugadas de ESPN: normPlays con fixtures recortados de un partido real de cada deporte (test/fixtures/plays-*.json). Sin red.
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

test('normPlays NBA: un tiro con centinela no tiene posición ni zona', () => {
  const json = fixture('plays-nba.json');
  const sentinel = { ...json.plays.find((p) => p.id === '40190992126'), id: 'x1', coordinate: { x: -214748340, y: -214748365 } };
  const p = normPlays({ ...json, plays: [sentinel] }, 'basketball')[0];
  assert.deepEqual([p.kind, p.x, p.y, p.zone], ['shot', null, null, null]);
});

test('normPlays: summary sin jugadas da lista vacía', () => {
  assert.deepEqual(normPlays({ header: fixture('plays-nba.json').header }, 'basketball'), []);
  assert.deepEqual(normPlays(null, 'soccer'), []);
});
