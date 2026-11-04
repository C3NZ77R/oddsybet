// Registro de picks (lib/picklog.mjs): calificar cada mercado, razones, congelar, cerrar, rellenar, aprender y el
// registro público. Base y ESPN falsos en memoria: sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradePick, reasonOf, scoreOf, runTick, runLearn, recordOf, dayOf, sameSecret, BACKFILL_DAYS, BACKFILL_STEPS } from '../lib/picklog.mjs';
import { LEAGUES } from '../public/leagues.js';

const soc = (market, side, line, home, away, name = 'STATUS_FULL_TIME') => gradePick({ sport: 'soccer', market, side, line }, { home, away, name });
const bkb = (market, side, line, home, away) => gradePick({ sport: 'basketball', market, side, line }, { home, away, name: 'STATUS_FINAL' });
const ten = (market, side, line, sets, extra = {}) => gradePick({ sport: 'tennis', market, side, line }, { sets, winner: 'a', retired: false, ...extra });
const st = (g) => `${g.status}:${g.margin}`;

test('gradePick: fútbol, cada mercado y lado de la tabla del spec', () => {
  assert.equal(st(soc('1x2', 0, null, 2, 1)), 'ganada:1');
  assert.equal(st(soc('1x2', 1, null, 1, 1)), 'ganada:1');
  assert.equal(st(soc('1x2', 1, null, 3, 1)), 'perdida:-2');
  assert.equal(st(soc('1x2', 2, null, 2, 1)), 'perdida:-1');
  assert.equal(st(soc('dc', 0, null, 1, 1)), 'ganada:0.5');
  assert.equal(st(soc('dc', 1, null, 1, 1)), 'perdida:-0.5');
  assert.equal(st(soc('dc', 2, null, 0, 2)), 'ganada:2.5');
  assert.equal(st(soc('dnb', 0, null, 2, 0)), 'ganada:2');
  assert.equal(soc('dnb', 1, null, 1, 1).status, 'nula'); // empate: devuelve
  assert.equal(st(soc('ou', 0, 2.5, 2, 1)), 'ganada:0.5');
  assert.equal(st(soc('ou', 1, 2.5, 2, 1)), 'perdida:-0.5');
  assert.equal(st(soc('btts', 0, null, 1, 1)), 'ganada:1');
  assert.equal(st(soc('btts', 0, null, 0, 0)), 'perdida:-2');
  assert.equal(st(soc('btts', 1, null, 2, 1)), 'perdida:-1');
  assert.equal(st(soc('btts', 1, null, 3, 0)), 'ganada:1');
});

test('gradePick: básquet y tenis; devueltas, aplazados, prórroga de fútbol y retiro → nula', () => {
  assert.equal(st(bkb('ml', 1, null, 101, 99)), 'perdida:-2');
  assert.equal(st(bkb('spread', 0, -4.5, 110, 100)), 'ganada:5.5');
  assert.equal(st(bkb('spread', 1, 4.5, 110, 100)), 'perdida:-5.5');
  assert.equal(bkb('spread', 0, -10, 110, 100).status, 'nula');
  assert.equal(st(bkb('ou', 1, 220.5, 100, 99)), 'ganada:21.5');
  const sets = [[7, 6, 7, 4], [3, 6], [6, 4]]; // A gana 2-1; un set con tie-break cuenta 7-6
  assert.equal(st(ten('ml', 0, null, sets)), 'ganada:1');
  assert.equal(st(ten('first_set', 1, null, sets)), 'perdida:-1');
  assert.equal(st(ten('games_hcp', 0, -1.5, sets)), 'perdida:-1.5'); // games 16-16
  assert.equal(st(ten('ou_sets', 0, 2.5, sets)), 'ganada:0.5');
  assert.equal(st(ten('ou_games', 1, 30.5, sets)), 'perdida:-1.5');
  assert.equal(st(ten('ou_set1', 0, 12.5, sets)), 'ganada:0.5');
  assert.equal(ten('ml', 0, null, [[6, 2], [1, 0]], { retired: true }).status, 'nula');
  assert.equal(soc('1x2', 0, null, 0, 0, 'STATUS_POSTPONED').reason, 'Partido aplazado o cancelado');
  assert.equal(soc('1x2', 0, null, 2, 1, 'STATUS_FINAL_AET').status, 'nula');
  assert.equal(gradePick({ sport: 'basketball', market: 'ml', side: 0 }, { home: 100, away: 90, name: 'STATUS_FINAL_OT' }).status, 'ganada'); // básquet cuenta la prórroga
  assert.equal(scoreOf({ home: 2, away: 1 }), '2-1');
  assert.equal(scoreOf({ sets }), '7-6 3-6 6-4');
});

