// ATP Challenger de LiveScore (lib/challenger.mjs): normalizador del día y cotización con su propio Elo, sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normDay, surfaceOf, liveDays, MAX_LIVE_DAYS } from '../lib/challenger.mjs';
import { mergeRows } from '../scripts/challenger-snapshot.mjs';
import { finished } from '../lib/tennis.mjs';

const fx = () => JSON.parse(readFileSync(new URL('./fixtures/livescore-tennis.json', import.meta.url), 'utf8'));

test('challenger: solo singles del Challenger (sin dobles, WTA ni ATP salvo que se pidan), con la forma de lib/tennis.mjs', () => {
  const ms = normDay(fx());
  assert.equal(ms.length, 7);
  assert.ok(ms.every((m) => m.level === 'challenger' && m.id.startsWith('ls') && m.a.id.startsWith('ls')));
  assert.equal(normDay(fx(), { atp: true }).filter((m) => m.level === 'atp').length, 1); // Estocolmo; la WTA nunca
  const tomic = ms.find((m) => m.id === 'ls1916573');
  assert.deepEqual({ ...tomic, a: tomic.a.name, b: tomic.b.short }, {
    id: 'ls1916573', date: '2026-11-09T08:50:00.000Z', tournament: 'Brisbane 3', surface: 'hard', round: null, bestOf: 3, slam: false,
    state: 'post', a: 'Bernard Tomic', b: 'B. Ellis', winner: 'a', sets: [[6, 3], [4, 6], [7, 5]], retired: false, level: 'challenger',
  });
  assert.deepEqual(ms.find((m) => m.id === 'ls1916574').sets[0], [6, 7, 3, 7]); // tiebreak como en ESPN
});

test('challenger: estados por partido; cancelado y retiro', () => {
  const by = Object.fromEntries(normDay(fx()).map((m) => [m.id, m]));
  assert.equal(by.ls1916903.state, 'pre');
  assert.equal(by.ls1916903.winner, null);
  assert.equal(by.ls9000001.state, 'in');
  assert.equal(by.ls9000002.state, 'post');
  assert.equal(by.ls9000002.winner, null); // cancelado: no entra al Elo ni se califica
  assert.deepEqual([by.ls9000003.state, by.ls9000003.winner, by.ls9000003.retired], ['post', 'a', true]);
  assert.deepEqual(finished(Object.values(by)).map((m) => m.id).sort(), ['ls1916573', 'ls1916574', 'ls9000003']);
});

test('challenger: superficie por la sede', () => {
  assert.equal(surfaceOf('Lima, Peru'), 'clay');
  assert.equal(surfaceOf('Knoxville, USA'), 'hard');
  assert.equal(surfaceOf('Orleans, France'), 'hard');
});

test('challenger: getMarkets cotiza los del día con el Elo del Challenger y la precisión publicada', async () => {
  const { getMarkets, getTennisGames } = await import('../lib/markets.mjs');
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/20261109/') ? fx() : { Stages: [] }), { status: 200 });
  try {
    const { data, accuracy } = await getMarkets('challenger', { date: '20261109' });
    assert.equal(accuracy.publish, true);
    assert.equal(data.length, 7);
    const pre = data.find((x) => x.gameId === 'ls1916903');
    assert.equal(pre.game.league, 'challenger');
    const ml = pre.markets.find((m) => m.key === 'ml');
    assert.ok(Math.abs(ml.selections[0].p + ml.selections[1].p - 1) < 1e-9);
    assert.ok(pre.markets.some((m) => m.key === 'ou_set1'), 'games del primer set con el largo del set del Challenger');
    const games = await getTennisGames('challenger', '20261109');
    assert.deepEqual(games.map((g) => g.id).sort(), data.map((x) => x.gameId).sort());
    assert.equal(games.find((g) => g.id === 'ls1916573').status.detail, '6-3 4-6 7-5');
  } finally {
    globalThis.fetch = real;
  }
});

test('challenger: los días en vivo van desde dos antes del último del snapshot hasta hoy, con tope', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  assert.deepEqual(liveDays([{ date: '2026-11-08T20:00:00Z' }], now), ['20261106', '20261107', '20261108', '20261109', '20261110']);
  const old = liveDays([{ date: '2026-01-01T00:00:00Z' }], now);
  assert.equal(old.length, MAX_LIVE_DAYS + 1); // workflow caído: no más que el tope
  assert.equal(old.at(-1), '20261110');
  assert.equal(liveDays([], now).length, MAX_LIVE_DAYS + 1); // sin snapshot
});

test('challenger: el snapshot suma sin borrar; la fila nueva gana y queda por fecha', () => {
  const old = [['ls1', '2026-01-02', 'h'], ['ls2', '2026-01-01', 'h']];
  assert.deepEqual(mergeRows(old, [['ls1', '2026-01-02', 'c'], ['ls3', '2026-01-03', 'h']]), [['ls2', '2026-01-01', 'h'], ['ls1', '2026-01-02', 'c'], ['ls3', '2026-01-03', 'h']]);
});
