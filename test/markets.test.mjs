// Mercados por deporte desde el modelo de expected(): sumas, identidades entre mercados y casos límite. getMarkets con
// ESPN simulado (sin red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marketsFor, getMarkets } from '../lib/markets.mjs';
import { scoreGrid, normalOver, halfLine, MAX_P, publishable } from '../lib/pricing.mjs';
import { matchDist, setGames, getHistory, getEloHistory, eloFrom, matchProb } from '../lib/tennis.mjs';
import { getSeasonResults } from '../lib/espn.mjs';
import { ratingsFromResults, expected } from '../lib/ratings.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const sumP = (m) => m.selections.reduce((s, x) => s + x.p, 0);
const pick = (ms, key, line) => ms.find((m) => m.key === key && (line === undefined || m.selections[0].line === line));
const sel = (m, name) => m.selections.find((s) => s.name === name);

const SOCCER = { kind: 'poisson', lh: 1.4, la: 1.1 };
const BASEBALL = { kind: 'poisson', lh: 4.6, la: 4.1 };
const NBA = { kind: 'normal', mu: 5.2, sigma: 12, total: 226.3, sigmaT: 13.2 };
const BO3 = { kind: 'tennis', dist: matchDist(0.67, 0.62, 3) };
const BO5 = { kind: 'tennis', dist: matchDist(0.67, 0.62, 5, { slam: true }) };
const CASES = [['soccer', SOCCER], ['baseball', BASEBALL], ['basketball', NBA], ['football', { ...NBA, sigma: 13.5 }], ['tennis', BO3], ['tennis', BO5]];

test('markets: 1x2 suma 1', () => {
  close(sumP(pick(marketsFor('soccer', SOCCER), '1x2')), 1);
});

test('markets: cada mercado suma 1 (doble oportunidad suma 2: cada selección cubre dos resultados)', () => {
  for (const [sport, model] of CASES) {
    for (const m of marketsFor(sport, model)) close(sumP(m), m.key === 'dc' ? 2 : 1);
  }
});

test('markets: cada selección trae p, fair y oddsy, con oddsy < fair', () => {
  for (const [sport, model] of CASES) {
    for (const m of marketsFor(sport, model)) {
      assert.ok(m.key && m.label && m.selections.length >= 2, `${sport} ${m.key}`);
      for (const s of m.selections) {
        assert.ok(s.name && s.p >= 0 && s.p <= 1, `${sport} ${m.key} ${s.name}`);
        assert.ok(s.oddsy < s.fair, `${sport} ${m.key} ${s.name}: ${s.oddsy} ≥ ${s.fair}`);
      }
    }
  }
});

test('markets: fútbol trae todos los mercados y líneas del brief', () => {
  const ms = marketsFor('soccer', SOCCER);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['1x2', 'dc', 'dnb', 'ou', 'ou_home', 'ou_away', 'btts', 'ah', 'aou', 'cs']);
  assert.deepEqual(ms.filter((m) => m.key === 'ou').map((m) => m.selections[0].line), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  assert.deepEqual(ms.filter((m) => m.key === 'ah').map((m) => m.selections[0].line), [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1]); // líneas de Betano.co
});

test('markets: btts.Sí con lh = la = 0 es 0 y nada sale NaN', () => {
  const ms = marketsFor('soccer', { kind: 'poisson', lh: 0, la: 0 });
  assert.equal(sel(pick(ms, 'btts'), 'Sí').p, 0);
  for (const m of ms) for (const s of m.selections) assert.ok(Number.isFinite(s.p) && Number.isFinite(s.fair) && Number.isFinite(s.oddsy), `${m.key} ${s.name}`);
  assert.equal(sel(pick(ms, 'dnb'), 'Local').p, 0.5); // sin goles no hay ganador: reparto parejo
});

