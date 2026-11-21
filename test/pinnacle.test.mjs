import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnacleLine, pinnacleLines, consensusLine, _reset } from '../lib/pinnacle.mjs';
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

// Una casa de dos lados (básquet) con ganador, hándicap y total.
const book = (key, [h, a], spread, total) => ({ key, markets: [
  { key: 'h2h', outcomes: [out('Los Angeles Clippers', h), out('Indiana Pacers', a)] },
  ...(spread ? [{ key: 'spreads', outcomes: [out('Los Angeles Clippers', spread[1], spread[0]), out('Indiana Pacers', spread[2], -spread[0])] }] : []),
  ...(total ? [{ key: 'totals', outcomes: [out('Over', total[1], total[0]), out('Under', total[2], total[0])] }] : []),
] });
const ev = (...bookmakers) => ({ ...NBA, bookmakers });

test('consensusLine: mediana de las casas distintas, los clones cuentan una vez', () => {
  const pin = book('pinnacle', [1.8, 2.05], [-2.5, 1.95, 1.95], [228.5, 1.9, 1.95]);
  const a = book('a', [1.7, 2.2], [-2.5, 1.9, 2.0], [228.5, 1.95, 1.9]);
  const b = book('b', [1.6, 2.4], [-3.5, 1.9, 1.9], [228.5, 2.0, 1.85]); // otro hándicap: no entra en la mediana del hándicap
  const c = consensusLine(ev(pin, a, b, { ...b, key: 'clon-de-b' }));
  const p = (h, x) => (1 / h) / (1 / h + 1 / x);
  assert.ok(Math.abs(c.ml[0] - p(1.7, 2.2)) < 1e-9); // mediana de tres, no de cuatro
  assert.ok(Math.abs(c.ml[0] + c.ml[1] - 1) < 1e-12);
  assert.equal(c.spread.line, -2.5);
  assert.ok(Math.abs(c.spread.p - 0.5) < 1e-9); // solo dos casas en -2.5: queda la de Pinnacle
  assert.equal(c.total.line, 228.5);
  assert.ok(Math.abs(c.total.p - p(1.95, 1.9)) < 1e-9);
});

test('consensusLine: con menos de 3 precios distintos queda Pinnacle; sin Pinnacle, nada', () => {
  const pin = book('pinnacle', [1.8, 2.05]);
  assert.deepEqual(consensusLine(ev(pin, book('a', [1.7, 2.2]))), pinnacleLine(ev(pin)));
  assert.deepEqual(consensusLine(ev(pin, { ...pin, key: 'x' }, { ...pin, key: 'y' })), pinnacleLine(ev(pin))); // tres marcas, un precio
  assert.equal(consensusLine(ev(book('a', [1.7, 2.2]), book('b', [1.6, 2.4]), book('c', [1.5, 2.6]))), null);
  assert.equal(consensusLine(null), null);
});

test('consensusLine: 1X2 de tres salidas suma 1', () => {
  const soc = (key, f, c, d) => ({ key, markets: [{ key: 'h2h', outcomes: [out('Fulham', f), out('Manchester City', c), out('Draw', d)] }] });
  const c = consensusLine({ ...CITY, bookmakers: [soc('pinnacle', 6.61, 1.43, 5.18), soc('a', 7, 1.4, 5), soc('b', 6, 1.45, 5.5)] });
  assert.equal(c.ml.length, 3);
  assert.ok(Math.abs(c.ml.reduce((s, x) => s + x, 0) - 1) < 1e-12);
  assert.ok(c.ml[0] > 0.65 && c.ml[0] < 0.7);
});
