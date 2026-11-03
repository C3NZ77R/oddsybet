// Seguimiento: envío de Web Push (lib/push.mjs) con un web-push falso. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPushEndpoint, createPush } from '../lib/push.mjs';

test('isPushEndpoint: solo https de los servicios de push conocidos', () => {
  assert.equal(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(isPushEndpoint('https://web.push.apple.com/abc'), true);
  assert.equal(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(isPushEndpoint('https://wns2-bl2p.notify.windows.com/w/?token=x'), true);
  assert.equal(isPushEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(isPushEndpoint('https://evil.com/fcm.googleapis.com'), false);
  assert.equal(isPushEndpoint('https://evilfcm.googleapis.com.evil.com/x'), false);
  assert.equal(isPushEndpoint('https://notfcm.googleapis.com/x'), false);
  assert.equal(isPushEndpoint('no es url'), false);
  assert.equal(isPushEndpoint(undefined), false);
});

const keys = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:hola@oddsy.bet' };
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };
const msg = { title: 'Jokić · Más de 24.5 puntos', body: 'Lleva 22', tag: 'b1', url: '/#/nba/seguir' };

test('send: entrega con VAPID, TTL de 10 min y urgencia alta', async () => {
  let got;
  const push = createPush({ ...keys, webpush: { sendNotification: async (...args) => { got = args; return { statusCode: 201 }; } } });
  assert.deepEqual(await push.send(sub, msg), { ok: true, gone: false });
  assert.equal(got[0], sub);
  assert.deepEqual(JSON.parse(got[1]), msg);
  assert.deepEqual(got[2], { vapidDetails: { subject: keys.subject, publicKey: 'pub', privateKey: 'priv' }, TTL: 600, urgency: 'high' });
});

test('send: suscripción vencida (404/410) → gone; otro error → no gone', async () => {
  const failing = (statusCode) => createPush({ ...keys, webpush: { sendNotification: async () => { throw Object.assign(new Error('x'), { statusCode }); } } });
  assert.deepEqual(await failing(410).send(sub, msg), { ok: false, gone: true });
  assert.deepEqual(await failing(404).send(sub, msg), { ok: false, gone: true });
  assert.deepEqual(await failing(500).send(sub, msg), { ok: false, gone: false });
  assert.deepEqual(await failing(undefined).send(sub, msg), { ok: false, gone: false });
});