test('markets: identidades entre mercados de fútbol', () => {
  const ms = marketsFor('soccer', SOCCER);
  const x = pick(ms, '1x2');
  const [H, D, A] = ['Local', 'Empate', 'Visitante'].map((n) => sel(x, n).p);
  close(sel(pick(ms, 'ah', -0.5), 'Local').p, H); // −0.5 = ganar
  close(sel(pick(ms, 'ah', 0.5), 'Local').p, H + D); // +0.5 = no perder
  close(sel(pick(ms, 'dc'), 'Local o empate').p, H + D);
  close(sel(pick(ms, 'dnb'), 'Local').p, H / (H + A));
  assert.equal(sel(pick(ms, 'ah', -1), 'Visitante').line, 1);
  const g1 = scoreGrid(SOCCER.lh, SOCCER.la), by = (f) => g1.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i - j) ? t + v : t), 0), 0);
  close(sel(pick(ms, 'ah', -1), 'Local').p, by((d) => d > 1) / (1 - by((d) => d === 1))); // ganar por 1 devuelve
  // −0.25 = media a 0 (empate devuelve) y media a −0.5: p = (H + H) / 2 / (1 − D / 2)
  close(sel(pick(ms, 'ah', -0.25), 'Local').p, H / (1 - D / 2));
  close(sel(pick(ms, 'aou', 2.25), 'Más').p, sel(pick(ms, 'ou', 2.5), 'Más').p / (1 - (g1[0][2] + g1[1][1] + g1[2][0]) / 2)); // media a 2 (2 goles devuelve) y media a 2.5
  close(sel(pick(ms, 'ou_home', 0.5), 'Menos').p, g1[0].reduce((s, v) => s + v, 0));
  const g = scoreGrid(SOCCER.lh, SOCCER.la);
  close(sel(pick(ms, 'ou', 2.5), 'Menos').p, g[0][0] + g[0][1] + g[1][0] + g[1][1] + g[0][2] + g[2][0]);
  close(sel(pick(ms, 'btts'), 'No').p, g.reduce((s, row, i) => s + row.reduce((t, v, j) => (i && j ? t : t + v), 0), 0));
});

test('markets: marcador exacto = los 10 más probables en orden, más "Otro"', () => {
  const cs = pick(marketsFor('soccer', SOCCER), 'cs');
  assert.equal(cs.selections.length, 11);
  assert.equal(cs.selections.at(-1).name, 'Otro');
  const top = cs.selections.slice(0, 10).map((s) => s.p);
  assert.deepEqual(top, [...top].sort((a, b) => b - a));
  const g = scoreGrid(SOCCER.lh, SOCCER.la);
  assert.equal(cs.selections[0].name, '1-1');
  close(cs.selections[0].p, g[1][1]);
  close(top.at(-1), g.flat().sort((a, b) => b - a)[9]);
});

test('markets: béisbol sin empate; el empate se reparte según lh/(lh+la)', () => {
  const ms = marketsFor('baseball', BASEBALL);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['ml', 'rl', 'ou']);
  const ml = pick(ms, 'ml');
  assert.deepEqual(ml.selections.map((s) => s.name), ['Local', 'Visitante']);
  assert.ok(!ml.selections.some((s) => s.name === 'Empate'));
  const g = scoreGrid(BASEBALL.lh, BASEBALL.la, { rho: 0, max: 20 });
  const P = (f) => g.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i, j) ? t + v : t), 0), 0);
  close(sel(ml, 'Local').p, P((i, j) => i > j) + P((i, j) => i === j) * (4.6 / 8.7));
  // El favorito (local) lleva −1.5: gana por 2 o más.
  const rl = pick(ms, 'rl');
  assert.equal(sel(rl, 'Local').line, -1.5);
  close(sel(rl, 'Local').p, P((i, j) => i - j >= 2));
});

test('markets: run line con visitante favorito y total de carreras sin gol extra', () => {
  const ms = marketsFor('baseball', { kind: 'poisson', lh: 3.9, la: 4.8 });
  assert.equal(pick(ms, 'rl').label, 'Hándicap de carreras');
  assert.equal(sel(pick(ms, 'rl'), 'Visitante').line, -1.5);
  assert.equal(sel(pick(ms, 'rl'), 'Local').line, 1.5);
  const g = scoreGrid(3.9, 4.8, { rho: 0, max: 20 });
  close(sel(pick(ms, 'ou'), 'Más').p, g.reduce((s, row, i) => s + row.reduce((t, v, j) => (i + j > 8.5 ? t + v : t), 0), 0));
});

