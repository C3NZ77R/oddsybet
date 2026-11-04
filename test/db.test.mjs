// Seguimiento: cliente REST de Supabase (lib/db.mjs) con fetch simulado. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb } from '../lib/db.mjs';

// fetch falso: registra cada petición y responde con lo que devuelva answer(url, init).
function fake(answer = () => []) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const out = answer(u, init);
    return out instanceof Response ? out : new Response(out === undefined ? null : JSON.stringify(out), { status: out === undefined ? 204 : 200 });
  };
  return { calls, db: createDb({ url: 'https://x.supabase.co', key: 'srv', fetch }) };
}
const ID = '11111111-2222-4333-8444-555555555555';
const selRow = { id: 's1', bet_id: 'b1', league: 'nba', game_id: '401', game_start: '2026-11-03T02:00:00+00:00', market: 'prop', stat: 'pts',
  athlete_id: '3112335', athlete_name: 'Nikola Jokić', side: 'Over', line: 24.5, odds: 1.85, label: 'Jokić · Más de 24.5 puntos', prior: null,
  status: 'pendiente', current: null, state: {} };

test('createDevice: POST con return=representation y headers de la service key', async () => {
  const { calls, db } = fake(() => [{ id: ID }]);
  assert.deepEqual(await db.createDevice({ secretHash: 'h', subscription: { endpoint: 'e' }, platform: 'android' }), { id: ID });
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url.pathname, '/rest/v1/track_devices');
  assert.equal(c.headers.prefer, 'return=representation');
  assert.equal(c.headers.apikey, 'srv');
  assert.equal(c.headers.authorization, 'Bearer srv');
  assert.deepEqual(c.body, { secret_hash: 'h', subscription: { endpoint: 'e' }, platform: 'android' });
});

test('getDevice: id que no es uuid → null sin pedir nada', async () => {
  const { calls, db } = fake(() => [{ id: ID, secret_hash: 'h', subscription: {}, last_seen_at: 'x' }]);
  assert.equal(await db.getDevice('nada'), null);
  assert.equal(calls.length, 0);
  assert.equal((await db.getDevice(ID)).secretHash, 'h');
});

test('activeBets: filtra por estado activo y devuelve camelCase con el dispositivo', async () => {
  const { calls, db } = fake(() => [{ id: 'b1', device_id: ID, book: null, odds: 3.4, status: 'en_juego', notified: { start: true }, created_at: 'c', settled_at: null,
    track_selections: [selRow], track_devices: { id: ID, subscription: { endpoint: 'e' } } }]);
  const [b] = await db.activeBets();
  assert.equal(calls[0].url.searchParams.get('status'), 'in.(pendiente,en_juego)');
  assert.equal(b.deviceId, ID);
  assert.deepEqual(b.device, { id: ID, subscription: { endpoint: 'e' } });
  assert.equal(b.selections[0].betId, 'b1');
  assert.equal(b.selections[0].athleteId, '3112335');
  assert.equal(b.selections[0].gameStart, '2026-11-03T02:00:00+00:00');
  assert.deepEqual(b.notified, { start: true });
});

test('createBet: guarda la apuesta y sus selecciones; si fallan las selecciones, borra la apuesta', async () => {
  const sel = { gameId: '401', gameStart: selRow.game_start, market: 'prop', stat: 'pts', athleteId: '3112335', athleteName: 'Nikola Jokić', side: 'Over',
    line: 24.5, odds: 1.85, label: selRow.label, prior: null, status: 'pendiente' };
  const ok = fake((u) => (u.pathname.endsWith('track_bets') ? [{ id: 'b1', device_id: ID, book: 'Betplay', odds: null, status: 'pendiente', notified: {} }] : [selRow]));
  const bet = await ok.db.createBet(ID, { book: 'Betplay', odds: null }, [sel]);
  assert.equal(bet.id, 'b1');
  assert.equal(bet.selections[0].label, selRow.label);
  assert.equal(ok.calls[1].body[0].bet_id, 'b1');
  assert.equal(ok.calls[1].body[0].athlete_id, '3112335');

  const bad = fake((u, init) => (u.pathname.endsWith('track_selections') ? new Response('{}', { status: 400 }) : init.method === 'DELETE' ? undefined : [{ id: 'b1' }]));
  await assert.rejects(bad.db.createBet(ID, {}, [sel]), (e) => e.status === 502);
  assert.equal(bad.calls.at(-1).method, 'DELETE');
  assert.equal(bad.calls.at(-1).url.searchParams.get('id'), 'eq.b1');
});

