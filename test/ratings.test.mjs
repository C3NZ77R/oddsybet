// Ratings de equipos: normalizador de calendarios (fixture real de ESPN), modelo de fuerzas y getSeasonResults
// con fetch simulado. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normSchedule, getSeasonResults, getPastSeason } from '../lib/espn.mjs';
import { ratingsFromResults, expected, SPORT_MODEL, SIGMA, SIGMA_T, MU_SHRINK, HALF_LIFE, NEWCOMER } from '../lib/ratings.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const R = (id, date, homeId, awayId, homeScore, awayScore, neutral = false) => ({ id, date, homeId, awayId, homeScore, awayScore, neutral });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// Doble round robin generado exactamente por un modelo: score(local, visita) → [goles local, goles visita].
const league = (ids, score) => {
  const rs = [];
  let d = 0;
  for (const h of ids) for (const a of ids) if (h !== a) rs.push(R(`${h}${a}`, new Date(Date.UTC(2026, 0, 1 + d++)).toISOString(), h, a, ...score(h, a)));
  return rs;
};

test('ratings: el calendario de ESPN se normaliza a 10 resultados numéricos', () => {
  const res = normSchedule(fx('schedule-nba.json'), 'basketball');
  assert.equal(res.length, 10);
  for (const r of res) {
    assert.ok(r.id && r.date && r.homeId && r.awayId && r.homeId !== r.awayId);
    assert.ok(Number.isFinite(r.homeScore) && Number.isFinite(r.awayScore));
    assert.equal(r.neutral, false);
  }
});

test('ratings: ignora partidos sin terminar o sin marcador', () => {
  const json = fx('schedule-nba.json');
  json.events[0].competitions[0].status.type = { state: 'pre', completed: false };
  json.events[1].competitions[0].competitors[0].score = undefined;
  json.events[2].competitions[0].competitors[0].score = '101'; // forma string
  const res = normSchedule(json);
  assert.equal(res.length, 8);
  assert.ok(res.some((r) => r.homeScore === 101 || r.awayScore === 101));
  assert.deepEqual(normSchedule(null), []);
});

test('ratings: aplazados, cancelados y pretemporada no son resultados; neutral se conserva', () => {
  const json = fx('schedule-nba.json');
  const zero = { value: 0, displayValue: '0' };
  for (const [i, name] of [[0, 'STATUS_POSTPONED'], [1, 'STATUS_CANCELED']]) {
    const c = json.events[i].competitions[0];
    c.status.type = { name, state: 'post', completed: false };
    for (const x of c.competitors) x.score = zero;
  }
  json.events[2].seasonType = { id: '1', type: 1, name: 'Preseason' };
  json.events[3].seasonType = { id: '1', type: 14308, name: 'Premier League' }; // fútbol: id 1, type propio de la liga
  json.events[4].competitions[0].neutralSite = true;
  const res = normSchedule(json, 'basketball');
  assert.equal(res.length, 7);
  const ids = res.map((r) => r.id);
  for (const i of [0, 1, 2]) assert.ok(!ids.includes(json.events[i].id));
  assert.ok(ids.includes(json.events[3].id));
  assert.equal(res.find((r) => r.id === json.events[4].id).neutral, true);
});

test('ratings: fútbol con prórroga se descarta', () => {
  const json = fx('schedule-nba.json');
  const set = (i, period, h, a) => {
    const c = json.events[i].competitions[0];
    c.status.period = period;
    c.competitors.find((x) => x.homeAway === 'home').score = { value: h, displayValue: String(h) };
    c.competitors.find((x) => x.homeAway === 'away').score = { value: a, displayValue: String(a) };
  };
  set(0, 5, 3, 4); // Final/SO
  set(1, 4, 2, 1); // Final/OT
  set(2, 3, 5, 2); // tiempo regular
  const pick = (res, i) => res.find((r) => r.id === json.events[i].id);
  const soccer = normSchedule(json, 'soccer');
  assert.equal(soccer.length, 7); // en fútbol los periodos 3-5 son prórroga y penales
  assert.ok(!pick(soccer, 2) && pick(soccer, 3));
});