test('markets: normal con mu = 0 y línea 0 da ml 0.5', () => {
  const ml = pick(marketsFor('basketball', { ...NBA, mu: 0 }), 'ml');
  close(sel(ml, 'Local').p, 0.5);
  close(sel(ml, 'Visitante').p, 0.5);
});

test('markets: spread en halfLine(-mu) para el local y total en halfLine(total)', () => {
  const ms = marketsFor('basketball', NBA);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['ml', 'spread', 'ou']);
  const sp = pick(ms, 'spread');
  assert.equal(sel(sp, 'Local').line, -5.5);
  assert.equal(sel(sp, 'Visitante').line, 5.5);
  close(sel(sp, 'Local').p, normalOver(5.2, 12, 5.5));
  const ou = pick(ms, 'ou');
  assert.equal(ou.selections[0].line, 226.5);
  close(sel(ou, 'Más').p, normalOver(226.3, 13.2, 226.5));
  // ml sin push: empate excluido y renormalizado.
  const [over, under] = [normalOver(5.2, 12, 0), normalOver(-5.2, 12, 0)];
  close(sel(pick(ms, 'ml'), 'Local').p, over / (over + under));
});

test('markets: deporte o modelo desconocido es un error', () => {
  assert.throws(() => marketsFor('curling', SOCCER), TypeError);
  assert.throws(() => marketsFor('soccer', NBA), TypeError);
  assert.throws(() => marketsFor('basketball', SOCCER), TypeError);
});

test('markets: tenis trae ml, sets, totales, hándicap de games, gana un set y primer set', () => {
  const ms = marketsFor('tennis', BO3);
  assert.deepEqual(ms.map((m) => m.key), ['ml', 'sets', 'ou_sets', 'ou_games', 'games_hcp', 'win_set', 'win_set', 'first_set']);
  const d = BO3.dist;
  close(sel(pick(ms, 'ml'), 'A').p, d.pA);
  assert.deepEqual(pick(ms, 'sets').selections.map((s) => [s.name, s.p]), Object.entries(d.sets));
  const ous = pick(ms, 'ou_sets');
  assert.equal(ous.selections[0].line, 2.5);
  close(sel(ous, 'Más').p, d.sets['2-1'] + d.sets['1-2']);
  const [a, b] = ms.filter((m) => m.key === 'win_set');
  close(sel(a, 'Sí').p, 1 - d.sets['0-2']);
  close(sel(b, 'Sí').p, 1 - d.sets['2-0']);
  close(sel(pick(ms, 'first_set'), 'A').p, d.firstSet);
});

test('markets: con set1, total de games del 1er set en 8.5, 9.5, 10.5 y 12.5; mejores apuestas solo la línea más pareja', async () => {
  const { picksOf } = await import('../lib/markets.mjs');
  const set1 = setGames(0.66, 0.62);
  const ms = marketsFor('tennis', { ...BO3, dist: { ...BO3.dist, set1 } });
  const s1 = ms.filter((m) => m.key === 'ou_set1');
  assert.deepEqual(s1.map((m) => m.selections[0].line), [8.5, 9.5, 10.5, 12.5]);
  close(sel(s1[3], 'Más').p, set1[13]); // más de 12.5 = tiebreak
  close(sel(s1[1], 'Menos').p, set1.slice(0, 10).reduce((s, p) => s + p, 0));
  for (let i = 1; i < s1.length; i++) assert.ok(sel(s1[i], 'Más').p < sel(s1[i - 1], 'Más').p);
  const even = s1.reduce((a, b) => (Math.abs(b.selections[0].p - 0.5) < Math.abs(a.selections[0].p - 0.5) ? b : a));
  const ps = picksOf('tennis', ms).filter((x) => x.market === 'ou_set1');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].label, even.label);
  assert.ok(!marketsFor('tennis', BO3).some((m) => m.key === 'ou_set1')); // sin set1 (sets cortos) no hay mercado
});

