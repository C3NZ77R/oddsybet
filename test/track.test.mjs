// Seguimiento de apuestas de NBA: evaluación pura de cada selección contra el partido en vivo (lib/track.mjs). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { near, SWING_MS, quartersDone, evaluateSelection } from '../lib/track.mjs';
import { progress } from '../public/live.js';

// LiveGame mínimo (como normLive): local DEN (id 1), visitante LAL (id 2).
const game = ({ state = 'in', period = 4, clock = 372, home = 100, away = 95, players = [], winProb = null, name = null } = {}) => ({
  id: 'g1', league: 'nba', start: '2026-11-02T00:00:00Z',
  status: { state, detail: null, name },
  home: { id: '1', abbr: 'DEN', name: 'Denver Nuggets', score: state === 'pre' ? null : home },
  away: { id: '2', abbr: 'LAL', name: 'Los Angeles Lakers', score: state === 'pre' ? null : away },
  period, clock, progress: state === 'post' ? 1 : progress('basketball', 'nba', { period, clock }), winProb, players,
});
const jokic = (stats) => ({ id: '9', name: 'Nikola Jokić', teamId: '1', stats: { min: 30, pf: 1, ...stats } });
const sel = (o = {}) => ({
  id: 's1', betId: 'b1', gameId: 'g1', gameStart: '2026-11-02T00:00:00Z', market: 'prop', stat: 'pts', athleteId: '9',
  athleteName: 'Nikola Jokić', side: 'Over', line: 24.5, odds: null, label: 'Jokić · Más de 24.5 puntos', prior: null,
  status: 'pendiente', current: null, state: {}, ...o,
});
const total = (o = {}) => sel({ market: 'total', stat: null, athleteId: null, athleteName: null, line: 220.5, label: 'Más de 220.5 puntos', ...o });
const side = (o = {}) => sel({ market: 'ml', stat: null, athleteId: null, athleteName: null, side: 'home', line: null, label: 'Gana Nuggets', ...o });
const kinds = (r) => r.alerts.map((a) => a.kind);

test('near: umbral de "cerca" según la línea', () => {
  assert.equal(near(24.5), 4);
  assert.equal(near(8.5), 2);
  assert.equal(near(2.5), 1);
  assert.equal(near(0.5), 1);
});

test('quartersDone: cuartos cerrados, tope 4', () => {
  assert.equal(quartersDone(game({ period: 2, clock: 720 })), 1);
  assert.equal(quartersDone(game({ period: 2, clock: 0 })), 2);
  assert.equal(quartersDone(game({ period: 5, clock: 100 })), 4);
  assert.equal(quartersDone(game({ state: 'post' })), 4);
  assert.equal(quartersDone(game({ state: 'pre', period: null, clock: null })), 0);
});

test('prop Más: cerca una vez, cumplida apenas pasa, fallada al final; no muta la selección', () => {
  const s = sel();
  const r = evaluateSelection(s, game({ players: [jokic({ pts: 21 })] }), 0);
  assert.deepEqual(kinds(r), ['near']);
  assert.equal(r.state.near, true);
  assert.ok(r.alerts[0].text.includes('21'));
  assert.equal(r.status, 'en_juego');
  assert.deepEqual(s.state, {});
  assert.equal(evaluateSelection(sel({ state: r.state }), game({ players: [jokic({ pts: 22 })] }), 0).alerts.length, 0);

  const won = evaluateSelection(sel(), game({ players: [jokic({ pts: 25 })] }), 0);
  assert.equal(won.status, 'cumplida');
  assert.deepEqual(kinds(won), ['won']);
  assert.equal(evaluateSelection(sel({ status: 'cumplida', current: 25 }), game({ players: [jokic({ pts: 27 })] }), 0).alerts.length, 0);

  const lost = evaluateSelection(sel(), game({ state: 'post', players: [jokic({ pts: 22 })] }), 0);
  assert.equal(lost.status, 'fallada');
  assert.ok(lost.alerts[0].text.includes('22') && lost.alerts[0].text.includes('25'));
});

test('prop Menos: en peligro, fallada apenas se pasa, cumplida al final', () => {
  const u = (o) => sel({ stat: 'reb', side: 'Under', line: 8.5, label: 'Jokić · Menos de 8.5 rebotes', ...o });
  assert.deepEqual(kinds(evaluateSelection(u(), game({ players: [jokic({ reb: 7 })] }), 0)), ['danger']);
  const over = evaluateSelection(u(), game({ players: [jokic({ reb: 9 })] }), 0);
  assert.equal(over.status, 'fallada');
  assert.deepEqual(kinds(over), ['lost']);
  assert.equal(evaluateSelection(u(), game({ state: 'post', players: [jokic({ reb: 7 })] }), 0).status, 'cumplida');
});

