// Props con línea y cuotas propias (modelo Oddsy) sobre game logs de ESPN. Sin red: fixtures y fetch simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { propLine, playerProps, getProps, oppEvents, oppTotals, oppFactor, withOpp, OPP } from '../lib/props.mjs';
import { normGamelog, buildGameLog } from '../lib/espn.mjs';
import { normalOver } from '../lib/pricing.mjs';
import { propOver } from '../public/betmath.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Copia del game log con otros eventId y un año antes: hace de temporada anterior (el fixture trae solo 6 partidos).
const rekey = (j, s) => ({
  ...j,
  seasonTypes: j.seasonTypes.map((st) => ({ ...st, categories: st.categories.map((c) => ({ ...c, events: (c.events ?? []).map((e) => ({ ...e, eventId: e.eventId + s })) })) })),
  events: Object.fromEntries(Object.entries(j.events).map(([k, v]) => [k + s, { ...v, id: k + s, gameDate: v.gameDate.replace('2026', '2025') }])),
});
const nbaLog = (lists = [fx('gamelog-nba.json'), rekey(fx('gamelog-nba.json'), 'p')]) =>
  buildGameLog({ id: '4433188', name: 'Devin Carter' }, 'basketball', lists.map((j) => normGamelog(j, 'basketball')));
const ctx = { league: 'nba', gameId: '401871339', start: '2026-05-18T00:00:00.000Z', team: 'BOS', opp: 'DET' };

test('propLine: mínimo de 8 partidos, línea = mediana redondeada a .5', () => {
  assert.equal(propLine([1, 2, 3, 4, 5, 6, 7]), null);
  const r = propLine(Array(20).fill(10));
  assert.equal(r.line, 10.5);
  assert.ok(r.pOver < 0.5, `pOver ${r.pOver}`);
});

test('pts usa la normal; los conteos, la binomial negativa', () => {
  const log = nbaLog();
  const vals = log.games.map((g) => g.stats.pts);
  const r = propLine(vals, 'normal');
  const m = 0.5 * avg(vals.slice(0, 10)) + 0.3 * avg(vals) + 0.2 * avg(vals.slice(0, 5));
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - avg(vals)) ** 2, 0) / (vals.length - 1));
  assert.equal(r.pOver, Math.min(0.99, Math.max(0.01, normalOver(m, Math.max(sd, 1), r.line))));
  const over = playerProps(log, 'basketball', ctx).find((p) => p.stat === 'pts' && p.side === 'Over');
  assert.equal(over.p, r.pOver);
  assert.notEqual(over.p, propLine(vals, 'count').pOver);
});
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

test('playerProps: Over y Under a la línea propia con cuota Oddsy < justa', () => {
  const props = playerProps(nbaLog(), 'basketball', ctx);
  assert.ok(props.length >= 2);
  for (const p of props) {
    assert.equal(p.books.length, 1);
    assert.equal(p.books[0].key, 'oddsy');
    assert.ok(p.books[0].price < p.fair, `${p.id}: ${p.books[0].price} >= ${p.fair}`);
    assert.ok(Math.abs(p.fair - 1 / p.p) <= 0.005 + 1e-9); // redondeada a 2 decimales
    assert.equal(p.n, 12);
    assert.deepEqual([p.gameId, p.eventId, p.team, p.opp, p.athleteId, p.player], ['401871339', '401871339', 'BOS', 'DET', '4433188', 'Devin Carter']);
    const twin = props.find((q) => q.stat === p.stat && q.line === p.line && q.side !== p.side);
    assert.ok(Math.abs(p.p + twin.p - 1) < 1e-12);
    // El navegador cotiza otras líneas con kind, mean y variance: en la línea Oddsy da la misma p. Doble-doble: la media.
    const over = p.kind === 'binary' ? p.mean : propOver(p.kind, p.mean, p.variance, p.line);
    assert.ok(Math.abs((p.side === 'Over' ? over : 1 - over) - p.p) < 1e-12, `${p.id}`);
  }
  assert.equal(new Set(props.map((p) => p.id)).size, props.length);
  assert.deepEqual(playerProps(nbaLog([fx('gamelog-nba.json')]), 'basketball', ctx), []); // 6 partidos: sin props
});

test('getProps(liga, partido) con fetch simulado: plantillas + game logs → props Oddsy', async (t) => {
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/summary')) return reply(fx('summary-nba-post.json'));
    if (u.pathname.endsWith('/roster')) return reply(fx('roster-nba.json'));
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('nba', '401871339');
  assert.equal(res.source, 'oddsy');
  assert.ok(res.data.length > 0);
  assert.ok(res.data.every((p) => p.books[0].key === 'oddsy' && p.gameId === '401871339' && ['DET', 'CLE'].includes(p.team)));
  assert.ok(res.data.some((p) => p.player === 'Mike Conley'), 'el nombre sale de la plantilla si el perfil falla');
  await assert.rejects(getProps('xx'), { status: 400 });
});