test('ratings: equipo sin partidos = media de liga (en fútbol, con el prior de recién llegado)', () => {
  const rs = [R('1', '2026-01-01', 'A', 'B', 2, 1), R('2', '2026-01-02', 'B', 'A', 3, 0)];
  const ra = ratingsFromResults(rs, { sport: 'soccer' });
  const e = expected('soccer', ra, 'X', 'Y');
  const { gf, ga } = NEWCOMER.soccer;
  close(e.lh, ra.avgHome * gf * ga);
  close(e.la, ra.avgAway * gf * ga);
});

test('ratings: sin resultados todo es finito', () => {
  for (const sport of Object.keys(SPORT_MODEL)) {
    const ra = ratingsFromResults([], { sport });
    const e = expected(sport, ra, 'X', 'Y');
    for (const v of Object.values(e)) if (typeof v === 'number') assert.ok(Number.isFinite(v) && v >= 0, `${sport}`);
    if (e.kind === 'poisson') assert.ok(e.lh > 0 && e.la > 0);
    else assert.ok(e.total > 0 && e.sigma > 0);
  }
  assert.throws(() => ratingsFromResults([], { sport: 'tennis' }), TypeError);
  assert.throws(() => expected('tennis', ratingsFromResults([], { sport: 'soccer' }), 'X', 'Y'), TypeError);
});

test('ratings: asOf excluye partidos futuros y acepta número, ISO o Date', () => {
  const base = [R('1', '2026-01-01T00:00:00.000Z', 'A', 'B', 2, 1)];
  const fut = [...base, R('2', '2026-03-01T00:00:00.000Z', 'A', 'B', 9, 0)];
  const asOf = Date.parse('2026-02-01T00:00:00.000Z');
  const a = ratingsFromResults(base, { sport: 'soccer', asOf });
  const b = ratingsFromResults(fut, { sport: 'soccer', asOf });
  assert.equal(b.teams.get('A').gp, 1);
  assert.deepEqual(b.teams.get('A'), a.teams.get('A'));
  assert.equal(b.avgHome, a.avgHome);
  assert.deepEqual(ratingsFromResults(fut, { sport: 'soccer', asOf: '2026-02-01T00:00:00.000Z' }), b);
  assert.deepEqual(ratingsFromResults(fut, { sport: 'soccer', asOf: new Date(asOf) }), b);
  assert.throws(() => ratingsFromResults(fut, { sport: 'soccer', asOf: 'xyz' }), TypeError);
});

test('ratings: la ventaja local sale solo de partidos con sede', () => {
  const rs = [R('1', '2026-01-01', 'A', 'B', 110, 100), R('2', '2026-01-02', 'B', 'A', 104, 100), R('3', '2026-01-03', 'A', 'B', 90, 130, true)];
  const ra = ratingsFromResults(rs, { sport: 'basketball' });
  assert.equal(ra.avgHome, 107);
  assert.equal(ra.avgAway, 100);
  assert.equal(ra.teams.get('A').gp, 3); // el neutral sí cuenta para la fuerza
});

// Liga aditiva exacta: off/def = puntos a favor/en contra ante un rival medio, m0 = 115, ventaja local 3.
const OFF = { A: 125, B: 115, C: 110, D: 110 };
const DEF = { A: 105, B: 115, C: 110, D: 130 };
const additive = league(['A', 'B', 'C', 'D'], (h, a) => [OFF[h] + DEF[a] - 115 + 1.5, OFF[a] + DEF[h] - 115 - 1.5]);

test('ratings: modelo normal recupera margen y total de una liga aditiva (prior 0)', () => {
  const ra = ratingsFromResults(additive, { sport: 'basketball', prior: 0 });
  close(ra.avgHome - ra.avgAway, 3);
  const e = expected('basketball', ra, 'A', 'D');
  const k = MU_SHRINK.basketball; // regresión a la media calibrada en el backtest
  close(e.mu, 43 * k); // (125 + 130) − (110 + 105) + 3
  close(e.total, 240); // 125 + 130 + 110 + 105 − 2·115
  close(expected('basketball', ra, 'A', 'D', { neutral: true }).mu, 40 * k);
  close(expected('basketball', ra, 'D', 'A').mu, -37 * k);
  close(expected('basketball', ra, 'B', 'C').total, (115 + 110 + 110 + 115) - 230);
});

