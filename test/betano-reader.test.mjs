import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, PROFILE, Blocked, blockedBy, ingestRequest, readAll } from '../scripts/betano-reader.mjs';
import { LEAGUES } from '../public/leagues.js';

const EVENT = ['Manchester City - Fulham', 1795264200000, [], [['MRES', [['Manchester City', 1.42, 0], ['Empate', 4.9, 0], ['Fulham', 7.3, 0]]]]];
const quiet = { log: () => {}, sleep: async () => {} };

// Una pestaña falsa: states = lo que la página dice de sí misma en cada liga; reads = lo que devuelve read.
function fakePage({ state = () => ({ status: 200, title: 'Apuestas | Betano', ready: true, links: 3 }), reads = () => ({ found: [EVENT] }), index = { urls: [] } } = {}) {
  const page = { gone: [], evals: [], path: '' };
  page.goto = async (url) => { page.gone.push(url); page.path = new URL(url).pathname; };
  page.evaluate = async (code) => {
    page.evals.push(code);
    if (code.includes('performance.getEntriesByType')) return state(page.path);
    return code.startsWith('fetch(') ? index : reads(page.path);
  };
  return page;
}

test('la tabla de ligas solo nombra ligas de Oddsy y rutas de betano.co', () => {
  const ids = LEAGUES.map((l) => l.id);
  for (const [id, route] of Object.entries(ROUTES)) {
    assert.ok(ids.includes(id), id);
    for (const path of Array.isArray(route) ? route : [route.index]) assert.match(path, /^\/sport\/[a-z-]+\/([a-z0-9-]+\/)*$/);
    if (!Array.isArray(route)) assert.ok(route.match instanceof RegExp);
  }
  for (const id of ['epl', 'laliga', 'ucl', 'colombia', 'nba', 'atp']) assert.ok(ROUTES[id], id);
  assert.match(PROFILE, /\/\.config\/oddsy-betano$/);
});

test('el tenis toma del índice los torneos de individuales y deja dobles y otras categorías', async () => {
  const urls = ['/sport/tenis/atp-finals/atp-finals/199527/', '/sport/tenis/atp-finals/atp-finals-dobles/199528/', '/sport/tenis/campeonatos/atp-finals/11451/',
    '/sport/tenis/challenger/kobe/184948/', '/sport/tenis/challenger/kobe-dobles/184950/', '/sport/tenis/itf-hombres/espana/17209/', '/sport/futbol/espana/laliga/5/'];
  const page = fakePage({ index: { urls } });
  const out = await readAll(page, { ...quiet, leagues: ['atp', 'challenger'] });
  assert.deepEqual(page.gone, ['https://www.betano.co/sport/tenis/', 'https://www.betano.co/sport/tenis/atp-finals/atp-finals/199527/', 'https://www.betano.co/sport/tenis/challenger/kobe/184948/']);
  assert.deepEqual(out, { atp: [EVENT], challenger: [EVENT] });
});

test('ingestRequest arma el POST a Oddsy con el secreto en la cabecera', () => {
  const [url, init] = ingestRequest([EVENT], { TRACK_TICK_SECRET: 's3' });
  assert.equal(url, 'https://oddsybet.vercel.app/api/betano/ingest');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'content-type': 'application/json', 'x-tick-secret': 's3' });
  assert.deepEqual(JSON.parse(init.body), { events: [EVENT] });
  assert.equal(ingestRequest([], { TRACK_TICK_SECRET: 's3', ODDSY_URL: 'http://localhost:3000' })[0], 'http://localhost:3000/api/betano/ingest');
  assert.throws(() => ingestRequest([EVENT], {}), /TRACK_TICK_SECRET/);
});

test('blockedBy reconoce el 403, el 429 y el reto de Cloudflare', () => {
  assert.equal(blockedBy({ status: 403 }), 'HTTP 403');
  assert.equal(blockedBy({ status: 429 }), 'HTTP 429');
  assert.equal(blockedBy({ status: 200, title: 'Just a moment...' }), 'reto de Cloudflare');
  assert.equal(blockedBy({ status: 200, title: 'Betano', challenge: true }), 'reto de Cloudflare');
  assert.equal(blockedBy({ status: 200, title: 'Apuestas de NBA | Betano' }), null);
  assert.equal(blockedBy({}), null);
});

test('readAll lee cada liga, le pasa pausa y límite a read y entrega lo leído', async () => {
  const page = fakePage({ state: (path) => ({ status: 200, title: 'Betano', links: path.includes('laliga') ? 0 : 5 }) });
  const sent = [];
  const out = await readAll(page, { ...quiet, leagues: ['epl', 'laliga', 'nba'], limit: 2, tries: 2, send: async (id, events) => sent.push([id, events]) });
  assert.deepEqual(page.gone, ['epl', 'laliga', 'nba'].map((id) => `https://www.betano.co${ROUTES[id][0]}`));
  assert.deepEqual(out, { epl: [EVENT], laliga: [], nba: [EVENT] });
  assert.deepEqual(sent, [['epl', [EVENT]], ['nba', [EVENT]]]); // una liga sin partidos no se manda
  const reads = page.evals.filter((c) => c.startsWith('(async function read'));
  assert.equal(reads.length, 2);
  assert.ok(reads[0].includes('({"pause":[2000,4000],"max":2})'));
});

test('readAll se detiene en el primer 403 y no sigue con las demás ligas', async () => {
  const sent = [];
  const send = async (id) => sent.push(id);
  const nav = fakePage({ state: (path) => (path.includes('laliga') ? { status: 403, title: '' } : { status: 200, title: 'Betano', links: 5 }) });
  await assert.rejects(readAll(nav, { ...quiet, leagues: ['epl', 'laliga', 'nba'], send }), (e) => e instanceof Blocked && /HTTP 403 en \/sport\/futbol\/espana\/laliga/.test(e.message));
  assert.equal(nav.gone.length, 2);
  assert.deepEqual(sent, ['epl']);

  // El 429 a mitad de la lectura (lo devuelve read) y el reto de Cloudflare cortan igual.
  const api = fakePage({ reads: () => ({ error: 'HTTP 429' }) });
  await assert.rejects(readAll(api, { ...quiet, leagues: ['epl', 'nba'], send }), Blocked);
  assert.equal(api.gone.length, 1);
  const cf = fakePage({ state: () => ({ status: 200, title: 'Just a moment...' }) });
  await assert.rejects(readAll(cf, { ...quiet, leagues: ['nba'] }), /reto de Cloudflare/);
  const idx = fakePage({ index: { status: 403 } });
  await assert.rejects(readAll(idx, { ...quiet, leagues: ['atp'] }), Blocked);
});
