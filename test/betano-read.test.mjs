// Lecturas de Betano (lib/betano-read.mjs) y su ruta POST /api/betano/ingest. Base falsa en memoria: sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, loadReads } from '../lib/betano-read.mjs';
import { gameFor } from '../public/betano.js';
import { handler } from '../server.mjs';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 3600 * 1000;
const T = Date.parse('2026-11-21T15:30:00Z');
const ev = (name, t, ml = [1.47, 4.7, 6.5]) => [name, t, [], [['MRES', [['1', ml[0]], ['X', ml[1]], ['2', ml[2]]]]]];

// Lo que lib/db.mjs hace contra betano_read: upsert por clave y lectura por ventana de inicio.
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    reads: 0,
    fail: false,
    async saveBetanoReads(list) { for (const r of list) rows.set(r.key, r); },
    async betanoReads(from, to) {
      this.reads++;
      if (this.fail) throw new Error('caída');
      return [...rows.values()].filter((r) => r.startAt >= from && r.startAt < to).map((r) => ({ game: r.game, readAt: r.readAt }));
    },
  };
}

test('ingest guarda una fila por partido y la lectura siguiente la actualiza', async () => {
  const db = fakeDb();
  assert.deepEqual(await ingest(db, [ev('Manchester City - Fulham', T), ev('Atlético Nacional - Millonarios', T + HOUR)], { now: NOW }), { saved: 2 });
  const row = db.rows.get(`${T}|manchestercity|fulham`);
  assert.deepEqual(row, {
    key: `${T}|manchestercity|fulham`, startAt: '2026-11-21T15:30:00.000Z', team1: 'Manchester City', team2: 'Fulham',
    game: { t: T, teams: ['Manchester City', 'Fulham'], ou: [], ml: [1.47, 4.7, 6.5] }, readAt: '2026-11-20T12:00:00.000Z',
  });
  assert.ok(db.rows.has(`${T + HOUR}|atleticonacional|millonarios`)); // sin tildes: la clave no cambia si Betano las quita

  // Misma clave aunque cambien mayúsculas y espacios; la cuota y la hora de lectura son las nuevas.
  assert.deepEqual(await ingest(db, [ev('MANCHESTER CITY  -  Fulham', T, [1.5, 4.5, 6])], { now: NOW + HOUR }), { saved: 1 });
  assert.equal(db.rows.size, 2);
  assert.deepEqual(db.rows.get(`${T}|manchestercity|fulham`).game.ml, [1.5, 4.5, 6]);
  assert.equal(db.rows.get(`${T}|manchestercity|fulham`).readAt, '2026-11-20T13:00:00.000Z');
});

test('ingest descarta la basura, lo que cae fuera de la ventana y lo que pasa de 1 MB', async () => {
  const db = fakeDb();
  const junk = ['basura', null, ['Sin guion', T, [], []], ['A - B', 'x', [], []], ['A - B', T, [], []], // sin mercados
    ev(' - ', T), ev('Viejo - Partido', NOW - 13 * HOUR), ev('Muy - Lejos', NOW + 8 * 24 * HOUR), ev('Fecha - Imposible', 1e300),
    ev('A - B', T), ev('a - b', T)]; // la misma clave dos veces: una sola fila
  assert.deepEqual(await ingest(db, junk, { now: NOW }), { saved: 1 });
  assert.deepEqual([...db.rows.keys()], [`${T}|a|b`]);
  for (const bad of [null, undefined, 'x', {}, 7]) assert.deepEqual(await ingest(db, bad, { now: NOW }), { saved: 0 });
  await assert.rejects(ingest(db, [['A - B', T, [], [null]]], { now: NOW }), (e) => e.status === 400); // gamesOf lanza
  await assert.rejects(ingest(db, [ev('A - B', T), 'x'.repeat(1 << 20)], { now: NOW }), (e) => e.status === 413);
  assert.equal(db.rows.size, 1);
});