test('deleteBet: solo del propio dispositivo; true si borró', async () => {
  const { calls, db } = fake(() => [{ id: 'b1' }]);
  const BET = '99999999-2222-4333-8444-555555555555';
  assert.equal(await db.deleteBet(ID, BET), true);
  assert.equal(calls[0].url.searchParams.get('device_id'), `eq.${ID}`);
  assert.equal(await fake(() => []).db.deleteBet(ID, BET), false);
  assert.equal(await db.deleteBet(ID, 'nada'), false); // id inventado: no se pide nada
  assert.equal(calls.length, 1);
});

test('saveBet y saveSelections: escriben en snake_case', async () => {
  const { calls, db } = fake(() => undefined);
  await db.saveBet({ id: 'b1', status: 'ganada', notified: { final: true }, settledAt: '2026-11-03T05:00:00Z' });
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { status: 'ganada', notified: { final: true }, settled_at: '2026-11-03T05:00:00Z' });
  await db.saveSelections([{ id: 's1', betId: 'b1', status: 'cumplida', current: 26, state: { near: true }, label: 'x', market: 'prop' }]);
  assert.equal(calls[1].headers.prefer, 'resolution=merge-duplicates');
  assert.equal(calls[1].body[0].bet_id, 'b1');
  assert.deepEqual(calls[1].body[0].state, { near: true });
});

test('bumpReads, takeLease y releaseLease por RPC', async () => {
  const { calls, db } = fake((u) => (u.pathname.endsWith('track_bump') ? false : u.pathname.endsWith('track_take_lease') ? true : undefined));
  assert.equal(await db.bumpReads('2026-11-02', ['global', 'device:x'], [500, 20]), false);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/track_bump');
  assert.deepEqual(calls[0].body, { p_day: '2026-11-02', p_keys: ['global', 'device:x'], p_limits: [500, 20] });
  assert.equal(await db.takeLease(55), true);
  assert.deepEqual(calls[1].body, { p_seconds: 55 });
  await db.releaseLease();
  assert.equal(calls[2].url.pathname, '/rest/v1/track_lease');
});

test('un 500 de Supabase o la red caída → 502', async () => {
  await assert.rejects(fake(() => new Response('x', { status: 500 })).db.listBets(ID), (e) => e.status === 502 && e.message === 'No se pudo guardar el seguimiento');
  const down = createDb({ url: 'https://x.supabase.co', key: 'k', fetch: async () => { throw new Error('red'); } });
  await assert.rejects(down.activeBets(), (e) => e.status === 502);
});

test('migración: tablas, RLS, funciones y purga', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261031000000_track.sql', import.meta.url), 'utf8');
  for (const t of ['track_devices', 'track_bets', 'track_selections', 'track_reads', 'track_lease']) {
    assert.match(sql, new RegExp(`create table ${t}`));
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
  }
  assert.match(sql, /function track_bump\(p_day date, p_keys text\[\], p_limits int\[\]\)/);
  assert.match(sql, /function track_take_lease\(p_seconds int\)/);
  assert.match(sql, /cron\.schedule\('oddsy-track-purge', '17 9 \* \* \*'/);
});