test('propOver: líneas personalizadas; en una línea entera el push se descuenta', () => {
  const pois = [0, 1, 2].map((k) => Math.exp(-2) * 2 ** k / [1, 1, 2][k]); // Poisson(2): varianza = media
  const over2 = 1 - pois[0] - pois[1] - pois[2];
  assert.ok(Math.abs(propOver('count', 2, 2, 2.5) - over2) < 1e-12);
  assert.ok(Math.abs(propOver('count', 2, 2, 2) - over2 / (over2 + pois[0] + pois[1])) < 1e-12); // X = 2 se devuelve
  assert.ok(Math.abs(propOver('normal', 10, 16, 10.5) - normalOver(10, 4, 10.5)) < 1e-12);
  assert.ok(Math.abs(propOver('normal', 10, 16, 10) - 0.5) < 1e-12); // simétrica alrededor de la media
  assert.equal(propOver('count', 1, 1, 30), 0.01);
  assert.equal(propOver('normal', 30, 4, 0.5), 0.99);
});

test('getProps(liga) sin partido: a lo sumo 4 pedidos a ESPN en vuelo y sin pedir perfiles', async (t) => {
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const board = fx('scoreboard-nba.json');
  const [ev] = board.events;
  board.events = [['8', '2'], ['10', '11'], ['12', '13']].map(([h, a], i) => ({ ...ev, id: `90${i}`,
    competitions: [{ ...ev.competitions[0], competitors: ev.competitions[0].competitors.map((c) => ({ ...c, team: { ...c.team, id: c.homeAway === 'home' ? h : a } })) }] }));
  const roster = fx('roster-nba.json');
  const urls = [];
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const u = new URL(url);
    const team = /teams\/(\d+)\/roster$/.exec(u.pathname)?.[1];
    if (u.pathname.endsWith('/scoreboard')) return reply(board);
    if (team) return reply({ ...roster, team: { ...roster.team, id: team }, athletes: roster.athletes.map((a) => ({ ...a, id: `${team}0${a.id}` })) });
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('wnba');
  assert.deepEqual(new Set(res.data.map((p) => p.gameId)), new Set(['900', '901', '902']));
  assert.equal(urls.filter((u) => u.includes('/gamelog')).length, 6 * 3 * 2); // 6 plantillas × 3 jugadores × 2 temporadas
  assert.ok(!urls.some((u) => /\/athletes\/\d+$/.test(new URL(u).pathname)), 'el perfil sale de la plantilla');
  assert.ok(peak > 1 && peak <= 4, `pico ${peak}`);
});

test('doble-doble y triple-doble: 0/1 por partido, una sola línea 0.5 con P(Más) = la media mezclada', () => {
  const games = Array.from({ length: 20 }, (_, i) => ({ stats: { pts: 24, reb: i % 5 ? 11 : 6, ast: 4 } })); // 80 % doble-doble
  const dd = playerProps({ athlete: { id: '7', name: 'Pívot' }, games }, 'basketball', ctx).filter((p) => p.stat === 'dd');
  assert.deepEqual(dd.map((p) => [p.side, p.line]), [['Over', 0.5], ['Under', 0.5]]); // antes: Más 1.5, imposible
  assert.ok(Math.abs(dd[0].p - 0.8) < 0.05, `p ${dd[0].p}`); // antes: 0.40 en la línea 0.5
  assert.equal(dd[0].kind, 'binary');
  const r = propLine(Array(12).fill(1), 'binary');
  assert.equal(r.line, 0.5);
  assert.equal(r.pOver, 0.99); // tope como las demás
});

const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
// Scoreboard con un partido por [local, visita, estado, inicio].
const board = (games) => {
  const b = fx('scoreboard-nba.json'), [ev] = b.events, comp = ev.competitions[0];
  b.events = games.map(([h, a, state, date]) => ({ ...ev, id: `9${h}${a}`, date, status: { ...ev.status, type: { ...ev.status.type, state } },
    competitions: [{ ...comp, date, competitors: comp.competitors.map((c) => ({ ...c, team: { ...c.team, id: c.homeAway === 'home' ? h : a } })) }] }));
  return b;
};
// ESPN simulado para getProps sin partido: scoreboard(url) da el tablero; down(url), si ESPN corta con 403. Plantillas de 3.
const mockEspn = (t, scoreboard, down = () => false) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    const u = new URL(url), team = /teams\/(\d+)\/roster$/.exec(u.pathname)?.[1];
    const off = down(u);
    if (off) return new Response('{}', { status: off === true ? 403 : off });
    if (u.pathname.endsWith('/scoreboard')) return reply(scoreboard(u));
    if (team) {
      const r = fx('roster-nba.json');
      return reply({ ...r, team: { ...r.team, id: team }, athletes: r.athletes.map((a) => ({ ...a, id: `${team}0${a.id}` })) });
    }
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  return urls;
};

