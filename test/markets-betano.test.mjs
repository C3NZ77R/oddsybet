// Mercados con la lectura de Betano del servidor (book): frescura, líneas leídas, cuota y ventaja por selección.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getMarkets, getPicks, freshness, picksOf } from '../lib/markets.mjs';

const H = 3_600_000;
const pick = (ms, key) => ms.filter((m) => m.key === key);
const sel = (m, name) => m.selections.find((s) => s.name === name);

// ESPN simulado, como en test/markets.test.mjs (withEspn, leagueRoute), con nombre de equipo para emparejar con Betano.
async function withEspn(route, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = await route(new URL(url));
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const NAMES = { 1: 'Atlético Rojo', 2: 'Deportivo Azul', 3: 'Real Verde', 4: 'Sporting Gris' };
const ev = (id, date, homeId, awayId, hs, as, state = 'post') => ({
  id, date, seasonType: { type: 2 },
  competitions: [{ id, date, neutralSite: false, status: { period: 2, type: { state, completed: state === 'post' } },
    competitors: [[homeId, 'home', hs], [awayId, 'away', as]].map(([t, homeAway, value]) => ({ homeAway, id: t, team: { id: t, displayName: NAMES[t] }, score: { value } })) }],
});
const leagueRoute = (espn, events, board) => (u) => {
  const path = u.pathname.replace(/^\/apis\/site\/v2\/sports\/[a-z]+\//, '');
  if (path === `${espn}/teams`) return { sports: [{ leagues: [{ teams: Object.keys(NAMES).map((id) => ({ team: { id } })) }] }] };
  const team = new RegExp(`^${espn}/teams/(\\d+)/schedule$`).exec(path)?.[1];
  if (team) return { events: events.filter((e) => e.competitions[0].competitors.some((c) => c.id === team)) };
  if (path === `${espn}/scoreboard`) return { events: board };
  return null;
};
// Temporada de ida y vuelta entre 4 equipos y un partido por jugar (1 de local contra 2) el 11 de abril.
const START = '2026-04-11T19:00:00.000Z', T = Date.parse(START), NOW = T - 10 * H;
function season(score) {
  const ids = Object.keys(NAMES), events = [];
  let k = 0;
  for (const h of ids) for (const a of ids) if (h !== a) events.push(ev(`r${k}`, new Date(Date.UTC(2026, 0, 3 + 7 * k++, 19)).toISOString(), h, a, ...score(k)));
  return [events, [ev('g', START, '1', '2', 0, 0, 'pre')]];
}
// Betano lista primero al visitante de Oddsy: flip.
const book = (g, at = NOW - H) => ({ games: [{ t: T, teams: ['Deportivo Azul', 'Atletico Rojo'], ou: [], ...g, at }] });

test('frescura: menos de 6 h, o menos de 1 h si el partido empieza en menos de 3 h; sin lectura, null', () => {
  const now = 1e12;
  assert.equal(freshness(undefined, now + 10 * H, now), null);
  assert.equal(freshness(null, now + 10 * H, now), null);
  assert.equal(freshness(now - 6 * H + 1, now + 10 * H, now), true);
  assert.equal(freshness(now - 6 * H, now + 10 * H, now), false);
  assert.equal(freshness(now - 2 * H, now + 3 * H, now), true, 'a 3 h justas todavía valen las 6 h');
  assert.equal(freshness(now - 2 * H, now + 3 * H - 1, now), false);
  assert.equal(freshness(now - H + 1, now + 3 * H - 1, now), true);
  assert.equal(freshness(now - H, now + H, now), false);
  assert.equal(freshness(now - H + 1, now - H, now), true, 'ya empezado: también 1 h');
});

test('fútbol: con lectura fresca solo las líneas de goles leídas, con cuota de Betano, ventaja y sospecha; vieja o sin book, lo de siempre', async () => {
  const [events, board] = season(() => [1, 1]);
  await withEspn(leagueRoute('esp.1', events, board), async () => {
    const opts = { date: '20260411', now: NOW };
    const plain = (await getMarkets('laliga', opts)).data[0];
    assert.equal('betano' in plain, false);
    assert.ok(pick(plain.markets, 'ou').length > 2);
    assert.ok(plain.markets.every((m) => m.selections.every((s) => !('betano' in s) && !('edge' in s))));

    // 3 = entera: no es una línea que Oddsy cotice, no cuenta. ml en orden de Betano: [Azul (visitante), X, Rojo (local)].
    const b = book({ ou: [[2.5, 1.9, 100], [3.5, 3.2, 1.3], [3, 2, 2]], ml: [3.1, 3.3, 2.4], btts: [1.8, 1.95] });
    const g = (await getMarkets('laliga', { ...opts, book: b })).data[0];
    assert.deepEqual(g.betano, { at: NOW - H, fresh: true });
    assert.deepEqual(pick(g.markets, 'ou').map((m) => m.selections[0].line), [2.5, 3.5]);
    assert.equal(pick(g.markets, 'ou_home').length, pick(plain.markets, 'ou_home').length, 'los demás mercados no se filtran');
    const [o25] = pick(g.markets, 'ou'), mas = sel(o25, 'Más'), menos = sel(o25, 'Menos');
    assert.equal(mas.betano, 1.9);
    assert.equal(mas.edge, mas.p * 1.9 - 1);
    assert.equal(mas.suspect, undefined);
    assert.equal(menos.betano, 100);
    assert.ok(menos.edge > 0.25);
    assert.equal(menos.suspect, true);
    const [x12] = pick(g.markets, '1x2');
    assert.deepEqual(['Local', 'Empate', 'Visitante'].map((n) => sel(x12, n).betano), [2.4, 3.3, 3.1]);
    assert.equal(sel(pick(g.markets, 'btts')[0], 'Sí').betano, 1.8);
    // Lo que ya había sigue igual: mismos campos y valores en cada selección.
    const strip = (ms) => ms.map((m) => ({ ...m, selections: m.selections.map(({ betano, edge, suspect, ...s }) => s) }));
    assert.deepEqual(strip(g.markets), plain.markets.filter((m) => m.key !== 'ou' || [2.5, 3.5].includes(m.selections[0].line)));

    // Vieja (10 h): ni filtra ni adjunta, solo avisa.
    const old = (await getMarkets('laliga', { ...opts, book: book(b.games[0], NOW - 10 * H) })).data[0];
    assert.deepEqual(old.betano, { at: NOW - 10 * H, fresh: false });
    assert.deepEqual(old.markets, plain.markets);
    // Sin partido emparejado: null.
    const none = (await getMarkets('laliga', { ...opts, book: { games: [] } })).data[0];
    assert.equal(none.betano, null);
    assert.deepEqual(none.markets, plain.markets);

    // Los picks conservan betano, edge y suspect, y el partido su betano.
    const [p0, p1] = await Promise.all([getPicks('laliga', opts), getPicks('laliga', { ...opts, book: b })]);
    assert.equal('betano' in p0.data[0], false);
    assert.deepEqual(p1.data[0].betano, { at: NOW - H, fresh: true });
    const ou = p1.data[0].picks.find((p) => p.market === 'ou');
    const src = sel(pick(g.markets, 'ou').find((m) => m.label === ou.label), ou.name);
    assert.deepEqual([ou.betano, ou.edge, ou.suspect], [src.betano, src.edge, src.suspect]);
    assert.ok(p0.data[0].picks.every((p) => !('betano' in p) && !('edge' in p) && !('suspect' in p)));
  });
});

test('básquet: con lectura fresca cotiza hándicap y total en la línea de Betano; vieja, en la del modelo', async () => {
  const [events, board] = season((k) => [100 + (k % 7), 98 + (k % 5)]);
  await withEspn(leagueRoute('nba', events, board), async () => {
    const opts = { date: '20260411', now: NOW };
    const plain = (await getMarkets('nba', opts)).data[0];
    const lineOf = (g, key) => pick(g.markets, key)[0].selections[0].line;
    // Betano: Azul (visitante) +3.5 → local −3.5.
    const b = book({ spread: [3.5, 1.87, 1.93], ou: [[204.5, 1.9, 1.9]] });
    assert.notEqual(lineOf(plain, 'spread'), -3.5);
    const g = (await getMarkets('nba', { ...opts, book: b })).data[0];
    assert.equal(lineOf(g, 'spread'), -3.5);
    assert.equal(lineOf(g, 'ou'), 204.5);
    const [sp] = pick(g.markets, 'spread');
    assert.deepEqual([sel(sp, 'Local').betano, sel(sp, 'Visitante').betano], [1.93, 1.87]);
    assert.equal(sel(sp, 'Local').edge, sel(sp, 'Local').p * 1.93 - 1);
    const old = (await getMarkets('nba', { ...opts, book: book(b.games[0], NOW - 7 * H) })).data[0];
    assert.deepEqual(old.markets, plain.markets);
    assert.equal(old.betano.fresh, false);
  });
});

test('tenis: con lectura fresca el total de games sale en las líneas de Betano, con su cuota', async () => {
  const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  await withEspn((u) => (/\/rankings$/.test(u.pathname) ? fx('atp-rankings.json') : /\/scoreboard$/.test(u.pathname) ? fx('atp-month.json') : null), async () => {
    const opts = { game: '182677', date: '20260913' };
    const plain = (await getMarkets('atp', opts)).data;
    assert.equal('betano' in plain, false);
    assert.equal(pick(plain.markets, 'ou_games').length, 1);
    const { start, home, away } = plain.game, now = Date.parse(start) - 10 * H;
    const b = { games: [{ t: Date.parse(start), teams: [home.name, away.name], ml: [1.5, 2.6], ou: [], gou: [[40.5, 1.8, 2], [42.5, 1.95, 1.85]], at: now - H }] };
    const g = (await getMarkets('atp', { ...opts, book: b, now })).data;
    assert.deepEqual(g.betano, { at: now - H, fresh: true });
    const ou = pick(g.markets, 'ou_games');
    assert.deepEqual(ou.map((m) => m.selections[0].line), [40.5, 42.5]);
    assert.equal(sel(ou[1], 'Menos').betano, 1.85);
    assert.deepEqual(pick(g.markets, 'ml')[0].selections.map((s) => s.betano), [1.5, 2.6]);
    // Aun con dos líneas, un solo pick de total de games (la más pareja).
    assert.ok(picksOf('tennis', g.markets, { min: 0 }).filter((p) => p.market === 'ou_games').length === 1);
    const old = (await getMarkets('atp', { ...opts, book: { games: [{ ...b.games[0], at: now - 7 * H }] }, now })).data;
    assert.deepEqual(old.markets, plain.markets);
    assert.equal(old.betano.fresh, false);
  });
});