// ---------- registro de picks ----------
test('registro: upsertPicks sobrescribe, insertPicks ignora repetidos, ambos en snake_case', async () => {
  const { calls, db } = fake(() => undefined);
  const row = { id: 'nba:401:ml', league: 'nba', gameId: '401', pRaw: 0.7, minOdds: 1.5, x: { fewNow: 1 } };
  await db.upsertPicks([row]);
  await db.insertPicks([row]);
  assert.equal(calls[0].url.pathname, '/rest/v1/pick_log');
  assert.equal(calls[0].url.searchParams.get('on_conflict'), 'id');
  assert.equal(calls[0].headers.prefer, 'resolution=merge-duplicates');
  assert.equal(calls[1].headers.prefer, 'resolution=ignore-duplicates');
  assert.deepEqual(calls[0].body[0], { id: 'nba:401:ml', league: 'nba', game_id: '401', p_raw: 0.7, min_odds: 1.5, x: { fewNow: 1 } }); // jsonb tal cual
  await db.upsertPicks([]);
  assert.equal(calls.length, 2); // sin filas no se pide nada
});

test('registro: dropMissing borra los pendientes del partido que no siguen', async () => {
  const { calls, db } = fake(() => undefined);
  await db.dropMissing('nba', '401', ['nba:401:ml', 'nba:401:ou']);
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(q.get('league'), 'eq.nba');
  assert.equal(q.get('game_id'), 'eq.401');
  assert.equal(q.get('status'), 'eq.pendiente');
  assert.equal(q.get('id'), 'not.in.("nba:401:ml","nba:401:ou")');
  await db.dropMissing('nba', '401', []);
  assert.equal(calls[1].url.searchParams.get('id'), null); // sin picks nuevos: todos los pendientes del partido
});

test('registro: rowsSince pagina de a 1 000 hasta una página corta y devuelve camelCase', async () => {
  const page = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, p_raw: 0.6, game_start: '2026-10-01T00:00:00Z' }));
  const { calls, db } = fake((u) => (u.searchParams.get('offset') === '0' ? page(1000) : page(3)));
  const rows = await db.rowsSince({ since: '2026-07-05T00:00:00.000Z', select: 'p_raw,status', sport: 'soccer', settled: true });
  assert.equal(rows.length, 1003);
  assert.equal(rows[0].pRaw, 0.6);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('offset')), ['0', '1000']);
  const q = calls[0].url.searchParams;
  assert.equal(q.get('game_start'), 'gte.2026-07-05T00:00:00.000Z');
  assert.equal(q.get('sport'), 'eq.soccer');
  assert.equal(q.get('status'), 'in.(ganada,perdida)');
  assert.equal(q.get('select'), 'p_raw,status');
});

test('registro: modelo y estado del relleno', async () => {
  const { calls, db } = fake((u) => (u.pathname.endsWith('pick_model') ? [{ model: { version: 1 } }] : u.pathname.endsWith('pick_state') ? [{ backfill: { day: '20261102' } }] : undefined));
  assert.deepEqual(await db.latestModel(), { version: 1 });
  assert.deepEqual(await db.getState(), { day: '20261102' });
  await db.setState({ day: '20261101' });
  assert.equal(calls[2].method, 'PATCH');
  assert.deepEqual(calls[2].body, { backfill: { day: '20261101' } });
  assert.equal(await fake(() => []).db.latestModel(), null);
});

test('registro: dbFromEnv solo con las dos variables', async () => {
  const { dbFromEnv } = await import('../lib/db.mjs');
  assert.equal(dbFromEnv({}), null);
  assert.equal(dbFromEnv({ SUPABASE_URL: 'https://x.supabase.co' }), null);
  assert.equal(typeof dbFromEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }).upsertPicks, 'function');
});

test('migración del registro: tablas, RLS y purga', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261103000000_picklog.sql', import.meta.url), 'utf8');
  for (const t of ['pick_log', 'pick_model', 'pick_state']) {
    assert.match(sql, new RegExp(`create table ${t}`));
    assert.match(sql, new RegExp(`alter table ${t} enable row level security`));
  }
  assert.match(sql, /cron\.schedule\('oddsy-picks-purge', '40 9 \* \* \*'/);
});
