// Rutas del servidor sin red (fetch simulado con fixtures): The Odds API ya no existe y los parámetros se validan antes de llamar a ESPN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handler, readBody } from '../server.mjs';
import { Readable } from 'node:stream';
import { getSeasonResults } from '../lib/espn.mjs';
import { ratingsFromResults, expected } from '../lib/ratings.mjs';
import { marketsFor } from '../lib/markets.mjs';

const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));

async function call(path) {
  let status, body, headers;
  const res = { writeHead(s, h) { status = s; headers = h; return this; }, end(b) { body = JSON.parse(b); } };
  await handler({ url: path, method: 'GET' }, res);
  return { status, body, headers };
}

test('server: /api/odds y /api/sports ya no existen', async () => {
  assert.equal((await call('/api/odds?sport=basketball_nba')).status, 404);
  assert.equal((await call('/api/sports')).status, 404);
});

test('server: /api/markets valida liga y partido', async () => {
  assert.equal((await call('/api/markets?league=xx')).status, 400);
  assert.equal((await call('/api/markets?league=nba&game=abc')).status, 400);
});

// NBA: summary del partido (event=2 en sede neutral), lista de dos equipos y un calendario por equipo, sin red.
async function withNba(fn) {
  const real = globalThis.fetch;
  const summary = fixture('summary-nba-post.json');
  const neutral = structuredClone(summary);
  neutral.header.competitions[0].neutralSite = true;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const body = u.pathname.endsWith('/summary') ? (u.searchParams.get('event') === '2' ? neutral : summary)
      : u.pathname.endsWith('/scoreboard') ? fixture('scoreboard-nba.json')
      : /\/teams\/\d+\/schedule$/.test(u.pathname) ? fixture('schedule-nba.json')
        : u.pathname.endsWith('/basketball/nba/teams') ? { sports: [{ leagues: [{ teams: [{ team: { id: '8' } }, { team: { id: '5' } }] }] }] } : null;
    return body ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 });
  };
  try { await fn(); } finally { globalThis.fetch = real; }
}

test('server: /api/markets?league=nba&game= trae los mercados Oddsy del partido con caché de CDN', () => withNba(async () => {
  const { status, body, headers } = await call('/api/markets?league=nba&game=1');
  assert.equal(status, 200);
  assert.equal(body.source, 'oddsy');
  assert.equal(body.data.gameId, '401871339');
  assert.ok(body.data.markets.length > 0);
  assert.match(headers['cache-control'], /s-maxage=1800/);
}));

test('server: un partido en sede neutral se cotiza sin ventaja local', () => withNba(async () => {
  const ml = async (game) => (await call(`/api/markets?league=nba&game=${game}`)).body.data.markets.find((m) => m.key === 'ml').selections[0].p;
  const ratings = ratingsFromResults(await getSeasonResults('nba'), { sport: 'basketball' });
  const want = (neutral) => marketsFor('basketball', expected('basketball', ratings, '8', '5', { neutral })).find((m) => m.key === 'ml').selections[0].p;
  assert.equal(await ml(2), want(true));
  assert.equal(await ml(1), want(false));
  assert.notEqual(want(true), want(false));
}));

test('server: /api/accuracy sirve el backtest', async () => {
  const { status, body } = await call('/api/accuracy');
  assert.equal(status, 200);
  assert.equal(body.source, 'oddsy');
  assert.ok(body.data.nba.brier < body.data.nba.baseline.brier);
});

