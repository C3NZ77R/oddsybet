import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, parseBody, rateOk, SYSTEM } from '../lib/chat.mjs';

const ok = (text) => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('parseBody valida los mensajes', () => {
  const b = parseBody(JSON.stringify({ messages: [{ role: 'user', text: 'hola' }] }));
  assert.equal(b.messages.length, 1);
  assert.throws(() => parseBody('{'), /inválido/);
  assert.throws(() => parseBody(JSON.stringify({ messages: [{ role: 'model', text: 'x' }] })), /mensaje/);
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

test('Gemini interpreta el mensaje, llama a check_line y responde con esos datos', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'check_line', args: { league: 'nba', player: 'Stephen Curry', stat: '3pm', line: 3.5, side: 'Over' } } }] } }] }) }
      : ok('Confiable')();
  };
  let got;
  const r = await chat({ messages: [{ role: 'user', text: 'curry mas de 3.5 triples' }] }, { key: 'K', fetch, tools: { check_line: async (a) => (got = a, { last5: { pct: 80 } }) } });
  assert.equal(r.reply, 'Confiable');
  assert.deepEqual([got.player, got.stat, got.line, got.side], ['Stephen Curry', '3pm', 3.5, 'Over']);
  const fr = bodies[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(fr.response.last5.pct, 80);
});

test('Gemini pide find_picks con el umbral del usuario y responde con esos picks', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'find_picks', args: { minP: 0.8, day: 'hoy' } } }] } }] }) }
      : ok('✅ Gana Nacional')();
  };
  let got;
  const tools = { find_picks: async (a) => (got = a, { day: '2026-11-11', leagues: ['colombia'], picks: [{ game: 'Nacional vs Millonarios', pick: 'Gana Nacional', p: 0.82, minOdds: 1.29, fair: 1.22 }] }) };
  const r = await chat({ messages: [{ role: 'user', text: 'algo seguro, más del 80% y cuota 1.70' }] }, { key: 'K', fetch, tools });
  assert.equal(r.reply, '✅ Gana Nacional');
  assert.deepEqual([got.minP, got.day, got.team], [0.8, 'hoy', '']);
  assert.equal(bodies[1].contents.at(-1).parts[0].functionResponse.response.picks[0].fair, 1.22);
  assert.ok(bodies[0].tools[0].functionDeclarations.some((d) => d.name === 'find_picks'));
});

test('una herramienta desconocida responde con error y no tumba el chat', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'nope', args: {} } }] } }] }) }
      : ok('ok')();
  };
  const r = await chat({ messages: [{ role: 'user', text: 'x' }] }, { key: 'K', fetch, tools: {} });
  assert.equal(r.reply, 'ok');
  assert.match(bodies[1].contents.at(-1).parts[0].functionResponse.response.error, /herramienta/i);
});

test('el prompt fija el umbral de segura y la regla de la cuota justa', () => {
  assert.match(SYSTEM, /segura \(>= 80 %\)/);
  assert.match(SYSTEM, /cuota justa ronda fair/);
  assert.match(SYSTEM, /nunca inventes partidos/);
});