test('reasonOf: por poco o lejos, con las señales raras', () => {
  assert.equal(reasonOf({ sport: 'soccer', market: 'ou', x: {} }, -0.5), 'Se perdió por poco (por 1 gol)');
  assert.equal(reasonOf({ sport: 'soccer', market: '1x2', x: {} }, -2), 'Resultado lejos de lo esperado');
  assert.equal(reasonOf({ sport: 'basketball', market: 'spread', x: {} }, -3.5), 'Se perdió por poco (por 4 puntos)');
  assert.equal(reasonOf({ sport: 'basketball', market: 'ou', x: {} }, -12), 'Resultado lejos de lo esperado');
  assert.equal(reasonOf({ sport: 'tennis', market: 'ml', x: {} }, -1), 'Se perdió por poco (por 1 set)');
  assert.equal(reasonOf({ sport: 'soccer', market: 'dc', x: { few: 0.8, abs: 0.5 } }, -0.5),
    'Se perdió por poco (por 1 gol); inicio de temporada: pocos partidos para medir; bajas importantes');
});

test('sameSecret: igual, distinto y vacío', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abc', 'abd'), false);
  assert.equal(sameSecret(undefined, 'abc'), false);
  assert.equal(sameSecret('', ''), false);
});

// ---------- base y ESPN falsos ----------
function memDb(state = {}) {
  const rows = new Map();
  const models = [];
  let backfill = state;
  return {
    rows, models,
    upsertPicks: async (rs) => rs.forEach((r) => rows.set(r.id, { ...(rows.get(r.id) ?? { status: 'pendiente', source: 'live' }), ...r })),
    insertPicks: async (rs) => rs.forEach((r) => rows.has(r.id) || rows.set(r.id, { ...r })),
    dropMissing: async (league, gameId, keep) => [...rows.values()].forEach((r) => r.league === league && r.gameId === gameId && r.status === 'pendiente' && !keep.includes(r.id) && rows.delete(r.id)),
    pendingPicks: async (before) => [...rows.values()].filter((r) => r.status === 'pendiente' && r.gameStart < before).map((r) => ({ ...r })),
    rowsSince: async ({ since, sport, league, source, settled }) => [...rows.values()].filter((r) => r.gameStart >= since && (!sport || r.sport === sport)
      && (!league || r.league === league) && (!source || r.source === source) && (!settled || ['ganada', 'perdida'].includes(r.status))),
    saveModel: async (m) => models.push(m),
    latestModel: async () => models.at(-1) ?? null,
    getState: async () => backfill,
    setState: async (s) => { backfill = s; },
    state: () => backfill,
  };
}
const NOW = Date.parse('2026-11-03T20:00:00Z'); // 15:00 en Colombia
const TODAY = '20261103';
const game = (id, startMs, state = 'pre', extra = {}) => ({ id, start: new Date(startMs).toISOString(), status: { state, name: state === 'post' ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED' },
  home: { name: `Local ${id}` }, away: { name: `Visita ${id}` }, ...extra });
const pk = (market, p, extra = {}) => ({ market, label: market, name: 'Local', line: null, side: 0, raw: p, p, minOdds: 1.5, ...extra });
// deps de una sola liga (Liga BetPlay); el resto de las ligas sin partidos.
function deps(db, { board = {}, picks = {}, results = {}, past = {} } = {}) {
  const only = (map, lg, date, empty) => (lg.id === 'colombia' ? map[date] ?? empty : empty);
  return {
    db,
    games: async (lg, date) => only(board, lg, date, []),
    picks: async (lg, date) => ({ data: only(picks, lg, date, []) }),
    results: async (lg, date) => new Map(Object.entries(only(results, lg, date, {}))),
    pastPicks: async (lg, date) => ({ data: only(past, lg, date, []) }),
  };
}
const done = { league: 99, from: '20000101' }; // relleno ya terminado

test('tick: congela solo los partidos en pre que empiezan en menos de 3 h, con todo lo que se mostró', async () => {
  const db = memDb(done);
  const board = { [TODAY]: [game('a', NOW + 2 * 3_600_000), game('b', NOW + 4 * 3_600_000), game('c', NOW - 60_000, 'in')] };
  const picks = { [TODAY]: ['a', 'b', 'c'].map((id) => ({ gameId: id, x: { few: 0.2, abs: 0 }, picks: [pk('dc', 0.8, { featured: true }), pk('ou', 0.55, { line: 2.5, name: 'Menos', side: 1, raw: 0.6 })] })) };
  const out = await runTick(deps(db, { board, picks }), { now: NOW });
  assert.equal(out.frozen, 2);
  assert.deepEqual([...db.rows.keys()].sort(), ['colombia:a:dc', 'colombia:a:ou']);
  const r = db.rows.get('colombia:a:ou');
  assert.deepEqual({ p: r.p, pRaw: r.pRaw, side: r.side, line: r.line, x: r.x, espnDate: r.espnDate, featured: r.featured, home: r.home },
    { p: 0.55, pRaw: 0.6, side: 1, line: 2.5, x: { few: 0.2, abs: 0 }, espnDate: TODAY, featured: false, home: 'Local a' });
  assert.equal(db.rows.get('colombia:a:dc').featured, true);
});

test('tick: la última foto antes del inicio gana y borra el mercado que desapareció; un pick sin side no se guarda', async () => {
  const db = memDb(done);
  const board = { [TODAY]: [game('a', NOW + 2 * 3_600_000)] };
  await runTick(deps(db, { board, picks: { [TODAY]: [{ gameId: 'a', x: {}, picks: [pk('dc', 0.8), pk('1x2', 0.52)] }] } }), { now: NOW });
  await runTick(deps(db, { board, picks: { [TODAY]: [{ gameId: 'a', x: {}, picks: [pk('dc', 0.77), pk('btts', 0.6, { side: undefined })] }] } }), { now: NOW + 900_000 });
  assert.deepEqual([...db.rows.keys()], ['colombia:a:dc']);
  assert.equal(db.rows.get('colombia:a:dc').p, 0.77);
});

test('tick: cierra con el resultado, anula aplazados y, sin resultado a los 3 días, anula; nunca toca un partido sin terminar', async () => {
  const db = memDb(done);
  const start = NOW - 3 * 3_600_000;
  const base = { source: 'live', league: 'colombia', sport: 'soccer', espnDate: TODAY, status: 'pendiente', x: { few: 0.9 }, label: 'x', name: 'Local', line: null };
  await db.upsertPicks([
    { ...base, id: 'colombia:a:1x2', gameId: 'a', gameStart: new Date(start).toISOString(), market: '1x2', side: 0, p: 0.6 },
    { ...base, id: 'colombia:a:ou', gameId: 'a', gameStart: new Date(start).toISOString(), market: 'ou', side: 0, line: 2.5, p: 0.55 },
    { ...base, id: 'colombia:b:dc', gameId: 'b', gameStart: new Date(start).toISOString(), market: 'dc', side: 0, p: 0.8 },
    { ...base, id: 'colombia:c:dc', gameId: 'c', gameStart: new Date(NOW - 4 * 86_400_000).toISOString(), market: 'dc', side: 0, p: 0.8, espnDate: '20261030' },
    { ...base, id: 'colombia:d:dc', gameId: 'd', gameStart: new Date(start).toISOString(), market: 'dc', side: 0, p: 0.8 },
  ]);
  const results = { [TODAY]: { a: { home: 2, away: 1, name: 'STATUS_FULL_TIME' }, b: { home: 0, away: 0, name: 'STATUS_POSTPONED' } } };
  const out = await runTick(deps(db, { results }), { now: NOW });
  assert.equal(out.settled, 4);
  const g = (id) => db.rows.get(id);
  assert.deepEqual([g('colombia:a:1x2').status, g('colombia:a:1x2').score], ['ganada', '2-1']);
  assert.equal(g('colombia:a:ou').status, 'ganada');
  assert.equal(g('colombia:b:dc').status, 'nula');
  assert.equal(g('colombia:b:dc').reason, 'Partido aplazado o cancelado');
  assert.equal(g('colombia:c:dc').reason, 'ESPN no dio el resultado');
  assert.equal(g('colombia:d:dc').status, 'pendiente'); // sin resultado todavía y hace menos de 3 días
  results[TODAY].a = { home: 0, away: 1, name: 'STATUS_FULL_TIME' };
  await db.upsertPicks([{ ...g('colombia:a:1x2'), status: 'pendiente' }]);
  await runTick(deps(db, { results }), { now: NOW });
  assert.equal(g('colombia:a:1x2').status, 'perdida');
  assert.match(g('colombia:a:1x2').reason, /^Se perdió por poco \(por 1 gol\); inicio de temporada/);
});

test('tick: el relleno arranca en ayer y 120 días atrás, guarda backfill ya calificado y recorre una liga entera antes de la siguiente', async () => {
  const fresh = memDb();
  await runTick(deps(fresh), { now: NOW });
  assert.deepEqual(fresh.state(), { league: 0, day: '20261025', from: '20261102', until: '20260706', fails: 0 }); // 8 días de la NBA por tick
  assert.equal(BACKFILL_DAYS, 120);
  assert.equal(BACKFILL_STEPS, 8);

  const y = '20261102', col = LEAGUES.findIndex((l) => l.id === 'colombia');
  const db = memDb({ league: col, day: y, from: y, until: '20261101', fails: 0 });
  const past = { [y]: [{ gameId: 'p', x: {}, picks: [pk('dc', 0.8), pk('ou', 0.6, { line: 2.5 })] }, { gameId: 'q', x: {}, picks: [pk('dc', 0.7)] }] };
  const board = { [y]: [game('p', NOW - 30 * 3_600_000, 'post'), game('q', NOW - 30 * 3_600_000, 'post')] };
  const results = { [y]: { p: { home: 1, away: 0, name: 'STATUS_FULL_TIME' } } }; // q sin resultado: no entra
  const out = await runTick(deps(db, { board, past, results }), { now: NOW });
  assert.equal(out.backfilled, 2);
  assert.deepEqual([...db.rows.values()].map((r) => [r.id, r.source, r.status]).sort(), [['colombia:p:dc', 'backfill', 'ganada'], ['colombia:p:ou', 'backfill', 'perdida']]);
  assert.deepEqual(db.state(), { league: LEAGUES.length, day: y, from: y, until: '20261101', fails: 0 }); // colombia 2 días, atp 2 días y fin

  let asked = 0;
  const count = (d) => ({ ...d, pastPicks: async () => (asked++, { data: [] }) });
  await runTick(count(deps(db)), { now: NOW }); // terminado: no pide nada más
  await runTick(count(deps(memDb())), { now: NOW, budgetMs: 0 }); // sin plazo: no rellena
  assert.equal(asked, 0);
});

test('tick: un paso del relleno que falla se reintenta y a la tercera se salta', async () => {
  const db = memDb({ league: 0, day: '20261102', from: '20261102', until: '20260706', fails: 0 });
  const failing = { ...deps(db), pastPicks: async () => { throw new Error('ESPN caído'); } };
  await runTick(failing, { now: NOW });
  assert.equal(db.state().fails, 1);
  assert.equal(db.state().day, '20261102');
  await runTick(failing, { now: NOW });
  await runTick(failing, { now: NOW });
  assert.equal(db.state().day, '20261101');
});

test('learn: lee las filas cerradas por deporte y guarda un modelo válido', async () => {
  const db = memDb(done);
  await db.insertPicks(Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, source: 'backfill', sport: 'soccer', league: 'colombia', market: 'dc', pRaw: 0.8, x: {},
    status: i % 3 ? 'ganada' : 'perdida', gameStart: new Date(NOW - i * 86_400_000).toISOString() })));
  const out = await runLearn({ db }, { now: NOW });
  assert.equal(out.soccer.status, 'pocos_datos');
  assert.equal(out.soccer.n, 30);
  assert.equal(db.models.length, 1);
  assert.deepEqual(Object.keys(db.models[0].sports).sort(), ['basketball', 'soccer', 'tennis']);
});