test('ratings: ajuste por rival distingue un calendario débil', () => {
  // X e Y ganan 2-1 cada partido, pero X solo juega contra el colista Z y Y contra el líder W.
  const rs = [
    ...league(['W', 'Z'], (h) => (h === 'W' ? [3, 0] : [0, 3])),
    R('x1', '2026-02-01', 'X', 'Z', 2, 1), R('x2', '2026-02-02', 'Z', 'X', 1, 2),
    R('y1', '2026-02-03', 'Y', 'W', 2, 1), R('y2', '2026-02-04', 'W', 'Y', 1, 2),
  ];
  const ra = ratingsFromResults(rs, { sport: 'soccer', prior: 0 });
  assert.ok(ra.teams.get('Y').gf > ra.teams.get('X').gf);
});

test('ratings: modelo poisson recupera los goles esperados de una liga multiplicativa (prior 0)', () => {
  const att = { A: 1.6, B: 1.2, C: 1.0, D: 0.8 };
  const def = { A: 0.7, B: 1.0, C: 1.1, D: 1.4 };
  const rs = league(['A', 'B', 'C', 'D'], (h, a) => [1.5 * att[h] * def[a], 1.1 * att[a] * def[h]]);
  const ra = ratingsFromResults(rs, { sport: 'soccer', prior: 0, halfLife: Infinity }); // sin peso: la identidad es exacta
  const e = expected('soccer', ra, 'A', 'D');
  close(e.lh, 1.5 * 1.6 * 1.4);
  close(e.la, 1.1 * 0.8 * 0.7);
});

test('ratings: shrink = punto fijo (suma ajustada + prior·media)/(partidos + prior)', () => {
  const prior = 5;
  for (const sport of ['basketball', 'soccer']) {
    const rs = sport === 'soccer' ? league(['A', 'B', 'C'], (h, a) => [h === 'A' ? 3 : 1, a === 'C' ? 0 : 2]) : additive;
    const ra = ratingsFromResults(rs, { sport, prior, halfLife: Infinity }); // la fórmula de abajo es sin peso
    const m = (ra.avgHome + ra.avgAway) / 2;
    const v = (home) => (sport === 'soccer' ? (home ? ra.avgHome / m : ra.avgAway / m) : (home ? ra.avgHome - m : ra.avgAway - m));
    for (const [id, t] of ra.teams) {
      const gs = rs.filter((r) => r.homeId === id || r.awayId === id).map((r) => {
        const home = r.homeId === id;
        return { o: ra.teams.get(home ? r.awayId : r.homeId), pf: home ? r.homeScore : r.awayScore, pa: home ? r.awayScore : r.homeScore, v: v(home), vo: v(!home) };
      });
      const s = (f) => gs.reduce((x, g) => x + f(g), 0);
      const [gf, ga] = sport === 'soccer'
        ? [(s((g) => g.pf) + prior * m) / (s((g) => (g.v * g.o.ga) / m) + prior), (s((g) => g.pa) + prior * m) / (s((g) => (g.vo * g.o.gf) / m) + prior)]
        : [(s((g) => g.pf - g.o.ga + m - g.v) + prior * m) / (gs.length + prior), (s((g) => g.pa - g.o.gf + m - g.vo) + prior * m) / (gs.length + prior)];
      close(t.gf, gf);
      close(t.ga, ga);
      assert.equal(t.gp, gs.length);
    }
    // con un prior enorme todos vuelven a la media de liga
    for (const t of ratingsFromResults(rs, { sport, prior: 1e9, halfLife: Infinity }).teams.values()) close(t.gf, m, 1e-6 * m);
  }
});

