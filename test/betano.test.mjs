import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grab, bookmarklet, linesOf, decode, save, saved, lineFor, atLine, edge } from '../public/betano.js';
import { propOver, price } from '../public/betmath.js';
import { store } from '../public/store.js';

// Recorte de la respuesta real de /api/cuotas-de-partido/x/94469092/?bt=1 (Denver–Toronto, 2026-11-04).
const row = (title, line, over, under) => ({ title, groupSelections: [{ handicap: line, selections: [{ price: over, columnIndex: 0 }, { price: under, columnIndex: 1 }] }] });
const EVENT = {
  name: 'Denver Nuggets - Toronto Raptors',
  startTime: 1793844000000,
  markets: [
    { tableLayout: { title: 'Puntos Más/Menos', rows: [row('Nikola Jokic', 24.5, 1.83, 1.91), row('Ja\'Kobe Walter', 11.5, 1.9, 1.78)] } },
    { tableLayout: { title: 'Puntos+Rebotes+Asistencias Más/Menos', rows: [row('Nikola Jokic', 46.5, 1.9, 1.83)] } },
    { tableLayout: { title: 'Puntos+Bloques Más/Menos', rows: [row('Nikola Jokic', 26.5, 1.85, 1.85)] } }, // Oddsy no lo tiene
    { tableLayout: { title: 'Puntos', rows: [{ title: 'Nikola Jokic', groupSelections: [{ handicap: 0, selections: [{ name: '22+', price: 1.44, columnIndex: 0 }] }] }] } }, // escalera
    { name: 'Ganador' },
  ],
};
const WANT = { 'nikolajokic|pts': [24.5, 1.83, 1.91], 'jakobewalter|pts': [11.5, 1.9, 1.78], 'nikolajokic|pra': [46.5, 1.9, 1.83] };

// Corre grab como si estuviera en betano.co y devuelve a dónde mandó el navegador (o el alert).
async function runGrab(pathname, links = []) {
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, alert: globalThis.alert };
  const out = { asked: [] };
  Object.assign(globalThis, {
    location: { hostname: 'www.betano.co', pathname, href: `https://www.betano.co${pathname}` },
    document: { querySelectorAll: () => links.map((href) => ({ href: `https://www.betano.co${href}` })) },
    fetch: async (url) => { out.asked.push(url); return { json: async () => ({ data: { event: url.includes('/94469092/') ? EVENT : { name: 'X', markets: [] } } }) }; },
    alert: (msg) => { out.alert = msg; },
  });
  try {
    await grab('https://oddsybet.vercel.app/#/betano?d=');
    out.href = globalThis.location.href;
  } finally {
    Object.assign(globalThis, saved);
  }
  return out;
}

