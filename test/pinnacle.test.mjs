import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnacleLine, pinnacleLines, _reset } from '../lib/pinnacle.mjs';
import { marketsFor } from '../lib/markets.mjs';
import { overOf, gamesOf, gameFor } from '../public/betano.js';

// Recorte real de The Odds API (2026-11-11): Manchester City – Fulham con Pinnacle.
const out = (name, price, point) => ({ name, price, ...(point != null && { point }) });
const CITY = { home_team: 'Manchester City', away_team: 'Fulham', commence_time: '2026-11-21T15:30:00Z', bookmakers: [{ key: 'pinnacle', markets: [
  { key: 'h2h', outcomes: [out('Fulham', 6.61), out('Manchester City', 1.43), out('Draw', 5.18)] },
  { key: 'totals', outcomes: [out('Over', 2.05, 3.25), out('Under', 1.83, 3.25)] },
] }] };
const NBA = { home_team: 'Los Angeles Clippers', away_team: 'Indiana Pacers', commence_time: '2026-11-21T03:00:00Z', bookmakers: [{ key: 'pinnacle', markets: [
  { key: 'h2h', outcomes: [out('Los Angeles Clippers', 1.8), out('Indiana Pacers', 2.05)] },
  { key: 'spreads', outcomes: [out('Los Angeles Clippers', 1.95, -2.5), out('Indiana Pacers', 1.95, 2.5)] },
  { key: 'totals', outcomes: [out('Over', 1.9, 228.5), out('Under', 1.95, 228.5)] },
] }] };

test('pinnacleLine: sin margen, y las líneas de cuarto no se usan', () => {
  const c = pinnacleLine(CITY);
  assert.equal(c.ml.length, 3);
  assert.ok(Math.abs(c.ml.reduce((s, x) => s + x, 0) - 1) < 1e-12);
  assert.ok(c.ml[0] > 0.65 && c.ml[0] < 0.7); // City local
  assert.equal(c.total, undefined); // 3.25 es de cuarto
  const n = pinnacleLine(NBA);
  assert.deepEqual(n.spread.line, -2.5);
  assert.ok(Math.abs(n.spread.p - 0.5) < 1e-9);
  assert.equal(n.total.line, 228.5);
  assert.equal(pinnacleLine({ ...CITY, bookmakers: [{ key: 'unibet_fr', markets: [] }] }), null);
  assert.equal(pinnacleLine(null), null);
});

test('pinnacleLines casa por equipos y hora, usa caché y no llama sin clave', async () => {
  _reset();
  let calls = 0;
  const fetch = async (url) => { calls++; assert.match(url, /basketball_nba.*bookmakers=pinnacle.*markets=h2h,spreads,totals/); return { ok: true, headers: new Headers({ 'x-requests-remaining': '400' }), json: async () => [NBA] }; };
  const game = (id, home, away, start) => ({ id, start, home: { name: home }, away: { name: away } });
  const opts = { key: 'k', fetch, now: () => 1e12 };
  const got = await pinnacleLines('nba', [game('1', 'LA Clippers', 'Indiana Pacers', '2026-11-21T03:30:00Z'), game('2', 'LA Clippers', 'Indiana Pacers', '2026-11-25T03:00:00Z'), game('3', 'Boston Celtics', 'Indiana Pacers', '2026-11-21T03:00:00Z')], opts);
  assert.deepEqual([...got.keys()], ['1']); // el de otra fecha y el de otro equipo no
  await pinnacleLines('nba', [game('1', 'LA Clippers', 'Indiana Pacers', '2026-11-21T03:30:00Z')], opts);
  assert.equal(calls, 1);
  _reset();
  assert.equal((await pinnacleLines('nba', [game('1', 'LA Clippers', 'Indiana Pacers', '2026-11-21T03:30:00Z')], { ...opts, key: '' })).size, 0);
  assert.equal(calls, 1);
  assert.equal((await pinnacleLines('colombia', [game('1', 'a', 'b', '2026-11-21T03:30:00Z')], opts)).size, 0); // liga que The Odds API no tiene
});

test('si The Odds API falla, no hay línea y no revienta', async () => {
  _reset();
  const fetch = async () => ({ ok: false, status: 401 });
  assert.equal((await pinnacleLines('nba', [{ id: '1', start: '2026-11-21T03:00:00Z', home: { name: 'a' }, away: { name: 'b' } }], { key: 'k', fetch })).size, 0);
});

test('marketsFor cotiza el básquet en las líneas de la casa y overOf las saca del partido de Betano', () => {
  const model = { kind: 'normal', mu: 3.1, sigma: 12, total: 226, sigmaT: 18 };
  const [ml, spread, ou] = marketsFor('basketball', model, { spread: -2.5, total: 228.5 });
  assert.equal(spread.selections[0].line, -2.5);
  assert.equal(spread.selections[1].line, 2.5);
  assert.equal(ou.selections[0].line, 228.5);
  assert.ok(ou.selections[0].p < marketsFor('basketball', model)[2].selections[0].p); // el total más alto da menos Más
  assert.equal(marketsFor('basketball', model)[1].selections[0].line, -3.5); // sin pedirlas, la del modelo
  assert.ok(ml.selections[0].p > 0.5);

  const bt = gamesOf([['Indiana Pacers - Washington Wizards', 1795222800000, [], [
    ['FHOT', [['Indiana Pacers -2.5', 1.91, -2.5], ['Washington Wizards +2.5', 1.9, 2.5]]],
    ['FTPO', [['Más de 228.5', 1.93, 228.5], ['Menos 228.5', 1.87, 228.5]]],
  ]]]);
  const d = (home, away) => ({ start: '2026-11-21T00:00:00Z', home: { name: home }, away: { name: away } });
  assert.deepEqual(overOf(gameFor({ games: bt }, d('Indiana Pacers', 'Washington Wizards'))), { spread: -2.5, total: 228.5 });
  assert.deepEqual(overOf(gameFor({ games: bt }, d('Washington Wizards', 'Indiana Pacers'))), { spread: 2.5, total: 228.5 }); // al revés
  assert.equal(overOf(null), null);
});