test('ratings: halfLife pesa más lo reciente; el valor por defecto sale de HALF_LIFE', () => {
  const d = (m) => new Date(Date.UTC(2026, m, 1)).toISOString();
  const rs = [['1', '2', 4, 0, 0], ['2', '1', 0, 4, 1], ['1', '2', 0, 0, 9], ['2', '1', 0, 0, 10]].map(([h, a, hs, as, m], i) =>
    ({ id: `g${i}`, date: d(m), homeId: h, awayId: a, homeScore: hs, awayScore: as, neutral: true }));
  const asOf = d(11);
  const flat = ratingsFromResults(rs, { sport: 'soccer', asOf, prior: 0, halfLife: Infinity });
  assert.deepEqual(ratingsFromResults(rs, { sport: 'soccer', asOf, prior: 0 }), ratingsFromResults(rs, { sport: 'soccer', asOf, prior: 0, halfLife: HALF_LIFE.soccer }));
  assert.deepEqual(ratingsFromResults(rs, { sport: 'basketball', asOf, prior: 0 }), ratingsFromResults(rs, { sport: 'basketball', asOf, prior: 0, halfLife: Infinity }));
  const decayed = ratingsFromResults(rs, { sport: 'soccer', asOf, prior: 0, halfLife: 30 });
  // '1' goleó a comienzos de año y empató 0-0 al final: con decaimiento su ataque cae hacia lo reciente.
  assert.ok(decayed.teams.get('1').gf < flat.teams.get('1').gf);
  for (const t of decayed.teams.values()) assert.ok(Number.isFinite(t.gf) && Number.isFinite(t.ga));
});

test('ratings: equipo nuevo (recién ascendido o sin partidos) arranca bajo la media en fútbol', () => {
  const d = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();
  // A, B y C llevan muchos partidos parejos; N (ascendido) jugó uno solo, 1-1.
  const rs = [];
  for (let i = 0; i < 30; i++) {
    const [h, a] = [['A', 'B'], ['B', 'C'], ['C', 'A']][i % 3];
    rs.push(R(`g${i}`, d(1 + i), h, a, 1, 1));
  }
  rs.push(R('n1', d(40), 'N', 'A', 1, 1));
  const opts = { sport: 'soccer', prior: 5, halfLife: Infinity };
  const plain = ratingsFromResults(rs, { ...opts, newcomer: null });
  const ra = ratingsFromResults(rs, opts);
  assert.ok(ra.teams.get('N').gf < plain.teams.get('N').gf);
  assert.ok(ra.teams.get('N').ga > plain.teams.get('N').ga);
  close(ra.teams.get('A').gf, plain.teams.get('A').gf, 0.02); // los establecidos casi no cambian
  // sin partidos: expected usa el prior de NEWCOMER
  const e = expected('soccer', ra, 'Z', 'A');
  const e0 = expected('soccer', ra, 'B', 'A');
  assert.ok(e.lh < e0.lh);
  // otros deportes: sin prior de nuevo
  assert.equal(NEWCOMER.basketball, undefined);
});

test('ratings: expected con ratings a mano (normal y poisson, con y sin sede)', () => {
  const nba = { teams: new Map([['A', { gf: 115, ga: 105 }], ['B', { gf: 105, ga: 115 }]]), avgHome: 111.5, avgAway: 108.5 };
  const e = expected('basketball', nba, 'A', 'B');
  assert.equal(e.kind, 'normal');
  assert.equal(e.sigma, SIGMA.basketball);
  assert.equal(e.sigmaT, SIGMA_T.basketball);
  assert.equal(expected('basketball', nba, 'A', 'B', { league: 'nba' }).sigmaT, SIGMA_T.basketball);
  assert.equal(expected('basketball', nba, 'A', 'B', { league: 'wnba' }).sigmaT, 16.4); // la WNBA anota menos: su propio σ_T
  const k = MU_SHRINK.basketball;
  assert.ok(k > 0 && k <= 1);
  close(e.mu, 23 * k); // +10 − (−10) + 3
  close(e.total, 220);
  close(expected('basketball', nba, 'A', 'B', { neutral: true }).mu, 20 * k);
  close(expected('basketball', nba, 'A', 'A').mu, 3 * k); // equipos iguales = ventaja local
  close(expected('basketball', nba, 'A', 'A', { neutral: true }).mu, 0);

  const epl = { teams: new Map([['A', { gf: 2, ga: 1 }], ['B', { gf: 1, ga: 1.5 }]]), avgHome: 1.6, avgAway: 1.2 };
  const p = expected('soccer', epl, 'A', 'B');
  close(p.lh, (1.6 * 2 * 1.5) / 1.96);
  close(p.la, (1.2 * 1 * 1) / 1.96);
  const n = expected('soccer', epl, 'A', 'B', { neutral: true });
  close(n.lh, (1.4 * 2 * 1.5) / 1.96);
  close(n.la, 1.4 / 1.96);
  const eq = expected('soccer', epl, 'A', 'A', { neutral: true });
  close(eq.lh, eq.la);
});

