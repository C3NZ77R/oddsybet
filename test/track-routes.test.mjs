// Seguimiento: rutas /api/track/* (lib/track-routes.mjs) con base de datos, push, Gemini y ESPN falsos. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTrack, trackFromEnv } from '../lib/track-routes.mjs';

function memDb() {
  const devices = new Map(), bets = [];
  let n = 0;
  return {
    devices, bets, readsOk: true, bumps: [], touches: 0,
    async createDevice(d) { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; devices.set(id, { id, ...d }); return { id }; },
    async getDevice(id) { return devices.get(id) ?? null; },
    async touchDevice(id, patch = {}) { this.touches++; Object.assign(devices.get(id), patch, { lastSeenAt: new Date(Date.now()).toISOString() }); },
    async bumpReads(...args) { this.bumps.push(args); return this.readsOk; },
    async createBet(deviceId, meta, selections) { const b = { id: `b${bets.length + 1}`, deviceId, ...meta, status: 'pendiente', notified: {}, selections }; bets.push(b); return b; },
    async listBets(deviceId) { return bets.filter((b) => b.deviceId === deviceId); },
    async deleteBet(deviceId, id) { const i = bets.findIndex((b) => b.id === id && b.deviceId === deviceId); if (i < 0) return false; bets.splice(i, 1); return true; },
  };
}

const team = (id, abbr, name) => ({ id, abbr, name });
const g = (id, state, name = null) => ({ id, start: '2026-11-03T02:00:00Z', status: { state, name }, home: team('7', 'DEN', 'Denver Nuggets'), away: team('13', 'LAL', 'Los Angeles Lakers') });
const ROSTERS = { 7: [{ id: '3112335', name: 'Nikola Jokić', short: 'N. Jokić', teamId: '7' }], 13: [{ id: '1966', name: 'LeBron James', short: 'L. James', teamId: '13' }] };
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' }, expirationTime: null };

function setup({ sendOk = true, props = async () => [{ athleteId: '3112335', stat: 'pts', side: 'Over', mean: 26, variance: 40, kind: 'normal' }], priorMs, now } = {}) {
  const db = memDb(), sent = [], reads = [], ticks = [];
  const track = createTrack({
    db,
    push: { send: async (sub, msg) => { sent.push({ sub, msg }); return { ok: sendOk, gone: false }; } },
    readTicket: async (input) => { reads.push(input); return { book: 'Betplay', odds: '3,40', legs: [{ text: 'Jokić Más de 24,5', sport: 'basketball', teams: ['Nuggets', 'Lakers'], team: null, player: 'N. Jokic', market: 'prop', stat: 'pts', side: 'Over', line: '24,5', odds: '1,85' }] }; },
    nba: { games: async () => [g('401', 'pre'), g('402', 'in'), g('403', 'post'), g('404', 'post', 'STATUS_POSTPONED')], roster: async (id) => ROSTERS[id] ?? [], props },
    limits: { device: 20, ip: 40, global: 100 },
    vapidPublicKey: 'BPub',
    tickSecret: 'tick-secreto',
    runTick: async () => { ticks.push(1); return { bets: 0, pushes: 0, skippedGames: 0 }; },
    priorMs,
    now,
  });
  const call = (method, path, { body = null, headers = {}, query = '' } = {}) => track.handle({ method, path, query: new URLSearchParams(query), headers, body });
  async function device() {
    const r = await call('POST', 'device', { body: { subscription: SUB, platform: 'android' } });
    return { 'x-device-id': r.body.deviceId, 'x-device-secret': r.body.secret, 'x-forwarded-for': '1.2.3.4, 10.0.0.1' };
  }
  return { db, sent, reads, ticks, call, device };
}
const prop = (o = {}) => ({ market: 'prop', gameId: '401', stat: 'pts', athleteId: '3112335', side: 'Over', line: 24.5, odds: 1.85, ...o });

test('GET vapid: la llave pública', async () => {
  const { call } = setup();
  assert.deepEqual((await call('GET', 'vapid')).body, { publicKey: 'BPub' });
});