test('línea entera exacta y hándicap al final', () => {
  const push = evaluateSelection(total({ line: 220, label: 'Más de 220 puntos' }), game({ state: 'post', home: 110, away: 110 }), 0);
  assert.equal(push.status, 'devuelta');
  assert.deepEqual(kinds(push), ['push']);
  const sp = (line, home) => evaluateSelection(side({ market: 'spread', line }), game({ state: 'post', home, away: 100 }), 0).status;
  assert.equal(sp(-5.5, 105), 'fallada');
  assert.equal(sp(-5.5, 106), 'cumplida');
  assert.equal(sp(-5, 105), 'devuelta');
});

test('anulada: jugador sin minutos al final o partido aplazado', () => {
  for (const players of [[], [jokic({ min: 0, pts: 0 })]]) {
    const r = evaluateSelection(sel(), game({ state: 'post', players }), 0);
    assert.equal(r.status, 'anulada');
    assert.deepEqual(kinds(r), ['void']);
  }
  assert.equal(evaluateSelection(sel(), game({ state: 'pre', name: 'STATUS_POSTPONED' }), 0).status, 'anulada');
});

test('riesgo por faltas y por partido definido, una vez', () => {
  const at = (period, pf, o = {}) => evaluateSelection(sel(o), game({ period, clock: 300, players: [jokic({ pts: 10, pf })] }), 0);
  assert.deepEqual(kinds(at(3, 4)), ['risk']);
  assert.deepEqual(kinds(at(4, 4)), []);
  assert.deepEqual(kinds(at(4, 5)), ['risk']);
  assert.deepEqual(kinds(at(4, 5, { state: at(4, 5).state })), []);

  const blow = evaluateSelection(sel(), game({ period: 3, clock: 200, home: 120, away: 100, players: [jokic({ pts: 10 })] }), 0);
  assert.deepEqual(kinds(blow), ['risk']);
  assert.deepEqual(kinds(evaluateSelection(sel({ status: 'cumplida', current: 26 }), game({ period: 3, clock: 200, home: 120, away: 100 }), 0)), []);
});

test('doble-doble: cerca con 10 y 8, cumplido con dos en 10', () => {
  const dd = (stats) => evaluateSelection(sel({ stat: 'dd', line: 0.5, label: 'Jokić · Doble-doble: Sí' }), game({ players: [jokic(stats)] }), 0);
  assert.deepEqual(kinds(dd({ pts: 12, reb: 8, ast: 2 })), ['near']);
  assert.equal(dd({ pts: 12, reb: 10, ast: 2 }).status, 'cumplida');
});

test('total: un resumen por cuarto cerrado, solo el último si ESPN saltó varios', () => {
  const q1 = evaluateSelection(total(), game({ period: 2, clock: 720, home: 55, away: 50 }), 0);
  assert.deepEqual(kinds(q1), ['quarter']);
  assert.equal(q1.state.q, 1);
  assert.ok(q1.alerts[0].text.includes('%'));
  const q3 = evaluateSelection(total({ state: q1.state }), game({ period: 4, clock: 720, home: 85, away: 80 }), 0);
  assert.deepEqual(kinds(q3), ['quarter']);
  assert.equal(q3.state.q, 3);
});

test('ganador: cambio de ventaja en el 4.º con límite de 3 minutos', () => {
  const t0 = 1_000_000;
  const a = evaluateSelection(side(), game({ period: 4, clock: 600, home: 90, away: 85 }), t0 - 30_000);
  const b = evaluateSelection(side({ state: a.state }), game({ period: 4, clock: 560, home: 90, away: 92 }), t0);
  assert.deepEqual(kinds(b), ['swing']);
  const c = evaluateSelection(side({ state: b.state }), game({ period: 4, clock: 500, home: 95, away: 92 }), t0 + 60_000);
  assert.deepEqual(kinds(c), []);
  const d = evaluateSelection(side({ state: c.state }), game({ period: 4, clock: 400, home: 97, away: 92 }), t0 + SWING_MS);
  assert.deepEqual(kinds(d), ['swing']);
  // Empate en el marcador: no cambia nada.
  assert.deepEqual(kinds(evaluateSelection(side({ state: d.state }), game({ period: 4, clock: 100, home: 97, away: 97 }), t0 + 2 * SWING_MS)), []);
});

test('estado según el partido y % solo con prior', () => {
  assert.equal(evaluateSelection(sel(), game({ state: 'pre', period: null, clock: null }), 0).status, 'pendiente');
  assert.equal(evaluateSelection(sel(), game({ period: 2, players: [jokic({ pts: 8 })] }), 0).status, 'en_juego');
  const withPrior = evaluateSelection(sel({ prior: { mean: 26, variance: 60, kind: 'normal' } }), game({ players: [jokic({ pts: 21 })] }), 0);
  assert.ok(withPrior.alerts[0].text.includes('%'));
  assert.ok(!evaluateSelection(sel(), game({ players: [jokic({ pts: 21 })] }), 0).alerts[0].text.includes('%'));
});