// ---------- getSeasonResults con fetch simulado ----------
const ev = (id, date, homeId, awayId, hs, as, type = { name: 'STATUS_FINAL', state: 'post', completed: true }) => ({
  id, date, seasonType: { type: 2 },
  competitions: [{ date, neutralSite: false, status: { type },
    competitors: [{ homeAway: 'home', team: { id: homeId }, score: { value: hs } }, { homeAway: 'away', team: { id: awayId }, score: { value: as } }] }],
});
const games = (prefix, teamId, n, oppId = '99') =>
  Array.from({ length: n }, (_, i) => ev(`${prefix}${i}`, new Date(Date.UTC(2026, 3, 1 + i)).toISOString(), teamId, oppId, 5, 3));

async function withFetch(routes, fn) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const key = String(url).replace(/^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\//, '');
    const body = routes[key];
    if (body === undefined) throw new Error(`URL inesperada: ${key}`);
    return typeof body === 'number' ? new Response('{}', { status: body }) : new Response(JSON.stringify(body));
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = real;
  }
}

test('getSeasonResults: con pocos partidos suma la temporada anterior, quita duplicados y memoriza', async () => {
  const shared = ev('s1', '2026-10-15T00:00:00.000Z', '1', '2', 110, 100);
  const prevShared = ev('p1', '2026-03-01T00:00:00.000Z', '2', '1', 99, 98);
  const cur = (evs) => ({ requestedSeason: { year: 2027, type: 2 }, events: evs });
  const prev = (teamId) => ({ requestedSeason: { year: 2026, type: 2 }, events: [prevShared, ...games(`p${teamId}-`, teamId, 12)] });
  const routes = {
    'basketball/nba/teams': { sports: [{ leagues: [{ teams: [{ team: { id: '1' } }, { team: { id: '2' } }, { team: { id: '../x' } }] }] }] },
    'basketball/nba/teams/1/schedule': cur([shared, ev('f1', '2026-10-30T00:00:00.000Z', '1', '2', 0, 0, { state: 'pre', completed: false })]),
    'basketball/nba/teams/2/schedule': cur([shared]),
    'basketball/nba/teams/1/schedule?season=2026': prev('1'),
    'basketball/nba/teams/2/schedule?season=2026': prev('2'),
  };
  await withFetch(routes, async (urls) => {
    const res = await getSeasonResults('nba');
    assert.equal(res.length, 1 + 1 + 24);
    assert.equal(new Set(res.map((r) => r.id)).size, res.length);
    assert.ok(urls.some((u) => u.endsWith('/teams/1/schedule?season=2026')));
    assert.ok(!urls.some((u) => u.includes('seasontype') || u.includes('../x')));
    const n = urls.length;
    assert.equal((await getSeasonResults('nba')).length, res.length);
    assert.equal(urls.length, n, 'la segunda llamada sale de la memoria');
  });
});