test('markets: tenis a 5 sets ofrece totales de sets 3.5 y 4.5', () => {
  const ms = marketsFor('tennis', BO5);
  const d = BO5.dist;
  assert.deepEqual(ms.filter((m) => m.key === 'ou_sets').map((m) => m.selections[0].line), [3.5, 4.5]);
  close(sel(pick(ms, 'ou_sets', 4.5), 'Más').p, d.sets['3-2'] + d.sets['2-3']);
  close(sel(pick(ms, 'ou_sets', 3.5), 'Menos').p, d.sets['3-0'] + d.sets['0-3']);
});

test('mejores apuestas: a 5 sets, un solo total de sets (la línea más pareja)', async () => {
  const { picksOf } = await import('../lib/markets.mjs');
  const ms = marketsFor('tennis', BO5);
  const ps = picksOf('tennis', ms).filter((x) => x.market === 'ou_sets');
  assert.equal(ps.length, 1);
  const even = ms.filter((m) => m.key === 'ou_sets').reduce((a, b) => (Math.abs(b.selections[0].p - 0.5) < Math.abs(a.selections[0].p - 0.5) ? b : a));
  assert.equal(ps[0].label, even.label);
});

test('markets: total de games en halfLine(media) y hándicap en halfLine(−margen medio)', () => {
  const ms = marketsFor('tennis', BO3);
  const d = BO3.dist;
  const mean = d.games.reduce((s, p, k) => s + p * k, 0);
  const ou = pick(ms, 'ou_games');
  assert.equal(ou.selections[0].line, halfLine(mean));
  close(sel(ou, 'Más').p, d.games.reduce((s, p, k) => (k > halfLine(mean) ? s + p : s), 0));
  const D = Object.entries(d.margin).map(([k, p]) => [Number(k), p]);
  const l = halfLine(-D.reduce((s, [k, p]) => s + k * p, 0));
  const hcp = pick(ms, 'games_hcp');
  assert.ok(l < 0, 'A es favorito: da games');
  assert.equal(sel(hcp, 'A').line, l);
  assert.equal(sel(hcp, 'B').line, -l);
  close(sel(hcp, 'A').p, D.reduce((s, [k, p]) => (k + l > 0 ? s + p : s), 0));
});

test('markets: tenis exige un modelo de tenis', () => {
  assert.throws(() => marketsFor('tennis', SOCCER), TypeError);
  assert.throws(() => marketsFor('soccer', BO3), TypeError);
});

test('mejores apuestas: una por mercado, escalera del resultado y solo la línea principal de goles', async () => {
  const { picksOf, minOdds } = await import('../lib/markets.mjs');
  assert.equal(minOdds(0.5), 2.1);
  assert.equal(minOdds(0.8), 1.32); // 1.3125 redondeado hacia arriba: nunca por debajo de la justa + 5%
  assert.equal(minOdds(0.7), 1.5); // 105/0.7 = 150.0000…02 en coma flotante: no debe subir a 1.51
  const ps = picksOf('soccer', marketsFor('soccer', { kind: 'poisson', lh: 2.2, la: 0.7 }));
  const keys = ps.map((p) => p.market);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['1x2', 'dnb', 'dc']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('ou_home') && !keys.includes('cs') && !keys.includes('ah'));
  assert.equal(keys.filter((k) => k === 'ou').length, 1);
  const p = (k) => ps.find((x) => x.market === k).p;
  assert.ok(p('dc') > p('dnb') && p('dnb') > p('1x2')); // blindar sube la probabilidad
  for (let i = 0; i < ps.length; i++) {
    assert.ok(ps[i].p >= 0.5 && ps[i].minOdds >= 1.05 / ps[i].p - 1e-9);
    if (i) assert.ok(ps[i - 1].p >= ps[i].p);
  }
});