test('el marcador lee un partido y Oddsy recupera sus líneas del enlace', async () => {
  const r = await runGrab('/cuotas-de-partido/denver-nuggets-toronto-raptors/94469092/');
  assert.deepEqual(r.asked, ['/api/cuotas-de-partido/x/94469092/?bt=1']);
  assert.match(r.href, /^https:\/\/oddsybet\.vercel\.app\/#\/betano\?d=[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decode(r.href.split('d=')[1]), WANT);
});

test('en la página de la liga lee cada partido enlazado una sola vez y se salta los que no tienen líneas', async () => {
  const links = ['/cuotas-de-partido/denver-nuggets-toronto-raptors/94469092/', '/cuotas-de-partido/denver-nuggets-toronto-raptors/94469092/?ms=PLNP', '/cuotas-de-partido/indiana-pacers-new-york-knicks/91849791/'];
  const r = await runGrab('/sport/baloncesto/ee-uu/nba/441g/', links);
  assert.deepEqual(r.asked, ['/api/cuotas-de-partido/x/94469092/?bt=1', '/api/cuotas-de-partido/x/91849791/?bt=1']);
  assert.deepEqual(await decode(r.href.split('d=')[1]), WANT);
});

test('fuera de un partido o de la liga, el marcador avisa y no navega', async () => {
  const r = await runGrab('/');
  assert.match(r.alert, /Abre en Betano/);
  assert.equal(r.href, 'https://www.betano.co/');
});

test('el código del marcador es JavaScript válido y apunta a Oddsy', () => {
  const url = bookmarklet('https://oddsybet.vercel.app');
  assert.ok(url.startsWith('javascript:'));
  const code = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(code.includes('"https://oddsybet.vercel.app/#/betano?d="'));
  assert.doesNotThrow(() => new Function(code)); // eslint-disable-line no-new-func
});

test('linesOf descarta lo que no cuadra (viene de una URL)', () => {
  const ev = (markets) => [['X', 1, markets]];
  assert.deepEqual(linesOf(null), {});
  assert.deepEqual(linesOf('x'), {});
  assert.deepEqual(linesOf(ev([['constructor', [['A B', 1.5, 2, 2]]]])), {}); // título heredado de Object
  assert.deepEqual(linesOf(ev([['Robos Más/Menos', [['', 1.5, 2, 2], ['A B', NaN, 2, 2], ['A B', -1, 2, 2], ['x'.repeat(61), 1.5, 2, 2], 'basura', null]]])), {});
  assert.deepEqual(linesOf(ev([['Robos Más/Menos', [['Herbert Jones', 1.5, 0.9, 'x']]]])), { 'herbertjones|stl': [1.5, null, null] });
  assert.deepEqual(linesOf(ev([['Robos Más/Menos', [['Nikola Jokić', 1.5, 2.12, 1.67]]], 'basura'])), { 'nikolajokic|stl': [1.5, 2.12, 1.67] });
});

test('decode: un enlace roto o una bomba de compresión no rompen nada', async () => {
  assert.deepEqual(await decode(''), {});
  assert.deepEqual(await decode('%%%'), {});
  assert.deepEqual(await decode(null), {});
  const pack = async (json) => {
    const zip = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return btoa(String.fromCharCode(...new Uint8Array(await new Response(zip).arrayBuffer()))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const ok = '[["X",1,[["Robos Más/Menos",[["A B",1.5,2,2]]]]]]';
  assert.deepEqual(await decode(await pack(ok)), { 'ab|stl': [1.5, 2, 2] });
  assert.deepEqual(await decode(await pack(ok + ' '.repeat(2 << 20))), {}); // JSON válido, pero pasa de 1 MB
});

test('save suma partidos, lineFor busca por nombre normalizado y todo vence a las 12 h', (t) => {
  t.after(() => store.set('betano', null));
  store.set('betano', null);
  assert.equal(saved(store), null);
  save(store, { 'nikolajokic|pts': [24.5, 1.83, 1.91] });
  save(store, { 'jamalmurray|pts': [23.5, 1.87, 1.8], 'nikolajokic|pts': [25.5, 1.9, 1.85] });
  const b = saved(store);
  assert.deepEqual(lineFor(b, 'Nikola Jokić', 'pts'), [25.5, 1.9, 1.85]);
  assert.deepEqual(lineFor(b, 'Jamal Murray', 'pts'), [23.5, 1.87, 1.8]);
  assert.equal(lineFor(b, 'Jamal Murray', 'reb'), null);
  assert.equal(lineFor(null, 'Jamal Murray', 'pts'), null);
  store.set('betano', { ...b, at: Date.now() - 13 * 3600 * 1000 });
  assert.equal(saved(store), null);
});

test('atLine cotiza el prop en la línea de Betano y edge da la ventaja', () => {
  const p = { player: 'Nikola Jokic', stat: 'pts', side: 'Over', line: 27.5, kind: 'normal', mean: 28.1, variance: 40, p: 0.5, books: [] };
  const over = atLine(p, 24.5), under = atLine(p, 24.5, 'Under');
  const want = propOver('normal', 28.1, 40, 24.5);
  assert.equal(over.line, 24.5);
  assert.equal(over.p, price(want).p);
  assert.equal(over.books[0].price, price(want).oddsy);
  assert.ok(Math.abs(over.p + under.p - 1) < 1e-12);
  assert.equal(edge(0.6, 1.83), 0.6 * 1.83 - 1);
  assert.equal(edge(0.6, null), null);
});

test('atLine: una línea casi segura (Más de 0.5 con media 10) no se cotiza: topaba en 1.01 y dejaba valor', () => {
  const p = { player: 'X', stat: 'reb', side: 'Over', line: 9.5, kind: 'count', mean: 10, variance: 12, p: 0.5, books: [] };
  assert.equal(atLine(p, 0.5), null);
  assert.equal(atLine(p, 0.5, 'Under'), null);
  assert.ok(atLine(p, 9.5));
});