test('getSeasonResults: fútbol suma la temporada anterior aunque la vigente ya tenga muchos partidos', async () => {
  const cur = (teamId) => ({ requestedSeason: { year: 2026, type: 1 }, events: games(`c${teamId}-`, teamId, 15) });
  const prev = (teamId) => ({ requestedSeason: { year: 2025, type: 1 }, events: games(`q${teamId}-`, teamId, 3) });
  await withFetch({
    'soccer/col.1/teams': { sports: [{ leagues: [{ teams: [{ team: { id: '1' } }, { team: { id: '2' } }] }] }] },
    'soccer/col.1/teams/1/schedule': cur('1'),
    'soccer/col.1/teams/2/schedule': cur('2'),
    'soccer/col.1/teams/1/schedule?season=2025': prev('1'),
    'soccer/col.1/teams/2/schedule?season=2025': prev('2'),
  }, async () => {
    assert.equal((await getSeasonResults('colombia')).length, 2 * 15 + 2 * 3);
  });
});

test('getSeasonResults: en playoffs pide la fase regular vigente y no la temporada anterior', async () => {
  const post = (teamId) => ({ requestedSeason: { year: 2026, type: 3 }, events: [
    ...games(`po${teamId}-`, teamId, 2),
    ev(`pp${teamId}`, '2026-10-10T00:00:00.000Z', teamId, '99', 0, 0, { name: 'STATUS_POSTPONED', state: 'post', completed: false }),
  ] });
  const reg = (teamId) => ({ requestedSeason: { year: 2026, type: 2 }, events: games(`rg${teamId}-`, teamId, 12) });
  const routes = {
    'baseball/mlb/teams/10/schedule': post('10'),
    'baseball/mlb/teams/19/schedule': post('19'),
    'baseball/mlb/teams/10/schedule?seasontype=2': reg('10'),
    'baseball/mlb/teams/19/schedule?seasontype=2': reg('19'),
  };
  await withFetch(routes, async (urls) => {
    const res = await getSeasonResults('mlb', { teamIds: ['10', 19] });
    assert.equal(res.length, 2 * (2 + 12));
    assert.ok(!res.some((r) => r.id.startsWith('pp')), 'aplazado 0-0 fuera');
    assert.ok(!urls.some((u) => u.includes('season=')));
    assert.ok(!urls.some((u) => u.endsWith('/teams')), 'teamIds evita pedir la lista de equipos');
    assert.deepEqual(new Set(urls.map((u) => /teams\/(\d+)/.exec(u)[1])), new Set(['10', '19']));
  });
});

test('getSeasonResults: si ESPN falla en demasiados calendarios es un error 502, no una liga vacía', async () => {
  const ok = { requestedSeason: { year: 2027, type: 2 }, events: games('h', '1', 12) };
  await withFetch({
    'soccer/conmebol.libertadores/teams': { sports: [{ leagues: [{ teams: [{ team: { id: '1' } }, { team: { id: '2' } }] }] }] },
    'soccer/conmebol.libertadores/teams/1/schedule': 429,
    'soccer/conmebol.libertadores/teams/2/schedule': 429,
  }, async () => {
    await assert.rejects(getSeasonResults('libertadores'), { status: 502 });
  });
  await withFetch({ 'basketball/wnba/teams/1/schedule': ok, 'basketball/wnba/teams/2/schedule': 503 }, async () => {
    await assert.rejects(getSeasonResults('wnba', { teamIds: ['1', '2'] }), { status: 502 });
  });
  await withFetch({ 'football/nfl/teams': { sports: [{ leagues: [{ teams: [] }] }] } }, async () => {
    await assert.rejects(getSeasonResults('nfl'), { status: 502 });
  });
});

test('getSeasonResults: a lo sumo 6 calendarios en vuelo', async () => {
  const real = globalThis.fetch;
  let active = 0, peak = 0, calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const id = /teams\/(\d+)\/schedule/.exec(url)[1];
    return new Response(JSON.stringify({ requestedSeason: { year: 2026, type: 2 }, events: games(`c${id}-`, id, 12) }));
  };
  try {
    const ids = Array.from({ length: 40 }, (_, i) => String(i + 1));
    assert.equal((await getSeasonResults('nfl', { teamIds: ids })).length, 40 * 12);
    assert.equal(calls, 40); // 12 partidos por equipo: sin la temporada anterior
    assert.equal(peak, 6);
  } finally {
    globalThis.fetch = real;
  }
});

