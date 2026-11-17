import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, grab, bookmarklet, linesOf, decode, decodeAll, gamesOf, gameFor, priceFor, save, saved, lineFor, atLine, edge } from '../public/betano.js';
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
  assert.deepEqual(r.asked, ['/api/sport/baloncesto/ee-uu/nba/441g/?bt=1', '/api/cuotas-de-partido/x/94469092/?bt=1', '/api/cuotas-de-partido/x/91849791/?bt=1']);
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

// Recortes reales de Betano del 2026-11-11: Premier (página de la liga + detalle), NBA y ATP (página de la liga).
const sel = (name, price, handicap = 0) => [name, price, handicap];
const SOCCER = ['Manchester City - Fulham', 1795264200000, [], [
  ['MRES', [sel('Manchester City', 1.47), sel('Empate', 4.7), sel('Fulham', 6.5)]],
  ['HCTG', [sel('Más de 2.5', 1.52, 2.5), sel('Menos 2.5', 2.57, 2.5), sel('Más de 3.5', 2.22, 3.5), sel('Menos 3.5', 1.67, 3.5)]],
  ['BTSC', [sel('Sí', 1.65), sel('No', 2.15)]],
]];
const NBA = ['Indiana Pacers - Washington Wizards', 1795222800000, [], [
  ['H2HT', [sel('Indiana Pacers', 1.7), sel('Washington Wizards', 2.18)]],
  ['FHOT', [sel('Indiana Pacers -2.5', 1.91, -2.5), sel('Washington Wizards +2.5', 1.9, 2.5)]],
  ['FTPO', [sel('Más de 228.5', 1.93, 228.5), sel('Menos 228.5', 1.87, 228.5)]],
]];
const ATP = ['Alex Michelsen - Alejandro Tabilo', 1795200000000, [], [['HTOH', [sel('Alex Michelsen', 1.27), sel('Alejandro Tabilo', 3.8)]]]];

test('gamesOf arma los mercados de partido y descarta lo que no cuadra', () => {
  const [s, n, a] = gamesOf([SOCCER, NBA, ATP, ['Sin guion', 1, [], []], ['A - B', 'x', [], []], 'basura']);
  assert.deepEqual(s, { t: 1795264200000, teams: ['Manchester City', 'Fulham'], ml: [1.47, 4.7, 6.5], ou: [[2.5, 1.52, 2.57], [3.5, 2.22, 1.67]], btts: [1.65, 2.15] });
  assert.deepEqual(n, { t: 1795222800000, teams: ['Indiana Pacers', 'Washington Wizards'], ml: [1.7, 2.18], spread: [-2.5, 1.91, 1.9], ou: [[228.5, 1.93, 1.87]] });
  assert.deepEqual(a.ml, [1.27, 3.8]);
  assert.equal(gamesOf([SOCCER, NBA, ATP, ['Sin guion', 1, [], []]]).length, 3);
  assert.deepEqual(gamesOf(null), []);
});

