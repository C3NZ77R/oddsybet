// Cliente del API: los game logs pedidos en el mismo tick salen en una sola petición a /api/gamelogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/api.js';

test('api: game logs del mismo tick van juntos y un jugador sin log rechaza solo su promesa', async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ source: 'espn', data: { 1: { games: [1] }, 2: { games: [2] }, 3: null } }));
  };
  try {
    const [a, b, a2, c] = await Promise.allSettled([api.gamelog('nba', 1), api.gamelog('nba', 2), api.gamelog('nba', '1'), api.gamelog('nba', 3)]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], '/api/gamelogs?league=nba&ids=1%2C2%2C3');
    assert.deepEqual(a.value, { source: 'espn', data: { games: [1] } });
    assert.deepEqual(b.value.data, { games: [2] });
    assert.equal(a2.value, a.value);
    assert.equal(c.status, 'rejected');
  } finally { globalThis.fetch = real; }
});

// Responde { source, data: n } contando las llamadas; devuelve la lista de URLs pedidas.
function fakeFetch() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ source: 'espn', data: urls.length }));
  };
  return urls;
}

test('api: sin URLSearchParams.size (Safari ≤16, Chrome <113) la URL conserva sus parámetros', async () => {
  const real = globalThis.fetch;
  const size = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size');
  delete URLSearchParams.prototype.size;
  const urls = fakeFetch();
  try {
    await api.games('nba', '20260101');
    assert.equal(urls[0], '/api/games?league=nba&date=20260101');
  } finally {
    globalThis.fetch = real;
    if (size) Object.defineProperty(URLSearchParams.prototype, 'size', size);
  }
});

test('api: la caché vence a los 60 s', async () => {
  const real = globalThis.fetch, now = Date.now;
  const urls = fakeFetch();
  let t = 1e12;
  Date.now = () => t;
  try {
    await api.get('/api/ttl');
    await api.get('/api/ttl');
    assert.equal(urls.length, 1);
    t += 61_000;
    await api.get('/api/ttl');
    assert.equal(urls.length, 2);
  } finally { globalThis.fetch = real; Date.now = now; }
});

test('api: la caché guarda a lo sumo 200 respuestas y saca primero la más vieja', async () => {
  const real = globalThis.fetch;
  const urls = fakeFetch();
  try {
    for (let i = 0; i <= 200; i++) await api.get('/api/cap', { i });
    assert.equal(urls.length, 201);
    await api.get('/api/cap', { i: 200 }); // la más nueva sigue en caché
    assert.equal(urls.length, 201);
    await api.get('/api/cap', { i: 0 }); // la primera salió
    assert.equal(urls.length, 202);
  } finally { globalThis.fetch = real; }
});

test('api: una petición colgada se corta a los 15 s con un error claro', async (t) => {
  const real = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))));
  try {
    const p = api.get('/api/colgada', {}, { fresh: true });
    t.mock.timers.tick(15_000);
    await assert.rejects(p, /tardó demasiado/);
  } finally { globalThis.fetch = real; }
});