test('getProps: con más del 10 % de plantillas o de game logs caídos, 502 (no se cachea un vacío); uno caído entre 18 sigue', async (t) => {
  let down = (u) => u.pathname.endsWith('/roster');
  mockEspn(t, () => board([['70', '71', 'pre', '2026-10-21T23:00Z'], ['72', '73', 'pre', '2026-10-21T23:00Z'], ['74', '75', 'pre', '2026-10-21T23:00Z']]), (u) => down(u));
  await assert.rejects(getProps('mlb'), { status: 502, message: /plantillas/ }); // antes: 200 con data: [] y 30 min en la CDN
  const failed = (ids) => (u) => ids.some((id) => u.pathname.endsWith(`/athletes/${id}/gamelog`));
  down = failed(['7004433188', '7105142621']); // 2 de 18 jugadores
  await assert.rejects(getProps('mlb'), { status: 502, message: /game logs/ });
  down = failed(['7004433188']);
  assert.ok(Array.isArray((await getProps('mlb')).data));
});

test('getProps: un 404 (jugador sin game log) no cuenta como caída', async (t) => {
  // Liga que no usa otro test: la caché de fetchJson guarda tableros y game logs entre tests.
  mockEspn(t, () => board([['80', '81', 'pre', '2026-10-21T23:00Z'], ['82', '83', 'pre', '2026-10-21T23:00Z'], ['84', '85', 'pre', '2026-10-21T23:00Z']]),
    (u) => u.pathname.includes('/athletes/80') && u.pathname.endsWith('/gamelog') && 404); // 6 de 18
  assert.ok(Array.isArray((await getProps('epl')).data));
});

test('getProps(liga) de noche: si ya empezaron todos los de hoy, los de mañana según el día de ESPN (hora de Nueva York)', async (t) => {
  // 02:00Z del 22 son las 22:00 del 21 en Nueva York: mañana es el 22, no el 23.
  const today = board([['60', '61', 'in', '2026-10-21T23:30Z'], ['62', '63', 'post', '2026-10-22T02:00Z']]);
  const next = board([['64', '65', 'pre', '2026-10-22T23:30Z'], ['66', '67', 'pre', '2026-10-23T00:00Z']]);
  const urls = mockEspn(t, (u) => (u.searchParams.get('dates') === '20261022' ? next : today));
  const res = await getProps('nba');
  assert.deepEqual(urls.filter((u) => u.includes('/scoreboard')).map((u) => new URL(u).searchParams.get('dates')), [null, '20261022']);
  assert.deepEqual(new Set(res.data.map((p) => p.gameId)), new Set(['96465', '96667']));
});

test('props: fútbol (Liga BetPlay) cotiza goles y tiros a partir del game log', () => {
  const games = Array.from({ length: 12 }, (_, i) => ({ minutes: 90, stats: { goals: i % 3 === 0 ? 1 : 0, shots: 2 + (i % 3), sot: i % 2, yc: 0 } }));
  const out = playerProps({ athlete: { id: '9', name: 'Delantero' }, games }, 'soccer', { league: 'colombia', gameId: 'g1', start: '2026-11-01T19:00Z', team: 'AME', opp: 'MIL' });
  assert.ok(out.some((p) => p.market === 'player_shots' && p.side === 'Over'));
  assert.ok(out.every((p) => p.league === 'colombia' && p.books[0].price > 1));
});

test('rival: oppEvents/oppTotals suman lo permitido contra la media previa; el factor escala media y varianza', () => {
  // 10 partidos de 10 puntos (del más reciente al más viejo) y el más reciente, 20 contra el equipo 7.
  const games = [{ minutes: 30, date: '2026-01-11', opp: { id: 7 }, stats: { pts: 20 } },
    ...Array.from({ length: 10 }, (_, i) => ({ minutes: 30, date: `2026-01-0${i}`, opp: { id: 9 }, stats: { pts: 10 } }))];
  const ev = oppEvents(games, ['pts']);
  assert.equal(ev.length, 3); // con al menos 8 previos: los 2 más viejos no cuentan
  assert.deepEqual(oppTotals(ev)['7'].pts, { v: 20, e: 10 });
  const cfg = OPP.nba;
  const f = oppFactor({ v: 20, e: 10 }, 10, cfg);
  assert.ok(Math.abs(f - (420 / 410) ** cfg.w) < 1e-12); // k·m20 = 40·10
  assert.equal(oppFactor(null, 10, cfg), 1);
  const r = propLine(Array(20).fill(10), 'count');
  const up = withOpp(r, 'count', 1.2);
  assert.ok(Math.abs(up.mean - r.mean * 1.2) < 1e-12 && Math.abs(up.variance - r.variance * 1.2) < 1e-12 && up.pOver > r.pOver);
  assert.equal(withOpp(r, 'binary', 1.2), r);
});

test('playerProps: con el rival en contra de los puntos sube la P(Más) de pts y no toca las demás', () => {
  const plain = playerProps(nbaLog(), 'basketball', ctx);
  const tough = playerProps(nbaLog(), 'basketball', { ...ctx, oppStats: { cfg: OPP.nba, totals: { pts: { v: 1100, e: 1000 } } } });
  const over = (ps, s) => ps.find((p) => p.stat === s && p.side === 'Over');
  assert.ok(over(tough, 'pts').p > over(plain, 'pts').p);
  assert.equal(over(tough, 'reb')?.p, over(plain, 'reb')?.p);
});