test('gameFor encuentra el partido por equipos y hora, y priceFor da la cuota de cada selección', () => {
  const b = { games: gamesOf([SOCCER, NBA, ATP]) };
  const team = (name) => ({ name });
  const city = gameFor(b, { start: '2026-11-21T15:30:00Z', home: team('Manchester City'), away: team('Fulham') });
  assert.equal(city.flip, false);
  const m1x2 = { key: '1x2' }, mOu = { key: 'ou' }, mBtts = { key: 'btts' }, mMl = { key: 'ml' }, mSp = { key: 'spread' };
  assert.equal(priceFor(city, m1x2, { name: 'Local' }), 1.47);
  assert.equal(priceFor(city, m1x2, { name: 'Empate' }), 4.7);
  assert.equal(priceFor(city, m1x2, { name: 'Visitante' }), 6.5);
  assert.equal(priceFor(city, mOu, { name: 'Menos', line: 3.5 }), 1.67);
  assert.equal(priceFor(city, mOu, { name: 'Más', line: 4.5 }), null); // Betano no la trajo
  assert.equal(priceFor(city, mBtts, { name: 'Sí' }), 1.65);
  assert.equal(priceFor(city, mMl, { name: 'Local' }), null); // ganador de dos vías contra un 1X2: no se mezcla
  // Otro partido de Manchester con Fulham de visita no existe: United no debe tomar la cuota del City por "Manchester".
  assert.equal(gameFor(b, { start: '2026-11-21T15:30:00Z', home: team('Manchester United'), away: team('Chelsea') }), null);
  assert.equal(gameFor(b, { start: '2026-11-25T15:30:00Z', home: team('Manchester City'), away: team('Fulham') }), null); // otro día

  // Con los equipos al revés que Betano: el hándicap y el ganador se voltean.
  const ind = gameFor(b, { start: '2026-11-21T00:00:00Z', home: team('Washington Wizards'), away: team('Indiana Pacers') });
  assert.equal(ind.flip, true);
  assert.equal(priceFor(ind, mMl, { name: 'Local' }), 2.18);
  assert.equal(priceFor(ind, mMl, { name: 'Visitante' }), 1.7);
  assert.equal(priceFor(ind, mSp, { name: 'Local', line: 2.5 }), 1.9);
  assert.equal(priceFor(ind, mSp, { name: 'Visitante', line: -2.5 }), 1.91);
  assert.equal(priceFor(ind, mSp, { name: 'Local', line: 3.5 }), null); // otra línea
  assert.equal(priceFor(ind, mOu, { name: 'Más', line: 228.5 }), 1.93);

  const ten = gameFor(b, { start: '2026-11-20T18:00:00Z', home: team('Alex Michelsen'), away: team('Alejandro Tabilo') });
  assert.equal(priceFor(ten, mMl, { name: 'A' }), 1.27);
  assert.equal(priceFor(ten, mMl, { name: 'B' }), 3.8);
  assert.equal(priceFor(null, mMl, { name: 'A' }), null);
});

