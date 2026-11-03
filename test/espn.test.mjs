// Normalizadores de ESPN con respuestas reales recortadas (test/fixtures/). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as e from '../lib/espn.mjs';
import { LEAGUES, leagueById } from '../public/leagues.js';
import { STATS, statOf, statForMarket } from '../public/stats.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('ligas: ids únicos y búsqueda', () => {
  assert.equal(new Set(LEAGUES.map((l) => l.id)).size, LEAGUES.length);
  assert.equal(leagueById('laliga').espn, 'esp.1');
  assert.equal(leagueById('nope'), null);
  for (const l of LEAGUES) assert.ok(STATS[l.sport], `STATS para ${l.sport}`);
});

test('scoreboard NBA → Game sin cuotas de casas y con la sede', () => {
  const [g] = e.normScoreboard(fx('scoreboard-nba.json'), 'nba');
  assert.equal(g.id, '401909088');
  assert.equal(g.league, 'nba');
  assert.equal(g.start, '2026-10-20T19:00:00.000Z');
  assert.equal(g.status.state, 'pre');
  assert.deepEqual([g.home.abbr, g.away.abbr], ['DET', 'BOS']);
  assert.equal(g.home.record, '0-0');
  assert.equal(g.home.score, null);
  assert.equal(g.home.color, '#1d428a');
  assert.match(g.home.logo, /^https:\/\/a\.espncdn\.com\//);
  assert.equal('odds' in g, false); // el fixture trae DraftKings: Oddsy no muestra precios ajenos (Ruling 11)
  assert.equal(g.neutral, false);
  const json = fx('scoreboard-nba.json');
  json.events[0].competitions[0].neutralSite = true;
  assert.equal(e.normScoreboard(json, 'nba')[0].neutral, true);
});

test('scoreboard de fútbol: marcador en vivo y sin cuotas de casas', () => {
  const [live, pre] = e.normScoreboard(fx('scoreboard-laliga.json'), 'laliga');
  assert.equal(live.status.state, 'in');
  assert.equal(live.home.score, 2);
  assert.equal(pre.home.score, null);
  assert.ok(!('odds' in live) && !('odds' in pre));
});

test('summary NBA + core API → GameDetail', () => {
  const d = e.normSummary(fx('summary-nba.json'), 'nba', { records: { home: fx('core-record-nba.json') }, stats: { home: fx('core-stats-nba.json') } });
  assert.equal(d.id, '401909903');
  assert.deepEqual([d.home.abbr, d.away.abbr], ['ORL', 'BOS']);
  assert.equal('odds' in d, false); // ni pickcenter ni odds del summary
  assert.deepEqual(d.records.home.map((r) => `${r.key}:${r.summary}`), ['overall:2-3', 'home:0-2', 'road:2-1', 'vsdiv:0-1', 'vsconf:2-2', 'lasttengames:2-3']);
  assert.equal(d.records.away[0].key, 'overall'); // respaldo: récords del header del summary
  const pts = d.teamStats.home.find((s) => s.key === 'avgPoints');
  assert.deepEqual(pts, { key: 'avgPoints', label: 'Puntos por partido', value: 114.85366, display: '114.9', rank: 3 });
  assert.ok(d.teamStats.away.length > 0, 'respaldo con las estadísticas del boxscore');
  assert.equal(d.teamStatsSeason, 2026);
  assert.equal(d.injuries.length, 4);
  assert.deepEqual(Object.keys(d.injuries[0]).sort(), ['athlete', 'comment', 'date', 'detail', 'returnDate', 'status', 'teamAbbr', 'teamId']);
  assert.equal(d.injuries[0].athlete.id, '4065654');
  assert.equal(d.injuries[0].status, 'Out');
  const l5 = d.lastFive.home;
  assert.ok(l5.length === 3 && l5[0].date > l5[2].date, 'del más reciente al más antiguo');
  assert.deepEqual({ opp: l5[0].opp.abbr, home: l5[0].home, score: l5[0].score, result: l5[0].result }, { opp: 'NY', home: false, score: '111-102', result: 'W' });
  assert.deepEqual(d.predictor, { homeWinPct: 0.36, awayWinPct: 0.64 });
  assert.equal(d.ats, null);
  assert.equal(d.starters, null);
  assert.equal(d.publicBetting, null);
});

test('summary NBA terminado: titulares y marcador', () => {
  const d = e.normSummary(fx('summary-nba-post.json'), 'nba');
  assert.equal(d.status.state, 'post');
  assert.deepEqual([d.home.score, d.away.score], [94, 125]);
  assert.deepEqual([d.starters.home.length, d.starters.away.length], [5, 5]);
  assert.equal(d.starters.home[0].teamAbbr, 'DET');
  assert.ok(d.starters.home.every((a) => /^\d+$/.test(a.id) && a.name));
});

test('summary de fútbol: alineaciones y plantilla desde rosters', () => {
  const d = e.normSummary(fx('summary-laliga.json'), 'laliga');
  assert.deepEqual([d.starters.home.length, d.starters.away.length], [11, 11]);
  assert.equal(d.rosters.home.length, 13);
  assert.equal(d.starters.home[0].pos, 'G');
  assert.deepEqual(d.injuries, []);
});

test('estadísticas de equipo: ranking del total y valores por partido', () => {
  const s = e.normTeamStats(fx('core-stats-nba.json'), 'basketball');
  const pts = s.find((x) => x.key === 'avgPoints');
  assert.equal(pts.rank, 3); // avgPoints no trae ranking: se usa el de points
  const paint = s.find((x) => x.key === 'pointsInPaint');
  assert.equal(paint.display, '44.2'); // total / partidos jugados
});

test('game log NBA: claves cortas, derivadas y contexto del partido', () => {
  const games = e.normGamelog(fx('gamelog-nba.json'), 'basketball');
  const g = games[0];
  assert.equal(g.eventId, '401869410');
  assert.equal(g.season, 2026);
  assert.deepEqual(g.opp, { id: '20', abbr: 'PHI' });
  assert.equal(g.home, false);
  assert.deepEqual([g.result, g.margin, g.teamScore, g.oppScore, g.minutes], ['L', -13, 93, 106, 29]);
  assert.deepEqual([g.stats.fgm, g.stats.fga, g.stats['3pm'], g.stats.pts, g.stats.reb, g.stats.ast], [6, 13, 2, 17, 11, 3]);
  assert.equal(g.stats.pra, 31);
  assert.equal(g.stats.dd, 1);
  assert.ok(games.every((x, i) => i === 0 || games[i - 1].date >= x.date));
});

test('game log de fútbol', () => {
  const soc = e.normGamelog(fx('gamelog-soccer.json'), 'soccer')[0];
  assert.deepEqual([soc.stats.shots, soc.stats.sot, soc.result, soc.minutes], [3, 2, 'W', null]);
});

test('game log: se descarta la pretemporada', () => {
  const json = fx('gamelog-wnba-pre.json');
  const pre = json.seasonTypes.find((s) => /Preseason/.test(s.displayName)).categories[0].events[0].eventId;
  const games = e.normGamelog(json, 'basketball');
  assert.ok(games.length > 0);
  assert.ok(!games.some((g) => g.eventId === pre));
});

test('buildGameLog: une temporadas sin duplicar y solo lista estadísticas calculables', () => {
  const games = e.normGamelog(fx('gamelog-nba.json'), 'basketball');
  const log = e.buildGameLog({ id: '4065648' }, 'basketball', [games, games.slice(0, 2)]);
  assert.equal(log.games.length, games.length);
  assert.ok(log.statKeys.includes('pra') && log.statKeys.includes('3pm'));
  assert.equal(log.labels.pra, 'PTS+REB+AST');
  const so = e.buildGameLog({ id: '1' }, 'soccer', [e.normGamelog(fx('gamelog-soccer.json'), 'soccer')]);
  assert.deepEqual(so.statKeys, ['goals', 'assists', 'shots', 'sot', 'fc', 'fs', 'yc']);
});

test('plantillas, lesiones, búsqueda y perfil', () => {
  const nba = e.normRoster(fx('roster-nba.json'));
  assert.equal(nba.length, 3);
  assert.deepEqual(Object.keys(nba[0]).sort(), ['headshot', 'id', 'jersey', 'name', 'pos', 'short', 'teamAbbr', 'teamId']);
  const inj = e.normInjuries(fx('injuries-nba.json').injuries);
  assert.equal(inj[0].athlete.id, '5105571'); // la liga no trae id: se saca del enlace del jugador
  assert.equal(inj[0].teamAbbr, 'ATL');
  assert.equal(inj[0].detail, 'Knee · Right');
  const found = e.normSearch(fx('search-nba.json'), 'nba');
  assert.deepEqual(found.map((a) => [a.id, a.teamAbbr]), [['1966', 'PHI'], ['4683774', 'LAL']]);
  assert.deepEqual(e.normAthleteProfile(fx('athlete-nba.json')), { id: '1966', name: 'LeBron James', short: 'L. James', pos: 'F', jersey: '23', headshot: 'https://a.espncdn.com/i/headshots/nba/players/full/1966.png', teamId: '20', teamAbbr: 'PHI' });
});

test('stats.js: derivadas, mercados y alternativos', () => {
  assert.equal(statOf('basketball', 'pra', { pts: 20, reb: 5, ast: 7 }), 32);
  assert.equal(statOf('basketball', 'pra', { reb: 5 }), null);
  assert.equal(statOf('basketball', 'dd', { pts: 12, reb: 10, ast: 3, stl: 0, blk: 0 }), 1);
  assert.equal(statOf('basketball', 'td', { pts: 12, reb: 10, ast: 9 }), 0);
  assert.equal(statOf('soccer', 'goals', null), null);
  assert.equal(statForMarket('basketball', 'player_points_alternate').key, 'pts');
  assert.equal(statForMarket('soccer', 'player_goal_scorer_anytime').key, 'goals');
  assert.equal(statForMarket('basketball', 'player_first_basket'), null);
});

test('getEvent: el Game del summary, sin pedir plantillas, récords ni estadísticas', async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(JSON.stringify(url.endsWith('=1') ? fx('summary-nba.json') : {})));
  try {
    const { id, league, start, status, home, away, neutral } = e.normSummary(fx('summary-nba.json'), 'nba');
    assert.deepEqual(await e.getEvent('nba', '1'), { id, league, start, status, home, away, neutral });
    assert.deepEqual(urls, ['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=1']);
    await assert.rejects(e.getEvent('nba', '2'), { status: 404 });
  } finally { globalThis.fetch = real; }
});