test('loadReads respeta la ventana, le sirve a gameFor, guarda memo 5 minutos y aguanta la base caída', async () => {
  const db = fakeDb();
  await ingest(db, [ev('Manchester City - Fulham', T), ev('Empezo - Hace once', NOW - 11 * HOUR)], { now: NOW });
  const b = await loadReads(db, { now: NOW });
  assert.deepEqual(b.games.map((g) => g.teams[0]).sort(), ['Empezo', 'Manchester City']);
  const hit = gameFor(b, { start: '2026-11-21T15:30:00Z', home: { name: 'Manchester City' }, away: { name: 'Fulham' } });
  assert.deepEqual(hit.g, { t: T, teams: ['Manchester City', 'Fulham'], ou: [], ml: [1.47, 4.7, 6.5], at: NOW });
  assert.equal(hit.flip, false);

  // Memo: dentro de los 5 minutos no vuelve a la base; después sí, y el que ya salió de la ventana no vuelve.
  assert.equal(await loadReads(db, { now: NOW + 4 * 60 * 1000 }), b);
  assert.equal(db.reads, 1);
  const later = await loadReads(db, { now: NOW + 2 * HOUR });
  assert.equal(db.reads, 2);
  assert.deepEqual(later.games.map((g) => g.teams[0]), ['Manchester City']);

  // Una lectura nueva tira el memo; con la base caída sale vacío y no se guarda ese vacío.
  await ingest(db, [ev('Manchester City - Fulham', T, [1.6, 4, 5])], { now: NOW + 2 * HOUR });
  assert.deepEqual((await loadReads(db, { now: NOW + 2 * HOUR })).games[0].ml, [1.6, 4, 5]);
  await ingest(db, [], { now: NOW });
  db.fail = true;
  const err = console.error;
  console.error = () => {};
  try { assert.deepEqual(await loadReads(db, { now: NOW }), { games: [] }); } finally { console.error = err; }
  db.fail = false;
  assert.equal((await loadReads(db, { now: NOW })).games.length, 2);
});

// ---------- la ruta ----------
async function send(method, path, { secret, body } = {}) {
  let status, out;
  const res = { writeHead(s) { status = s; return this; }, end(b) { out = b ? JSON.parse(b) : null; } };
  await handler({ url: path, method, headers: { 'content-type': 'application/json', ...(secret && { 'x-tick-secret': secret }) }, body }, res);
  return { status, body: out };
}
// Vercel corre este test en el build con las variables de producción puestas: cada caso pone o quita las suyas.
const ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TRACK_TICK_SECRET'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const SET = { SUPABASE_URL: 'https://falsa.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'llave', TRACK_TICK_SECRET: 'secreto-de-prueba' };

test('POST /api/betano/ingest: 405 con otro método, 503 sin configurar, 401 con secreto malo, 404 y 413', async () => {
  await withEnv({}, async () => {
    assert.equal((await send('GET', '/api/betano/ingest')).status, 405);
    assert.equal((await send('POST', '/api/betano/ingest', { secret: 'x', body: { events: [] } })).status, 503);
  });
  await withEnv({ SUPABASE_URL: SET.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'llave' }, async () => { // la base sola no basta: sin secreto nadie entra
    assert.equal((await send('POST', '/api/betano/ingest', { body: { events: [] } })).status, 503);
  });
  await withEnv(SET, async () => {
    assert.equal((await send('POST', '/api/betano/ingest', { body: { events: [] } })).status, 401);
    assert.equal((await send('POST', '/api/betano/ingest', { secret: 'otro', body: { events: [] } })).status, 401);
    assert.equal((await send('POST', '/api/betano/otra', { secret: SET.TRACK_TICK_SECRET, body: {} })).status, 404);
    assert.equal((await send('POST', '/api/betano/ingest', { secret: SET.TRACK_TICK_SECRET, body: { events: ['x'.repeat(1 << 20)] } })).status, 413);
  });
});

test('POST /api/betano/ingest con el secreto bueno hace el upsert en betano_read', async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(''); };
  try {
    await withEnv(SET, async () => {
      const r = await send('POST', '/api/betano/ingest', { secret: SET.TRACK_TICK_SECRET, body: { events: [ev('Manchester City - Fulham', Date.now() + HOUR)] } });
      assert.deepEqual(r, { status: 200, body: { saved: 1 } });
    });
  } finally { globalThis.fetch = real; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://falsa.supabase.test/rest/v1/betano_read?on_conflict=key');
  assert.equal(calls[0].init.headers.prefer, 'resolution=merge-duplicates');
  const [row] = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(row).sort(), ['game', 'key', 'read_at', 'start_at', 'team1', 'team2']);
});