test('mercados publicados: nada por encima de MAX_P (con dos lados cae el mercado; con más, solo la selección)', () => {
  for (const model of [{ kind: 'poisson', lh: 1.6, la: 0.8 }, { kind: 'poisson', lh: 2.6, la: 0.4 }]) {
    const all = marketsFor('soccer', model);
    const ms = publishable(all);
    assert.ok(all.some((m) => m.selections.some((s) => s.p > MAX_P)), 'el caso tiene selecciones que topan en 1.01');
    for (const m of ms) {
      assert.ok(m.selections.length >= 2, m.label);
      for (const s of m.selections) assert.ok(s.p <= MAX_P && s.p * s.oddsy <= 1 / 1.05 + 1e-9, `${m.label} ${s.name} ${s.p}`);
      const full = all.find((x) => x.label === m.label);
      if (full.selections.length === 2) assert.equal(m.selections.length, 2, m.label);
    }
    assert.ok(!ms.some((m) => m.label === 'Goles visitante 3.5')); // Menos 3.5 al 99%: cuota 1.01 sin margen
  }
  const ms = publishable(marketsFor('soccer', { kind: 'poisson', lh: 2.6, la: 0.4 }));
  assert.deepEqual(pick(ms, 'dc').selections.map((s) => s.name), ['Local o visitante', 'Empate o visitante']); // Local o empate al 97%
  assert.ok(!pick(ms, 'dnb') && pick(ms, '1x2').selections.length === 3);
  // Un 1X2 suma 1: sin la Local al 98% quedaría incompleto, así que cae entero (la doble oportunidad no suma 1 y se filtra).
  assert.ok(!pick(publishable(marketsFor('soccer', { kind: 'poisson', lh: 4.5, la: 0.2 })), '1x2'));
});