test('registro: ayer 7 de 10 con el pick del partido; backfill y picks no destacados no cuentan en el "7 de 10"', () => {
  const y = Date.parse('2026-11-02T23:00:00Z'); // 18:00 del 2 nov en Colombia
  const row = (i, status, extra = {}) => ({ id: `r${i}`, source: 'live', league: 'colombia', sport: 'soccer', market: 'dc', label: 'Doble oportunidad', name: 'Local o empate',
    line: null, p: 0.75, featured: true, status, score: '1-0', reason: status === 'perdida' ? 'Resultado lejos de lo esperado' : null, home: 'A', away: 'B',
    gameStart: new Date(y + i * 60_000).toISOString(), ...extra });
  const rows = [...Array.from({ length: 7 }, (_, i) => row(i, 'ganada')), ...Array.from({ length: 3 }, (_, i) => row(10 + i, 'perdida')),
    row(20, 'pendiente'), row(21, 'perdida', { featured: false, market: 'ou', p: 0.55 }), row(22, 'perdida', { source: 'backfill' }), row(23, 'ganada', { featured: false, p: 0.45, market: 'btts' })];
  const model = { at: '2026-11-03T09:20:00Z', sports: { soccer: { status: 'en_uso', n: 900, nTest: 200, llBase: 0.6, llModel: 0.58 } } };
  const r = recordOf(rows, model, 'colombia', NOW);
  assert.equal(r.day.date, '2026-11-02');
  assert.equal(r.day.yesterday, true);
  assert.equal(r.day.picks.length, 11); // los 10 cerrados y el pendiente; el backfill nunca
  assert.deepEqual({ won: r.windows[0].won, lost: r.windows[0].lost, hit: r.windows[0].hit, promised: r.windows[0].promised }, { won: 7, lost: 3, hit: 0.7, promised: 0.75 });
  assert.deepEqual({ won: r.all.won, lost: r.all.lost }, { won: 7, lost: 4 }); // todos los mostrados (p ≥ 0.5): suma el de ou
  assert.deepEqual(r.markets.map((m) => [m.market, m.n]), [['dc', 10], ['ou', 1]]);
  assert.deepEqual(r.model, { at: model.at, status: 'en_uso', n: 900, nTest: 200, llBase: 0.6, llModel: 0.58 });
  assert.equal(r.since, '2026-11-02');
});

test('registro: sin filas → since null y sin día; un día de hace más de 7 días no es "ayer"', () => {
  const empty = recordOf([], null, 'nba', NOW);
  assert.deepEqual([empty.since, empty.day, empty.windows[0].won, empty.model], [null, null, 0, null]);
  const old = recordOf([{ source: 'live', featured: true, status: 'ganada', p: 0.8, market: 'ml', gameStart: '2026-10-20T23:00:00Z' }], null, 'nba', NOW);
  assert.equal(old.day, null);
  assert.equal(old.since, '2026-10-20');
  assert.equal(dayOf(Date.parse('2026-11-03T03:00:00Z')), '2026-11-02'); // 22:00 del 2 nov en Colombia
});
