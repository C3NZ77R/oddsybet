import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, parseBody, rateOk } from '../lib/chat.mjs';

const ok = (text) => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('parseBody valida mensajes y línea', () => {
  const b = parseBody(JSON.stringify({ messages: [{ role: 'user', text: 'hola' }], check: { league: 'nba', player: 'Stephen Curry', stat: '3pm', line: '3.5', side: 'Over' } }));
  assert.equal(b.check.line, 3.5);
  assert.throws(() => parseBody('{'), /inválido/);
  assert.throws(() => parseBody(JSON.stringify({ messages: [{ role: 'model', text: 'x' }] })), /mensaje/);
  assert.throws(() => parseBody(JSON.stringify({ messages: [{ role: 'user', text: 'a' }], check: { player: '<x>', line: 1 } })), /Línea/);
});

test('chat devuelve la respuesta de Gemini y manda la llave por cabecera', async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url, init }; return ok('Confiable')(); };
  const r = await chat({ messages: [{ role: 'user', text: 'hola' }] }, { key: 'K', fetch });
  assert.equal(r.reply, 'Confiable');
  assert.equal(sent.init.headers['x-goog-api-key'], 'K');
  assert.ok(!sent.url.includes('K'));
});

test('chat falla claro sin llave o con cuota agotada', async () => {
  await assert.rejects(chat({ messages: [] }, { key: '' }), { status: 503 });
  await assert.rejects(chat({ messages: [{ role: 'user', text: 'a' }] }, { key: 'K', fetch: async () => ({ ok: false, status: 429 }) }), { status: 429 });
});

test('rateOk corta después de 20 por minuto', () => {
  const t = Date.now();
  const res = Array.from({ length: 21 }, () => rateOk('1.2.3.4', t));
  assert.equal(res.filter(Boolean).length, 20);
  assert.ok(rateOk('1.2.3.4', t + 61_000));
});

test('chat prueba el modelo de respaldo si el principal da 503', async () => {
  const urls = [];
  const fetch = async (url) => { urls.push(url); return urls.length === 1 ? { ok: false, status: 503, text: async () => 'busy' } : ok('Posible')(); };
  const r = await chat({ messages: [{ role: 'user', text: 'hola' }] }, { key: 'K', fetch });
  assert.equal(r.reply, 'Posible');
  assert.equal(urls.length, 2);
});