test('el marcador en una liga de fútbol trae el 1X2 de la página y los totales del detalle', async () => {
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, alert: globalThis.alert };
  const league = { data: { blocks: [{ events: [{ id: '94991437', markets: [{ type: 'MRES', selections: [{ fullName: 'Manchester City', price: 1.47 }, { name: 'X', fullName: 'Empate', price: 4.7 }, { fullName: 'Fulham', price: 6.5 }] }] }] }] } };
  const detail = { name: 'Manchester City - Fulham', startTime: 1795264200000, markets: [{ type: 'BTSC', selections: [{ name: 'Sí', price: 1.65 }, { name: 'No', price: 2.15 }] }, { type: 'ODEV', selections: [{ name: 'Par', price: 1.87 }] }] };
  Object.assign(globalThis, {
    location: { hostname: 'www.betano.co', pathname: '/sport/futbol/inglaterra/premier-league/1/', href: '' },
    document: { querySelectorAll: () => [{ href: 'https://www.betano.co/cuotas-de-partido/manchester-city-fulham/94991437/' }] },
    fetch: async (url) => ({ json: async () => (url.startsWith('/api/sport/') ? league : { data: { event: detail } }) }),
    alert: () => {},
  });
  try {
    await grab('https://oddsybet.vercel.app/#/betano?d=');
    const { lines, games } = await decodeAll(globalThis.location.href.split('d=')[1]);
    assert.deepEqual(lines, {});
    assert.deepEqual(games, [{ t: 1795264200000, teams: ['Manchester City', 'Fulham'], ml: [1.47, 4.7, 6.5], ou: [], btts: [1.65, 2.15] }]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('save reemplaza un partido ya guardado por su versión nueva', (t) => {
  t.after(() => store.set('betano', null));
  store.set('betano', null);
  save(store, {}, gamesOf([SOCCER]));
  save(store, {}, [{ ...gamesOf([SOCCER])[0], ml: [1.5, 4.5, 6] }]);
  assert.deepEqual(saved(store).games.map((g) => g.ml), [[1.5, 4.5, 6]]);
});

// read con las pestañas reales del 2026-11-16: en fútbol y tenis la 1 es parcial y "Todo" trae el resto.
async function runRead(tabs, allTab, opts) {
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch };
  const asked = [];
  const market = (type) => ({ type, selections: [{ name: 'A', price: 1.5 }, { name: 'B', price: 2.5 }] });
  Object.assign(globalThis, {
    location: { hostname: 'www.betano.co', pathname: '/sport/tenis/atp-finals/atp-finals/199527/' },
    document: { querySelectorAll: () => ['1', '2', '3'].map((id) => ({ href: `https://www.betano.co/cuotas-de-partido/a-b/${id}/` })) },
    fetch: async (url) => {
      asked.push(url);
      if (url.includes('/x/3/')) return { status: 429, json: async () => ({}) };
      const all = url.endsWith(`bt=${allTab}`);
      return { status: 200, json: async () => ({ data: { markets: tabs, event: { name: 'A - B', startTime: 1, markets: [market(all ? 'HTOH' : 'FTGO'), market(all ? 'HTOH' : 'XXXX')] } } }) };
    },
  });
  try {
    return { found: await read(opts).catch((e) => e.message), asked };
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('read pasa a la pestaña "Todo" desde el primer partido, quita mercados repetidos y corta con un 429', async () => {
  const tennis = [{ id: '0', type: 'popular' }, { id: '1', type: 'gamesoverunder', selected: true }, { id: '9', type: 'allmarkets' }];
  const r = await runRead(tennis, '9', { max: 2 });
  assert.deepEqual(r.asked, ['/api/sport/tenis/atp-finals/atp-finals/199527/?bt=1', '/api/cuotas-de-partido/x/1/?bt=1', '/api/cuotas-de-partido/x/1/?bt=9', '/api/cuotas-de-partido/x/2/?bt=9']);
  assert.deepEqual(r.found, [1, 2].map(() => ['A - B', 1, [], [['HTOH', [['A', 1.5, 0], ['B', 2.5, 0]]]]]));
  // En la NBA la 1 es la de jugadores (las líneas de props): no se cambia.
  const nba = await runRead([{ id: '1', type: 'players', selected: true }, { id: '6', type: 'all' }], '6', { max: 2 });
  assert.deepEqual(nba.asked.slice(1), ['/api/cuotas-de-partido/x/1/?bt=1', '/api/cuotas-de-partido/x/2/?bt=1']);
  assert.equal((await runRead(tennis, '9', {})).found, 'HTTP 429');
});

test('gamesOf pasa una lectura real del lector (2026-11-16) por los campos de siempre y los nuevos', async () => {
  const { default: fx } = await import('./fixtures/betano-read.json', { with: { type: 'json' } });
  const pairs = (rows) => rows.every((r) => r.length === 3 && Number.isFinite(r[0]) && r[1] > 1 && r[2] > 1);
  const soccer = gamesOf(fx.epl), nba = gamesOf(fx.nba), atp = gamesOf(fx.atp);
  assert.equal(soccer.length, 2);
  for (const g of soccer) {
    assert.equal(g.ml.length, 3);
    assert.equal(g.btts.length, 2);
    assert.equal(g.dc.length, 3);
    assert.ok(g.dc.every((p) => p > 1) && g.dc[0] < g.ml[0] && g.dc[1] < g.ml[2]); // 1X paga menos que el 1, X2 menos que el 2
    assert.ok(g.dnb[0] < g.ml[0] && g.dnb[1] < g.ml[2]);
    for (const k of ['ou', 'ah', 'aou', 'tt1', 'tt2']) assert.ok(g[k].length && pairs(g[k]), k);
    assert.ok(g.ah.some((r) => r[0] % 0.5 !== 0) && g.aou.some((r) => r[0] % 0.5 !== 0)); // líneas de cuarto
    assert.ok(g.ou.every((r) => r[0] % 1 === 0.5));
  }
  assert.equal(nba.length, 2);
  for (const g of nba) {
    assert.deepEqual(Object.keys(g).sort(), ['ml', 'ou', 'spread', 't', 'teams']); // el básquet no cambia
    assert.equal(g.ou.length, 1);
  }
  assert.ok(Object.keys(linesOf(fx.nba)).length > 20);
  assert.equal(atp.length, 2);
  for (const g of atp) {
    assert.equal(g.ml.length, 2);
    assert.equal(g.s1.length, 2);
    assert.ok(g.s1.every((p) => p > 1));
    assert.ok(g.gh.length && pairs(g.gh) && g.gou.length && pairs(g.gou));
    assert.deepEqual(g.ou, []); // el total de games va en gou, no en ou
    // El hándicap de games crece a favor del jugador 1: su cuota baja y la del 2 sube.
    const gh = [...g.gh].sort((a, b) => a[0] - b[0]);
    assert.ok(gh.at(0)[1] > gh.at(-1)[1] && gh.at(0)[2] < gh.at(-1)[2]);
  }
});

test('priceFor con la lectura real: hándicap asiático, total asiático, goles por equipo, doble oportunidad y sin empate, también volteado', async () => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/betano-read.json', import.meta.url), 'utf8'));
  const g = gamesOf(fx.epl)[0], [t1, t2] = g.teams;
  const hit = gameFor({ games: [g] }, { start: new Date(g.t).toISOString(), home: { name: t1 }, away: { name: t2 } });
  const flipped = gameFor({ games: [g] }, { start: new Date(g.t).toISOString(), home: { name: t2 }, away: { name: t1 } });
  assert.equal(hit.flip, false);
  assert.equal(flipped.flip, true);
  const [h, c1, c2] = g.ah[0];
  assert.equal(priceFor(hit, { key: 'ah' }, { name: 'Local', line: h }), c1);
  assert.equal(priceFor(hit, { key: 'ah' }, { name: 'Visitante', line: -h }), c2);
  assert.equal(priceFor(flipped, { key: 'ah' }, { name: 'Local', line: -h }), c2); // el local de Oddsy es el equipo 2 de Betano
  assert.equal(priceFor(hit, { key: 'ah' }, { name: 'Local', line: h + 7 }), null);
  assert.equal(priceFor(hit, { key: 'aou' }, { name: 'Más', line: g.aou[0][0] }), g.aou[0][1]);
  assert.equal(priceFor(hit, { key: 'ou_home' }, { name: 'Menos', line: g.tt1[0][0] }), g.tt1[0][2]);
  assert.equal(priceFor(flipped, { key: 'ou_home' }, { name: 'Menos', line: g.tt2[0][0] }), g.tt2[0][2]);
  assert.equal(priceFor(hit, { key: 'dc' }, { name: 'Local o empate' }), g.dc[0]);
  assert.equal(priceFor(flipped, { key: 'dc' }, { name: 'Local o empate' }), g.dc[1]);
  assert.equal(priceFor(hit, { key: 'dc' }, { name: 'Local o visitante' }), g.dc[2]);
  assert.equal(priceFor(flipped, { key: 'dnb' }, { name: 'Local' }), g.dnb[1]);
  const t = gamesOf(fx.atp)[0];
  const th = gameFor({ games: [t] }, { start: new Date(t.t).toISOString(), home: { name: t.teams[0] }, away: { name: t.teams[1] } });
  assert.equal(priceFor(th, { key: 'ou_games' }, { name: 'Más', line: t.gou[0][0] }), t.gou[0][1]);
  assert.equal(priceFor(th, { key: 'first_set' }, { name: 'B' }), t.s1[1]);
  assert.equal(priceFor(th, { key: 'games_hcp' }, { name: 'A', line: t.gh[0][0] }), t.gh[0][1]);
});
