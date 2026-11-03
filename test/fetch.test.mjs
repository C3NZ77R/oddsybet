// fetchJson y su caché en memoria por URL, con fetch simulado (sin red). Archivo propio: la caché es del módulo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../lib/espn.mjs';

async function withFetch(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => (calls.push(url), reply(url, calls.length));
  try { await fn(calls); } finally { globalThis.fetch = real; }
}
const ok = (body) => new Response(JSON.stringify(body));

test('fetchJson: un pedido fallido no queda en caché', () => withFetch((_, n) => (n === 1 ? new Response('{}', { status: 500 }) : ok({ n })), async (calls) => {
  await assert.rejects(fetchJson('https://x.test/falla'), { status: 502, message: 'ESPN respondió 500' });
  assert.deepEqual(await fetchJson('https://x.test/falla'), { n: 2 });
  assert.deepEqual(await fetchJson('https://x.test/falla'), { n: 2 });
  assert.equal(calls.length, 2);
}));

test('fetchJson: un TTL numérico también acota la edad de la entrada que sirve; función y 0 siguen usando el de la entrada', () => withFetch((_, n) => ok({ n }), async (calls) => {
  const real = Date.now;
  let t = 4e12;
  Date.now = () => t;
  try {
    const largo = 'https://x.test/ttl-largo'; // entrada de 5 min
    await fetchJson(largo, 300_000);
    t += 16_000;
    assert.deepEqual(await fetchJson(largo, 300_000), { n: 1 }); // mismo TTL: sigue vigente
    assert.deepEqual(await fetchJson(largo, () => 15_000), { n: 1 }); // función: manda el TTL de la entrada
    assert.deepEqual(await fetchJson(largo, 0), { n: 1 }); // 0: igual que antes, sirve la entrada
    assert.deepEqual(await fetchJson(largo, 15_000), { n: 2 }); // 16 s > 15 s pedidos: se pide de nuevo
    const corto = 'https://x.test/ttl-corto'; // entrada de 15 s
    await fetchJson(corto, 15_000);
    t += 10_000;
    assert.deepEqual(await fetchJson(corto, () => 300_000), { n: 3 }); // función: sigue valiendo 15 s
    assert.deepEqual(await fetchJson(corto, 300_000), { n: 3 }); // un TTL mayor no alarga la entrada
    t += 6_000;
    assert.deepEqual(await fetchJson(corto, () => 300_000), { n: 4 }); // 16 s: la entrada de 15 s venció
    assert.equal(calls.length, 4);
  } finally { Date.now = real; }
}));

test('fetchJson: una entrada recién renovada no es la próxima en salir de la caché', () => withFetch((url) => ok({ url }), async (calls) => {
  const a = 'https://x.test/a';
  await fetchJson(a, 1);
  for (let i = 0; i < 299; i++) await fetchJson(`https://x.test/viejo/${i}`); // tope de 300: a queda primera
  await new Promise((r) => setTimeout(r, 5));
  await fetchJson(a); // vencida: se pide de nuevo
  for (let i = 0; i < 299; i++) await fetchJson(`https://x.test/nuevo/${i}`);
  await fetchJson(a);
  assert.equal(calls.filter((u) => u === a).length, 2);
}));