test('normLive: periodo, reloj en segundos y nombre del estado para el seguimiento', () => {
  const live = fx('summary-nba-post.json');
  Object.assign(live.header.competitions[0].status, { period: 4, clock: 123.4, displayClock: '2:03' });
  const g = e.normLive(live, 'nba');
  assert.deepEqual([g.period, g.clock], [4, 123.4]);
  assert.equal(g.status.name, live.header.competitions[0].status.type.name);
  // Sin el número clock (el summary en vivo solo trae displayClock): sale del texto, igual que para progress.
  delete live.header.competitions[0].status.clock;
  assert.equal(e.normLive(live, 'nba').clock, 123);
  // Partido que no ha empezado: sin periodo ni reloj.
  const pre = e.normLive(fx('summary-nba.json'), 'nba');
  assert.deepEqual([pre.period, pre.clock, pre.status.name], [null, null, 'STATUS_SCHEDULED']);
});

test('getLiveGame: summary fresco (15 s) aunque el partido esté terminado; 404 sin partido', async () => {
  const real = globalThis.fetch, now = Date.now;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(JSON.stringify(url.endsWith('=live-1') ? fx('summary-nba-post.json') : {})));
  let t = 2e12;
  Date.now = () => t;
  try {
    assert.equal((await e.getLiveGame('nba', 'live-1')).status.state, 'post'); // con liveTtl este summary se guardaría 5 min
    await e.getLiveGame('nba', 'live-1');
    assert.equal(urls.length, 1); // dentro de los 15 s sale de la caché
    t += 16_000;
    await e.getLiveGame('nba', 'live-1');
    assert.equal(urls.length, 2);
    await assert.rejects(e.getLiveGame('nba', 'live-2'), { status: 404 });
    await assert.rejects(e.getLiveGame('xx', 'live-1'), { status: 400 });
  } finally { globalThis.fetch = real; Date.now = now; }
});

test('getLiveGame: no sirve el summary que getEvent dejó 5 min en caché para un partido sin empezar', async () => {
  const real = globalThis.fetch, now = Date.now;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(JSON.stringify(fx('summary-nba.json'))));
  let t = 3e12;
  Date.now = () => t;
  try {
    assert.equal((await e.getEvent('nba', 'live-pre-3')).status.state, 'pre'); // summaryOf lo guarda con TTL.board
    t += 10_000;
    await e.getLiveGame('nba', 'live-pre-3');
    assert.equal(urls.length, 1); // todavía no pasan 15 s: sale de la caché
    t += 6_000;
    await e.getLiveGame('nba', 'live-pre-3');
    assert.equal(urls.length, 2); // 16 s: el seguimiento pidió 15 s y la entrada de 5 min no le sirve
  } finally { globalThis.fetch = real; Date.now = now; }
});
