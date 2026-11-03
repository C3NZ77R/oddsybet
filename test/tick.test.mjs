// Seguimiento: el tick (lib/tick.mjs) con base de datos, push y ESPN falsos. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick } from '../lib/tick.mjs';
import { ACTIVE } from '../lib/track.mjs';

const NOW = Date.parse('2026-11-03T04:00:00Z');
const clone = (x) => structuredClone(x);

// Base de datos en memoria que guarda lo que el tick escribe; activeBets solo devuelve las activas, como la real.
function memDb(bets, { lease = true, failActive = false } = {}) {
  const store = new Map(bets.map((b) => [b.id, clone(b)]));
  const log = [];
  return {
    store, log, deleted: [],
    async takeLease(s) { log.push(['takeLease', s]); return lease; },
    async releaseLease() { log.push(['releaseLease']); },
    async activeBets() {
      log.push(['activeBets']);
      if (failActive) throw new Error('supabase caído');
      return [...store.values()].filter((b) => ACTIVE.has(b.status)).map(clone);
    },
    async saveSelections(sels) {
      log.push(['saveSelections', sels.length]);
      for (const s of sels) {
        const b = store.get(s.betId);
        b.selections = b.selections.map((x) => (x.id === s.id ? clone(s) : x));
      }
    },
    async saveBet({ id, status, notified, settledAt }) { log.push(['saveBet', id]); Object.assign(store.get(id), { status, notified }, settledAt && { settledAt }); },
    async deleteDevice(id) { log.push(['deleteDevice', id]); this.deleted.push(id); },
  };
}

const live = ({ id, state = 'in', period = 4, clock = 372, pts = 21 }) => ({
  id, league: 'nba', start: '2026-11-03T02:00:00Z', status: { state, detail: null, name: null },
  home: { id: '1', abbr: 'DEN', name: 'Denver Nuggets', score: 100 }, away: { id: '2', abbr: 'LAL', name: 'Los Angeles Lakers', score: 95 },
  period, clock, progress: 0.87, winProb: null, players: [{ id: '9', name: 'Nikola Jokić', teamId: '1', stats: { min: 30, pf: 1, pts } }],
});
const bet = (id, gameId, o = {}) => ({
  id, deviceId: `d-${id}`, book: null, odds: null, status: 'en_juego', notified: { start: true }, device: { id: `d-${id}`, subscription: { endpoint: `https://fcm.googleapis.com/${id}` } },
  selections: [{ id: `s-${id}`, betId: id, gameId, gameStart: '2026-11-03T02:00:00Z', market: 'prop', stat: 'pts', athleteId: '9', athleteName: 'Nikola Jokić',
    side: 'Over', line: 24.5, odds: null, label: 'Jokić · Más de 24.5 puntos', prior: null, status: 'en_juego', current: 18, state: {} }],
  ...o,
});
const pusher = (fn = async () => ({ ok: true, gone: false })) => { const sent = []; return { sent, send: async (sub, msg) => { sent.push({ sub, msg }); return fn(sub, msg); } }; };

test('sin el candado no hace nada', async () => {
  const db = memDb([bet('b1', 'g1')], { lease: false });
  const push = pusher();
  assert.deepEqual(await runTick({ db, push, liveGame: async () => live({ id: 'g1' }), now: NOW }), { bets: 0, pushes: 0, skippedGames: 0 });
  assert.deepEqual(db.log, [['takeLease', 55]]);
  assert.equal(push.sent.length, 0);
});

test('un partido que falla en ESPN se salta sin tocar sus selecciones', async () => {
  const db = memDb([bet('b1', 'g1'), bet('b2', 'g2')]);
  const before = clone(db.store.get('b2'));
  const push = pusher();
  const r = await runTick({ db, push, liveGame: async (id) => { if (id === 'g2') throw new Error('502'); return live({ id }); }, now: NOW });
  assert.equal(r.skippedGames, 1);
  assert.equal(r.bets, 1);
  assert.equal(db.store.get('b1').selections[0].state.near, true);
  assert.deepEqual(db.store.get('b2'), before);
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].msg.tag, 'b1');
});

test('guarda antes del push: si el push falla no se repite en el siguiente tick', async () => {
  const db = memDb([bet('b1', 'g1')]);
  const order = [];
  const push = { send: async () => { order.push(db.log.at(-1)[0]); throw new Error('push caído'); } };
  await runTick({ db, push, liveGame: async (id) => live({ id }), now: NOW });
  assert.equal(order[0], 'saveBet');
  assert.equal(db.store.get('b1').selections[0].state.near, true);
  const again = pusher();
  const r = await runTick({ db, push: again, liveGame: async (id) => live({ id, pts: 22 }), now: NOW + 30_000 });
  assert.equal(again.sent.length, 0);
  assert.equal(r.pushes, 0);
});

test('suscripción vencida: borra ese dispositivo y sigue con las demás', async () => {
  const db = memDb([bet('b1', 'g1'), bet('b2', 'g1')]);
  const push = pusher(async (sub) => ({ ok: !sub.endpoint.endsWith('b1'), gone: sub.endpoint.endsWith('b1') }));
  const r = await runTick({ db, push, liveGame: async (id) => live({ id }), now: NOW });
  assert.deepEqual(db.deleted, ['d-b1']);
  assert.equal(push.sent.length, 2);
  assert.equal(r.pushes, 1);
});

test('liquida, marca settledAt y no vuelve a leer apuestas cerradas', async () => {
  const db = memDb([bet('b1', 'g1')]);
  const push = pusher();
  await runTick({ db, push, liveGame: async (id) => live({ id, state: 'post', pts: 30 }), now: NOW });
  const b = db.store.get('b1');
  assert.equal(b.status, 'ganada');
  assert.equal(b.settledAt, new Date(NOW).toISOString());
  const later = pusher();
  const r = await runTick({ db, push: later, liveGame: async (id) => live({ id, state: 'post', pts: 30 }), now: NOW + 30_000 });
  assert.equal(r.bets, 0);
  assert.equal(later.sent.length, 0);
});

test('partidos lejanos no se piden; sin cambios no se escribe', async () => {
  const far = bet('b1', 'g9');
  far.selections[0].gameStart = '2026-11-04T02:00:00Z';
  const asked = [];
  const db = memDb([far, bet('b2', 'g1')]);
  await runTick({ db, push: pusher(), liveGame: async (id) => { asked.push(id); return live({ id, pts: 18, period: 2, clock: 300 }); }, now: NOW });
  assert.deepEqual(asked, ['g1']);
  assert.ok(!db.log.some(([k]) => k === 'saveBet' || k === 'saveSelections'));
});

test('suelta el candado aunque falle la base de datos', async () => {
  const db = memDb([], { failActive: true });
  await assert.rejects(runTick({ db, push: pusher(), liveGame: async () => null, now: NOW }));
  assert.deepEqual(db.log.at(-1), ['releaseLease']);
});