test('POST device: endpoint conocido, aviso de prueba entregado y secreto hasheado', async () => {
  const bad = setup();
  assert.equal((await bad.call('POST', 'device', { body: { subscription: { ...SUB, endpoint: 'https://evil.com/x' } } })).status, 400);
  assert.equal(bad.sent.length, 0);

  const refused = setup({ sendOk: false });
  assert.equal((await refused.call('POST', 'device', { body: { subscription: SUB } })).status, 400);
  assert.equal(refused.db.devices.size, 0);

  const ok = setup();
  const r = await ok.call('POST', 'device', { body: { subscription: SUB, platform: 'android' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.deviceId && r.body.secret);
  assert.equal(ok.sent[0].msg.title, 'Avisos activados');
  const saved = ok.db.devices.get(r.body.deviceId);
  assert.equal(saved.secretHash, createHash('sha256').update(r.body.secret).digest('hex'));
  assert.ok(!JSON.stringify(saved).includes(r.body.secret));
  assert.deepEqual(saved.subscription, { endpoint: SUB.endpoint, keys: SUB.keys });

  // Con id y secreto: actualiza la suscripción del mismo dispositivo.
  const headers = { 'x-device-id': r.body.deviceId, 'x-device-secret': r.body.secret };
  const upd = await ok.call('POST', 'device', { headers, body: { subscription: { ...SUB, endpoint: 'https://fcm.googleapis.com/fcm/send/nuevo' } } });
  assert.equal(upd.status, 200);
  assert.equal(ok.db.devices.size, 1);
  assert.equal(saved.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/nuevo');
});

test('POST read: autenticación, límites, tamaño y borrador sin guardar nada', async () => {
  const t = setup();
  assert.equal((await t.call('POST', 'read', { body: { text: 'x' } })).status, 401);
  const headers = await t.device();
  assert.equal((await t.call('POST', 'read', { headers: { ...headers, 'x-device-secret': 'otro' }, body: { text: 'x' } })).body.error, 'Activa los avisos otra vez');

  const big = Buffer.alloc(2 * 1024 * 1024 + 10).toString('base64');
  assert.equal((await t.call('POST', 'read', { headers, body: { image: big } })).status, 413);
  assert.equal(t.db.bumps.length, 0); // la foto pesada no gasta lecturas

  t.db.readsOk = false;
  assert.equal((await t.call('POST', 'read', { headers, body: { image: 'QUJD' } })).status, 429);
  const [day, keys, limits] = t.db.bumps[0];
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(keys, ['global', `device:${headers['x-device-id']}`, 'ip:1.2.3.4']);
  assert.deepEqual(limits, [100, 20, 40]);

  t.db.readsOk = true;
  const r = await t.call('POST', 'read', { headers, body: { image: 'QUJD' } });
  assert.equal(r.status, 200);
  assert.deepEqual(t.reads.at(-1), { image: 'QUJD' });
  assert.equal(r.body.book, 'Betplay');
  assert.equal(r.body.odds, 3.4);
  assert.equal(r.body.selections[0].athleteId, '3112335');
  assert.equal(r.body.selections[0].tracked, true);
  assert.equal(t.db.bets.length, 0);
});

test('POST bets: revalida contra ESPN y guarda con el prior del prop', async () => {
  const t = setup();
  const headers = await t.device();
  const post = (selections, extra = {}) => t.call('POST', 'bets', { headers, body: { selections, ...extra } });

  assert.equal((await post([prop({ gameId: '403' })])).body.error, 'El partido ya terminó');
  assert.equal((await post([prop({ gameId: '404' })])).body.error, 'El partido se aplazó o se suspendió');
  assert.equal((await post([prop({ gameId: '999' })])).body.error, 'No encontré el partido'); // WNBA u otro: no está en la lista de la NBA
  assert.equal((await post([prop({ athleteId: '42' })])).body.error, 'No encontré al jugador');
  assert.equal((await post([prop({ stat: 'fga' })])).body.error, 'Mercado que Oddsy no sigue');
  assert.equal((await post([prop({ side: 'Arriba' })])).status, 400);
  assert.equal((await post([prop({ line: 'mucho' })])).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await post(Array(21).fill(prop()))).status, 400);
  assert.equal(t.db.bets.length, 0);

  const r = await post([prop({ gameId: '402', label: 'texto del navegador' }), { market: 'other', label: 'Primer cuarto: Nuggets', status: 'no_seguida' }], { book: 'Betplay', odds: 3.4 });
  assert.equal(r.status, 200);
  const [s, skip] = t.db.bets[0].selections;
  assert.equal(s.label, 'Jokić · Más de 24.5 puntos'); // la arma el servidor
  assert.equal(s.athleteName, 'Nikola Jokić');
  assert.equal(s.gameStart, '2026-11-03T02:00:00Z');
  assert.deepEqual(s.prior, { mean: 26, variance: 40, kind: 'normal' });
  assert.equal(s.status, 'pendiente');
  assert.equal(skip.status, 'no_seguida');
  assert.equal(skip.label, 'Primer cuarto: Nuggets');
  assert.equal(t.db.bets[0].book, 'Betplay');

  const ml = await post([{ market: 'ml', gameId: '401', side: 'away' }]);
  assert.equal(t.db.bets[1].selections[0].label, 'Gana Lakers');
  assert.equal(ml.status, 200);
});

test('POST bets: si los props tardan, se guarda sin prior', async () => {
  const t = setup({ props: () => new Promise(() => {}), priorMs: 20 });
  const headers = await t.device();
  const r = await t.call('POST', 'bets', { headers, body: { selections: [prop()] } });
  assert.equal(r.status, 200);
  assert.equal(t.db.bets[0].selections[0].prior, null);
});

test('GET y DELETE bets: solo las del propio dispositivo', async () => {
  const t = setup();
  const mine = await t.device(), other = await t.device();
  await t.call('POST', 'bets', { headers: mine, body: { selections: [prop()] } });
  assert.equal((await t.call('GET', 'bets', { headers: mine })).body.bets.length, 1);
  assert.equal((await t.call('GET', 'bets', { headers: other })).body.bets.length, 0);
  assert.equal((await t.call('DELETE', 'bets', { headers: other, query: 'id=b1' })).status, 404);
  assert.equal((await t.call('DELETE', 'bets', { headers: mine, query: 'id=b1' })).status, 204);
});

test('POST tick: solo con el secreto', async () => {
  const t = setup();
  assert.equal((await t.call('POST', 'tick')).status, 401);
  assert.equal((await t.call('POST', 'tick', { headers: { 'x-tick-secret': 'otro' } })).status, 401);
  assert.equal(t.ticks.length, 0);
  assert.equal((await t.call('POST', 'tick', { headers: { 'x-tick-secret': 'tick-secreto' } })).status, 200);
  assert.equal(t.ticks.length, 1);
});

test('rutas y métodos desconocidos', async () => {
  const t = setup();
  assert.equal((await t.call('GET', 'nada')).status, 404);
  assert.equal((await t.call('PUT', 'bets')).status, 405);
});

test('trackFromEnv: null si falta alguna variable', () => {
  assert.equal(trackFromEnv({}), null);
  const env = { GEMINI_API_KEY: 'g', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:a@b.co', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', TRACK_TICK_SECRET: 't' };
  assert.ok(trackFromEnv(env));
  assert.equal(trackFromEnv({ ...env, TRACK_TICK_SECRET: '' }), null);
});

test('POST tick: sin runTick inyectado usa el tick real (aquí sin candado, no hace nada)', async () => {
  const db = { takeLease: async () => false };
  const track = createTrack({ db, push: {}, readTicket: null, nba: {}, limits: {}, tickSecret: 's' });
  const r = await track.handle({ method: 'POST', path: 'tick', headers: { 'x-tick-secret': 's' } });
  assert.deepEqual(r, { status: 200, body: { bets: 0, pushes: 0, skippedGames: 0 } });
});

test('auth: last_seen_at se escribe a lo más una vez al día; la cuota de lecturas cuenta el día del Pacífico (el de Gemini)', async () => {
  const t = setup({ now: () => Date.parse('2026-11-04T03:00:00Z') }); // 22:00 del 3 en Colombia, 19:00 del 3 en California
  const headers = await t.device();
  const before = t.db.touches;
  await t.call('GET', 'bets', { headers });
  assert.equal(t.db.touches, before + 1); // sin last_seen_at todavía
  await t.call('GET', 'bets', { headers });
  await t.call('GET', 'bets', { headers });
  assert.equal(t.db.touches, before + 1);
  await t.call('POST', 'read', { headers, body: { text: 'Jokić Más de 24,5' } });
  assert.equal(t.db.bumps[0][0], '2026-11-03');
});