// ---------- getPastSeason (backtest) con fetch simulado ----------
test('getPastSeason: temporada anterior completa, con rivales que ya no están en la liga y sin ids inválidos', async () => {
  const d = (n) => new Date(Date.UTC(2025, 8, n)).toISOString();
  const [g12, g91, g89] = [ev('g12', d(3), '1', '2', 2, 1), ev('g91', d(1), '9', '1', 0, 0), ev('g89', d(2), '8', '9', 1, 3)];
  const bad = ev('gx', d(4), '1', '../x', 1, 0);
  const past = (...events) => ({ requestedSeason: { year: 2025, type: 1 }, events });
  await withFetch({
    'soccer/eng.1/teams': { sports: [{ leagues: [{ teams: [{ team: { id: '1' } }, { team: { id: '2' } }, { team: { id: '3' } }] }] }] },
    'soccer/eng.1/teams/1/schedule': { events: [] }, // sin requestedSeason (eliminado): se prueba el siguiente
    'soccer/eng.1/teams/2/schedule': { requestedSeason: { year: 2026, type: 1 }, events: [] },
    'soccer/eng.1/teams/1/schedule?season=2025': past(g12, g91, bad),
    'soccer/eng.1/teams/2/schedule?season=2025': past(g12),
    'soccer/eng.1/teams/3/schedule?season=2025': { events: [] }, // ascendido: no jugó esa temporada
    'soccer/eng.1/teams/9/schedule?season=2025': past(g91, g89), // descendido: aparece como rival de 1
    'soccer/eng.1/teams/8/schedule?season=2025': past(g89), // solo jugó contra descendidos
  }, async (urls) => {
    const { season, results } = await getPastSeason('epl');
    assert.equal(season, 2025);
    assert.deepEqual(results.map((r) => r.id), ['g91', 'g89', 'g12', 'gx']);
    assert.ok(!urls.some((u) => u.includes('../x')));
    assert.equal(urls.filter((u) => u.includes('/9/schedule?season=2025')).length, 1);
  });
});

test('getPastSeason: argumentos inválidos son 400 y un calendario caído es un error', async () => {
  await assert.rejects(getPastSeason('xx'), { status: 400 });
  await assert.rejects(getPastSeason('laliga', 0), { status: 400 });
  const teams = { sports: [{ leagues: [{ teams: [{ team: { id: '1' } }] }] }] };
  await withFetch({ 'soccer/esp.1/teams': teams, 'soccer/esp.1/teams/1/schedule': { events: [] } }, async () => {
    await assert.rejects(getPastSeason('laliga'), { status: 502 });
  });
  await withFetch({ 'soccer/col.1/teams': teams, 'soccer/col.1/teams/1/schedule': { requestedSeason: { year: 2026 }, events: [] },
    'soccer/col.1/teams/1/schedule?season=2024': 500 }, async () => {
    await assert.rejects(getPastSeason('colombia', 2), { status: 502 });
  });
});

test('bajas: absentValue solo cuenta jugadores de rotación que jugaron hace poco con su equipo', async () => {
  const { absentValue, gameScore, ABSENCE } = await import('../lib/absences.mjs');
  const cfg = ABSENCE.nba;
  const g = (date, minutes, pts = 20) => ({ date, minutes, stats: { pts, reb: 5, ast: 5 } });
  const played = Array.from({ length: 12 }, (_, i) => g(`2026-01-${String(20 - i).padStart(2, '0')}`, 32));
  const team = Array.from({ length: 30 }, (_, i) => `2026-01-${String(21 - Math.floor(i / 2)).padStart(2, '0')}`);
  assert.equal(absentValue(played, team, cfg), gameScore(played[0].stats));
  assert.equal(absentValue(played.map((x) => ({ ...x, minutes: 12 })), team, cfg), 0); // no es de rotación
  assert.equal(absentValue(played.slice(0, 3), team, cfg), 0); // menos de 5 partidos
  const later = Array.from({ length: 25 }, (_, i) => `2026-02-${String(25 - i).padStart(2, '0')}`);
  assert.equal(absentValue(played, later, cfg), 0); // fuera hace más de 20 partidos del equipo: ya está en los ratings
});