// ---------- getMarkets con ESPN simulado ----------
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
async function withEspn(route, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = await route(new URL(url));
    return typeof body === 'number' ? new Response('{}', { status: body }) : new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const ev = (id, date, homeId, awayId, hs, as, state = 'post') => ({
  id, date, seasonType: { type: 2 },
  competitions: [{ id, date, neutralSite: false, status: { period: 2, type: { state, completed: state === 'post' } },
    competitors: [{ homeAway: 'home', id: homeId, team: { id: homeId }, score: { value: hs } }, { homeAway: 'away', id: awayId, team: { id: awayId }, score: { value: as } }] }],
});
// Ruta de una liga simulada: lista de equipos, calendario de cada equipo con sus partidos y scoreboard/summary.
const leagueRoute = (espn, events, board) => (u) => {
  const path = u.pathname.replace(/^\/apis\/site\/v2\/sports\/[a-z]+\//, '');
  if (path === `${espn}/teams`) return { sports: [{ leagues: [{ teams: [...new Set(events.flatMap((e) => e.competitions[0].competitors.map((c) => c.id)))].map((id) => ({ team: { id } })) }] }] };
  const team = new RegExp(`^${espn}/teams/(\\d+)/schedule$`).exec(path)?.[1];
  if (team) return { events: events.filter((e) => e.competitions[0].competitors.some((c) => c.id === team)) };
  if (path === `${espn}/scoreboard`) return { events: board };
  if (path === `${espn}/summary`) {
    const e = board.find((x) => x.id === u.searchParams.get('event'));
    return e && { header: { id: e.id, competitions: [{ ...e.competitions[0], status: { type: e.competitions[0].status.type } }] } };
  }
  return null;
};

test('mercados: un partido terminado se cotiza con los ratings de antes de jugarlo (lista y detalle)', async () => {
  const day = (d) => new Date(Date.UTC(2026, 0, 3 + 7 * d, 19)).toISOString();
  const ids = ['1', '2', '3', '4'];
  const events = [];
  let k = 0;
  for (const h of ids) for (const a of ids) if (h !== a) events.push(ev(`r${k}`, day(k++), h, a, h === '2' ? 2 : 1, a === '2' ? 2 : 1));
  const g = ev('g', '2026-04-11T19:00:00.000Z', '1', '2', 5, 1); // terminado 5-1, como LaLiga 748515
  await withEspn(leagueRoute('esp.1', [...events, g], [g]), async () => {
    const results = await getSeasonResults('laliga');
    assert.ok(results.some((r) => r.id === 'g'));
    const p = (opts) => sel(pick(marketsFor('soccer', expected('soccer', ratingsFromResults(results, { sport: 'soccer', ...opts }), '1', '2')), '1x2'), 'Local').p;
    const list = await getMarkets('laliga', { date: '20260411' });
    const local = sel(pick(list.data[0].markets, '1x2'), 'Local').p;
    close(local, p({ asOf: Date.parse(g.date) }), 1e-4);
    assert.ok(p({}) - local > 0.01, 'sin su propio 5-1');
    const one = await getMarkets('laliga', { game: 'g' });
    assert.equal(sel(pick(one.data.markets, '1x2'), 'Local').p, local);
    for (const m of one.data.markets) for (const s of m.selections) assert.ok(s.p <= MAX_P, `${m.label} ${s.name}`);
  });
});

test('mercados: un partido de tenis terminado se cotiza con el Elo de antes de jugarlo', () => withEspn(
  (u) => (/\/rankings$/.test(u.pathname) ? fx('atp-rankings.json') : /\/scoreboard$/.test(u.pathname) ? fx('atp-month.json') : null),
  async () => {
    const { data } = await getMarkets('atp', { game: '182677', date: '20260913' });
    const history = await getEloHistory(); // el Elo usa la historia larga (data/atp-elo.json) más la de 24 meses
    const m = history.find((x) => x.id === '182677');
    const p = (elo) => matchProb(elo, m.a.id, m.b.id, m.surface);
    const ml = sel(pick(data.markets, 'ml'), 'A. Zverev').p; // la de matchDist: reproduce p a 1e-4
    close(ml, p(eloFrom(history, { asOf: Date.parse(m.date) })), 1e-4);
    assert.ok(p(eloFrom(history)) - ml > 0.01); // con la final ganada, Zverev subía
  },
));

test('mercados: los ratings se piden en paralelo con los partidos', async () => {
  let board = 0, other = 0, overlap = false;
  const route = leagueRoute('uefa.champions', [ev('a', '2026-03-01T19:00:00.000Z', '7', '8', 1, 0)], [ev('b', '2026-11-01T19:00:00.000Z', '7', '8', 0, 0, 'pre')]);
  await withEspn(async (u) => {
    const isBoard = u.pathname.endsWith('/scoreboard');
    isBoard ? board++ : other++;
    overlap ||= board > 0 && other > 0;
    await new Promise((r) => setTimeout(r, 5));
    isBoard ? board-- : other--;
    return route(u);
  }, async () => {
    const { data } = await getMarkets('ucl', { date: '20261101' });
    assert.equal(data.length, 1);
  });
  assert.ok(overlap);
});

test('mercados: si ESPN corta los calendarios, el error se recuerda 60 s antes de volver a pedirlos', async () => {
  let schedules = 0;
  const ok = leagueRoute('eng.1', [ev('a', '2026-03-01T19:00:00.000Z', '7', '8', 1, 0)], [ev('b', '2026-11-01T19:00:00.000Z', '7', '8', 0, 0, 'pre')]);
  const realNow = Date.now;
  await withEspn((u) => (u.pathname.endsWith('/schedule') ? (schedules++, 403) : ok(u)), async () => {
    await assert.rejects(getMarkets('epl', { date: '20261101' }), { status: 502 });
    const n = schedules;
    assert.ok(n > 0);
    await assert.rejects(getMarkets('epl', { date: '20261101' }), { status: 502 });
    assert.equal(schedules, n, 'dentro de los 60 s no se vuelve a pedir a ESPN');
    Date.now = () => realNow() + 61_000;
    try {
      await assert.rejects(getMarkets('epl', { date: '20261101' }), { status: 502 });
    } finally {
      Date.now = realNow;
    }
    assert.ok(schedules > n, 'pasados 60 s se reintenta');
  });
});