// Tenis: ESPN se reemplaza por los fixtures (rankings y un mes de scoreboard); el snapshot de data/ se lee del disco.
async function withAtp(fn) {
  const real = globalThis.fetch;
  const bodies = { rankings: fixture('atp-rankings.json'), scoreboard: fixture('atp-month.json') };
  globalThis.fetch = async (url) => {
    const body = /\/tennis\/atp\/rankings/.test(url) ? bodies.rankings : /\/tennis\/atp\/scoreboard/.test(url) ? bodies.scoreboard : null;
    if (!body) throw new Error(`fetch inesperado: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try { await fn(); } finally { globalThis.fetch = real; }
}

test('server: /api/tennis/rankings trae el top con Elo', () => withAtp(async () => {
  const { status, body } = await call('/api/tennis/rankings');
  assert.equal(status, 200);
  assert.ok(body.data.length > 0 && body.data.length <= 150);
  assert.equal(body.data[0].rank, 1);
  const zverev = body.data.find((r) => r.player.id === '2375');
  assert.ok(Number.isFinite(zverev.elo));
}));

test('server: /api/tennis/player valida el id y trae rank, puntos, Elo y partidos', () => withAtp(async () => {
  assert.equal((await call('/api/tennis/player?id=abc')).status, 400);
  assert.equal((await call('/api/tennis/player')).status, 400);
  assert.equal((await call('/api/tennis/player?id=999999999')).status, 404);
  const { status, body } = await call('/api/tennis/player?id=2375');
  assert.equal(status, 200);
  assert.equal(body.data.player.name, 'Alexander Zverev');
  assert.equal(body.data.rank, 2);
  assert.ok(body.data.points > 0);
  assert.ok(Number.isFinite(body.data.elo.all) && Number.isFinite(body.data.elo.hard));
  assert.ok(body.data.matches.length >= 5);
}));

test('server: /api/games?league=atp mapea Match a Game (home = a, bandera, rank)', () => withAtp(async () => {
  const { status, body } = await call('/api/games?league=atp&date=20260913');
  assert.equal(status, 200);
  const final = body.data.find((g) => g.id === '182677');
  assert.equal(final.home.name, 'Alexander Zverev');
  assert.equal(final.away.name, 'Ben Shelton');
  assert.match(final.home.logo, /^https:\/\/a\.espncdn\.com\//);
  assert.equal(final.home.record, '#2');
  assert.deepEqual([final.home.score, final.away.score], [3, 1]);
  assert.equal(final.status.detail, '6-3 7-6(2) 5-7 6-2');
}));

test('server: /api/markets?league=atp con Elo, Markov y nombres de jugador', () => withAtp(async () => {
  const { status, body } = await call('/api/markets?league=atp&game=182677&date=20260913');
  assert.equal(status, 200);
  assert.equal(body.source, 'oddsy');
  assert.equal(body.data.game.home.name, 'Alexander Zverev');
  const ml = body.data.markets.find((m) => m.key === 'ml');
  assert.deepEqual(ml.selections.map((s) => s.name), ['A. Zverev', 'B. Shelton']);
  assert.ok(Math.abs(ml.selections[0].p + ml.selections[1].p - 1) < 1e-9);
  assert.ok(body.data.markets.some((m) => m.key === 'ou_sets' && m.label === 'Total de sets 3.5')); // final de Grand Slam: a 5 sets
  assert.ok(body.data.markets.some((m) => m.label === 'A. Zverev gana al menos un set'));
  assert.equal((await call('/api/markets?league=atp&game=999999')).status, 404);
  const day = await call('/api/markets?league=atp&date=20260913');
  assert.ok(day.body.data.some((x) => x.gameId === '182677'));
}));

test('server: tenis no tiene props ni rutas de equipo', () => withAtp(async () => {
  const props = await call('/api/props?league=atp');
  assert.equal(props.status, 200);
  assert.deepEqual(props.body.data, []);
  assert.equal((await call('/api/game?league=atp&id=1')).status, 400);
  assert.equal((await call('/api/injuries?league=atp')).status, 400);
}));

test('server: /api/gamelogs junta varios jugadores y deja en null el que falla', async () => {
  assert.equal((await call('/api/gamelogs?league=nba&ids=1,abc')).status, 400);
  assert.equal((await call(`/api/gamelogs?league=nba&ids=${Array.from({ length: 41 }, (_, i) => i + 1).join(',')}`)).status, 400);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes('/athletes/999')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(u.pathname.endsWith('/gamelog') ? fixture('gamelog-nba.json') : fixture('athlete-nba.json')));
  };
  try {
    const { status, body } = await call('/api/gamelogs?league=nba&ids=3112335,999,3112335');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.data).sort(), ['3112335', '999']);
    assert.ok(body.data['3112335'].games.length > 0);
    assert.equal(body.data['999'], null);
  } finally { globalThis.fetch = real; }
});

test('server: /api/games y /api/game duran 15 s en la CDN, como la caché en memoria del marcador', () => withNba(async () => {
  for (const path of ['/api/games?league=nba&date=20261020', '/api/game?league=nba&id=1']) {
    const { status, headers } = await call(path);
    assert.equal(status, 200, path);
    assert.match(headers['cache-control'], /s-maxage=15,/, path);
  }
}));

test('server: un error de ESPN (5xx) queda en el log con la ruta y el mensaje', async () => {
  const [realFetch, realError] = [globalThis.fetch, console.error];
  const logged = [];
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.equal((await call('/api/injuries?league=nba')).status, 502);
    assert.match(logged.join('\n'), /\/api\/injuries.*ESPN respondió 500/);
  } finally { [globalThis.fetch, console.error] = [realFetch, realError]; }
});

test('server: date debe ser una fecha real y q se recorta antes de validarse', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('sin red'); };
  try {
    for (const path of ['/api/games?league=nba&date=20261399', '/api/picks?league=nba&date=20260230', '/api/markets?league=nba&date=18991231']) {
      assert.equal((await call(path)).body.error, 'Parámetro inválido: date', path);
    }
    assert.notEqual((await call('/api/games?league=nba&date=20240229')).body.error, 'Parámetro inválido: date');
    assert.equal((await call('/api/search?league=nba&q=%20%20')).body.error, 'Falta el parámetro q');
    assert.equal((await call('/api/search?league=nba&q=a%20')).body.error, 'Parámetro inválido: q');
  } finally { globalThis.fetch = real; }
});

test('server: /api/gamelogs no tiene más de 4 pedidos a ESPN en vuelo', async () => {
  const real = globalThis.fetch;
  let now = 0, max = 0;
  globalThis.fetch = async (url) => {
    max = Math.max(max, ++now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
    return new Response(JSON.stringify(new URL(url).pathname.endsWith('/gamelog') ? fixture('gamelog-nba.json') : fixture('athlete-nba.json')));
  };
  try {
    assert.equal((await call('/api/gamelogs?league=nba&ids=11,12,13,14,15,16')).status, 200);
    assert.ok(max <= 4, `${max} en vuelo`);
  } finally { globalThis.fetch = real; }
});

// ---------- seguimiento de apuestas ----------
async function send(method, path) {
  let status, body, headers;
  const res = { writeHead(s, h) { status = s; headers = h; return this; }, end(b) { body = b ? JSON.parse(b) : null; } };
  await handler({ url: path, method, headers: { 'content-type': 'application/json' } }, res);
  return { status, body, headers };
}

test('server: /api/track sin configurar → 503 no-store; el resto de /api sigue solo con GET', async () => {
  const r = await send('POST', '/api/track/read');
  assert.equal(r.status, 503);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.body.error, 'El seguimiento de apuestas no está configurado');
  assert.equal((await send('POST', '/api/markets?league=nba')).status, 405);
});

test('server: readBody acepta JSON hasta 3 MB y usa el cuerpo que ya parseó Vercel', async () => {
  const stream = (chunks, type = 'application/json') => Object.assign(Readable.from(chunks), { method: 'POST', headers: { 'content-type': type } });
  assert.deepEqual(await readBody(stream([Buffer.from('{"text":'), Buffer.from('"hola"}')])), { text: 'hola' });
  await assert.rejects(readBody(stream([Buffer.alloc(2e6), Buffer.alloc(2e6)])), (e) => e.status === 413);
  await assert.rejects(readBody(stream(['x'], 'text/plain')), (e) => e.status === 415);
  await assert.rejects(readBody(stream(['{no'])), (e) => e.status === 400);
  assert.deepEqual(await readBody({ method: 'POST', body: { image: 'QUJD' } }), { image: 'QUJD' });
  assert.equal(await readBody({ method: 'GET' }), null);
});
