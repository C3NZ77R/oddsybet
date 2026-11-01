// En vivo: proyección por ritmo, fuerza de la señal, contexto del partido y pausas (public/live.js). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/live.js';
import { SIGMA_T } from '../lib/ratings.mjs';
import { marketsFor } from '../lib/markets.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('progress: fracción jugada por deporte', () => {
  near(L.progress('basketball', 'nba', { period: 3, clock: 360 }), 0.625); // Q3 con 6:00 por jugar
  near(L.progress('basketball', 'nba', { period: 2, clock: 0 }), 0.5);
  near(L.progress('basketball', 'wnba', { period: 4, clock: 300 }), 0.875); // cuartos de 10 min
  near(L.progress('soccer', 'epl', { clock: 2700 }), 0.5);
  assert.equal(L.progress('basketball', 'nba', { period: 5, clock: 100 }), 1); // prórroga: ya no queda tiempo reglamentario
});

test('clockSecs: reloj de ESPN en texto', () => {
  assert.equal(L.clockSecs('15:00'), 900);
  assert.equal(L.clockSecs('0:07'), 7);
  assert.equal(L.clockSecs('45.2'), 45.2); // último minuto en la NBA
  assert.equal(L.clockSecs("67'"), 4020);
  assert.equal(L.clockSecs("45'+2'"), 2700);
  assert.equal(L.clockSecs(''), null);
  assert.equal(L.clockSecs(undefined), null);
});

test('remaining: mezcla el promedio previo con el ritmo de hoy', () => {
  // Va justo a su promedio: proyecta su promedio.
  const even = L.remaining({ current: 30, progress: 0.5, mean: 60, variance: 600 });
  near(even.mean, 30);
  near(even.projected, 60);
  near(even.variance, 300); // dispersión 600/60 = 10 × lo que falta
  // Va al doble: el ritmo empuja, pero el promedio previo (5 partidos, scripts/live-props-backtest.mjs) frena: no proyecta 120.
  const hot = L.remaining({ current: 60, progress: 0.5, mean: 60, variance: 600 });
  near(hot.projected, 60 + 0.5 * ((5 * 60 + 60) / 5.5));
  assert.equal(L.remaining({ current: 50, progress: 1, mean: 60, variance: 600 }).mean, 0);
  // Marcador: el previo pesa 8 partidos (scripts/live-backtest.mjs), así que un arranque lento baja poco la proyección.
  near(L.remaining({ current: 10, progress: 0.1, mean: 224.5, variance: 369, prior: 8 }).mean, 0.9 * (8 * 224.5 + 10) / 8.1);
  const s = L.totalSignal({ id: 'g', progress: 0.8, home: { score: 70 }, away: { score: 70 } }, 224.5, 'basketball');
  const w = 0.753 + 0.247 * 0.2; // curva de la NBA: al 80 % del reloj va el 80.24 % de los puntos esperados
  near(s.projected, 140 + (1 - w) * (8 * 224.5 + 140) / (8 + w));
  near(s.expected, w * 224.5);
  assert.equal(s.progress, 0.8); // el texto muestra el reloj real
});

test('scoringShare: curva de anotación de la NBA por cuarto; lineal donde no hay curva', () => {
  // Solo el 4.º cuarto se aparta de lo lineal.
  for (const [f, w] of [[0, 0], [0.125, 0.125], [0.3, 0.3], [0.5, 0.5], [0.75, 0.753], [0.875, 0.8765], [1, 1]]) near(L.scoringShare('basketball', f), w, 1e-12);
  assert.equal(L.scoringShare('soccer', 0.6), 0.6);
});

test('liveOver: ya superada, sin tiempo y caso normal', () => {
  const rem = L.remaining({ current: 30, progress: 0.5, mean: 60, variance: 600 });
  assert.equal(L.liveOver('normal', 70, rem, 68.5), 1);
  assert.equal(L.liveOver('normal', 50, { mean: 0, variance: 0 }, 68.5), 0);
  const p = L.liveOver('normal', 30, rem, 68.5);
  assert.ok(p > 0.01 && p < 0.5, `p=${p}`); // le faltan 38.5 y se esperan 30
  const c = L.liveOver('count', 2, L.remaining({ current: 2, progress: 0.5, mean: 5, variance: 6 }), 4.5);
  assert.ok(c > 0.2 && c < 0.6, `c=${c}`);
});

test('paceZ y strength: niveles y empuje del contexto', () => {
  near(L.paceZ({ current: 6, progress: 0.5, mean: 5, variance: 6 }), 3.5 / Math.sqrt(3));
  assert.ok(L.paceZ({ current: 0, progress: 0.5, mean: 5, variance: 6 }) < 0);
  assert.equal(L.strength(0.9), 0);
  assert.equal(L.strength(0.9, 1), 0); // sin ritmo raro no hay señal aunque el contexto ayude
  assert.equal(L.strength(1.2), 1);
  assert.equal(L.strength(-1.6), 2);
  assert.equal(L.strength(2.4), 3);
  assert.equal(L.strength(1.2, 1), 2);
  assert.equal(L.strength(2.4, 1), 3);
  assert.equal(L.strength(1.2, -1), 1);
  assert.deepEqual(L.LEVELS.slice(1), ['temprana', 'moderada', 'fuerte']);
});

test('scriptFor: faltas y paliza en básquet → Under; sin contexto en fútbol', () => {
  assert.equal(L.scriptFor('basketball', 'pts', 'Under', { margin: 2, progress: 0.4, fouls: 4 }).s, 1);
  assert.equal(L.scriptFor('basketball', 'pts', 'Over', { margin: 22, progress: 0.7 }).s, -1);
  assert.equal(L.scriptFor('basketball', 'pts', 'Over', { margin: 22, progress: 0.4 }), null); // primera mitad: la paliza aún no pesa
  assert.equal(L.scriptFor('basketball', 'pts', 'Over', { margin: 5, progress: 0.7, fouls: 2 }), null);
  assert.equal(L.scriptFor('soccer', 'goals', 'Over', { margin: 3, progress: 0.8 }), null);
});

const liveGame = (over = {}) => ({
  id: '1', progress: 0.5, home: { id: '10', abbr: 'ORL', score: 50 }, away: { id: '20', abbr: 'BOS', score: 60 },
  players: [{ id: 'p1', teamId: '10', stats: { pts: 30, reb: 4, ast: 3, pf: 0 } }, { id: 'p2', teamId: '20', stats: { pts: 2, reb: 1, ast: 0, pf: 4 } }],
  ...over,
});
const prop = (athleteId, stat, line, mean, variance, side = 'Over') => ({ id: `${athleteId}|${stat}|${side}`, athleteId, player: athleteId, stat, line, side, kind: 'normal', mean, variance });

test('propSignals: ritmo raro + contexto; ignora Under duplicado, doble-doble y jugadores sin boxscore', () => {
  const props = [
    prop('p1', 'pts', 19.5, 20, 30), prop('p1', 'pts', 19.5, 20, 30, 'Under'), // 30 a la mitad: muy por encima
    prop('p1', 'dd', 0.5, 0.4, 0.24), prop('p2', 'pts', 15.5, 16, 30), prop('p9', 'reb', 6.5, 7, 10),
  ];
  const sigs = L.propSignals(props, liveGame(), 'basketball');
  assert.deepEqual(sigs.map((s) => [s.athleteId, s.stat]), [['p1', 'pts'], ['p2', 'pts']]);
  const [hot, cold] = sigs;
  assert.equal(hot.side, 'Over');
  assert.equal(hot.level, 3); // z ≈ 5, sin contexto
  assert.deepEqual(hot.aligned, [1, 1]);
  assert.equal(hot.team, 'ORL');
  assert.ok(hot.projected > 30 && hot.pOver > 0.9);
  assert.equal(cold.side, 'Under');
  assert.equal(cold.level, 3); // z ≈ −1.6 → moderada; con 4 faltas → fuerte (2 de 2 razones)
  assert.deepEqual(cold.aligned, [2, 2]);
  assert.equal(cold.team, 'BOS');
  assert.deepEqual(L.propSignals(props, liveGame({ progress: 0.05 }), 'basketball'), []); // muy temprano
  // Combinada del mismo jugador: queda solo la más fuerte.
  const dup = L.propSignals([...props, prop('p1', 'pra', 34.5, 35, 60)], liveGame(), 'basketball');
  assert.deepEqual(dup.filter((x) => x.athleteId === 'p1').map((x) => x.stat), ['pts']);
});

test('propSignals: el contexto sube una señal temprana (z ≈ −1) a moderada', () => {
  const sigs = L.propSignals([prop('p2', 'pts', 11.5, 12, 30)], liveGame(), 'basketball');
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].side, 'Under');
  assert.equal(sigs[0].level, 2); // z ≈ −1.07 → temprana; 4 faltas → moderada
});

test('playerShare: curva de los jugadores de la NBA por cuarto, lineal donde no hay curva; propSignals la usa', () => {
  for (const [f, w] of [[0, 0], [0.125, 0.134], [0.25, 0.268], [0.5, 0.519], [0.75, 0.779], [1, 1]]) near(L.playerShare('basketball', f), w, 1e-12);
  assert.equal(L.playerShare('soccer', 0.6), 0.6);
  const live = { progress: 0.5, home: { id: 'h', abbr: 'H', score: 50 }, away: { id: 'v', abbr: 'V', score: 50 }, players: [{ id: 'a', teamId: 'h', stats: { pts: 25, pf: 0 } }] };
  const [s] = L.propSignals([prop('a', 'pts', 29.5, 30, 50)], live, 'basketball');
  near(s.expected, 0.519 * 30); // a la mitad del reloj se espera el 51.9 % de su media, no el 50 %
  near(s.rem.mean, L.remaining({ current: 25, progress: 0.519, mean: 30, variance: 50 }).mean);
  assert.equal(s.progress, 0.5);
});

test('totalSignal: marcador contra la línea previa de Oddsy', () => {
  assert.equal(L.totalSignal(liveGame(), 224.5, 'basketball'), null); // 110 a la mitad vs 112.25 esperados: normal
  const s = L.totalSignal(liveGame({ home: { id: '10', score: 70 }, away: { id: '20', score: 70 } }), 224.5, 'basketball');
  assert.equal(s.side, 'Over');
  assert.equal(s.level, 3); // 140 a la mitad: z ≈ 2.0
  assert.equal(L.totalSignal(liveGame(), null, 'basketball'), null);
  assert.equal(L.totalSignal(liveGame(), 224.5, 'tennis'), null);
  assert.equal(L.TOTAL.basketball.sd, SIGMA_T.basketball);
  assert.equal(L.TOTAL.wnba.sd, SIGMA_T.wnba);
});

test('totalSignal: la WNBA usa su propio desvío del total; la NBA, el del básquet', () => {
  const g = (league) => ({ id: 'w', league, progress: 0.5, home: { score: 50 }, away: { score: 50 } });
  const z = (sd) => (100 - L.scoringShare('basketball', 0.5) * 160.5) / Math.sqrt(sd ** 2 * L.scoringShare('basketball', 0.5));
  near(L.totalSignal(g('wnba'), 160.5, 'basketball').z, z(16.4));
  near(L.totalSignal(g('nba'), 160.5, 'basketball').z, z(L.TOTAL.basketball.sd));
});

test('mainTotal: la línea del total más parejo; el fútbol trae seis y la NBA una', () => {
  assert.equal(L.mainTotal(marketsFor('soccer', { kind: 'poisson', lh: 1.45, la: 1.1 })), 2.5);
  const ms = marketsFor('basketball', { kind: 'normal', mu: 3, sigma: 12, total: 224.6, sigmaT: SIGMA_T.basketball });
  assert.equal(L.mainTotal(ms), ms.find((m) => m.key === 'ou').selections[0].line);
  assert.equal(L.mainTotal(undefined), null);
  assert.equal(L.mainTotal([]), null);
});

test('parseOdds: decimal con punto o coma, americana con −, - o +', () => {
  near(L.parseOdds('-110'), 1 + 100 / 110);
  near(L.parseOdds('−110'), 1 + 100 / 110); // U+2212 del teclado de iOS/Mac
  assert.equal(L.parseOdds('+150'), 2.5);
  assert.equal(L.parseOdds(' 1,91 '), 1.91);
  assert.equal(L.parseOdds('110'), 2.1);
  for (const v of ['', null, 'abc', '1', '0.9']) assert.equal(L.parseOdds(v), null);
});

test('stopOf y windowLeft: tipos de pausa de ESPN y cuenta regresiva estimada', () => {
  assert.equal(L.stopOf('Official Timeout').kind, 'tv');
  assert.equal(L.stopOf('Timeout').kind, 'timeout');
  assert.equal(L.stopOf('Full Timeout').kind, 'timeout');
  assert.equal(L.stopOf("Coach's Challenge (Stands)").kind, 'review');
  assert.equal(L.stopOf('End Period').kind, 'period');
  assert.equal(L.stopOf('HALFTIME').kind, 'half');
  assert.equal(L.stopOf('End of Half').kind, 'half');
  assert.equal(L.stopOf('IN PROGRESS'), null);
  assert.equal(L.stopOf('Pass Reception'), null);
  const at = '2026-10-19T01:00:00Z', t = Date.parse(at);
  assert.equal(L.windowLeft({ kind: 'timeout', at }, t + 30_000), 60);
  assert.equal(L.windowLeft({ kind: 'timeout', at }, t + 300_000), 0);
  assert.equal(L.windowLeft({ kind: 'timeout', at: null }, t), null);
  // ESPN publica ~6 min tarde: la pausa comercial ya terminó, el medio tiempo sigue.
  assert.equal(L.isActive({ kind: 'tv', at }, t + 340_000), false);
  assert.equal(L.isActive({ kind: 'half', at }, t + 340_000), true);
  assert.equal(L.isActive({ kind: 'half', at: null }), true);
  assert.equal(L.isActive({ kind: 'timeout', at: null }), false);
});

test('normLive: avance, pausa por la última jugada, prob. de ganar y boxscore', async () => {
  const { normLive } = await import('../lib/espn.mjs');
  const comp = {
    id: '401909903', date: '2026-11-01T20:30Z',
    // El summary en vivo no trae el número clock, solo displayClock.
    status: { displayClock: '6:00', period: 2, type: { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: '6:00 - 2nd' } },
    competitors: [
      { id: '19', homeAway: 'home', score: '50', team: { id: '19', abbreviation: 'ORL', displayName: 'Orlando Magic' } },
      { id: '2', homeAway: 'away', score: '58', team: { id: '2', abbreviation: 'BOS', displayName: 'Boston Celtics' } },
    ],
  };
  const json = {
    header: { id: '401909903', competitions: [comp] },
    plays: [{ type: { text: 'Jump Shot' } }, { type: { text: 'Full Timeout' }, text: 'Celtics Full timeout', wallclock: '2026-11-01T21:10:00Z' }],
    winprobability: [{ homeWinPercentage: 0.5 }, { homeWinPercentage: 0.41 }],
    boxscore: { players: [{ team: { id: '2' }, statistics: [{
      keys: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'rebounds', 'assists', 'fouls', 'points'],
      athletes: [{ athlete: { id: '1', displayName: 'Jayson Tatum' }, stats: ['18', '6-13', '2-5', '7', '4', '2', '17'] }],
    }] }] },
  };
  const g = normLive(json, 'nba');
  assert.equal(g.status.state, 'in');
  assert.deepEqual([g.home.score, g.away.score], [50, 58]);
  near(g.progress, (720 + 360) / 2880);
  assert.deepEqual(g.stop, { kind: 'timeout', label: 'Tiempo muerto', at: '2026-11-01T21:10:00.000Z' });
  assert.equal(g.winProb, 0.41);
  assert.equal(g.lastPlay, 'Celtics Full timeout');
  assert.equal(g.lastPlayAt, '2026-11-01T21:10:00.000Z');
  const [p] = g.players;
  const st = p.stats;
  assert.deepEqual([p.teamId, st.min, st.fgm, st.fga, st['3pm'], st['3pa'], st.reb, st.ast, st.pf, st.pts], ['2', 18, 6, 13, 2, 5, 7, 4, 2, 17]);
  assert.equal(st.pra, 28);
  // Medio tiempo por el estado del partido aunque la última jugada no lo diga.
  const half = normLive({ ...json, header: { competitions: [{ ...comp, status: { ...comp.status, type: { name: 'STATUS_HALFTIME', state: 'in' } } }] } }, 'nba');
  assert.equal(half.stop.kind, 'half');
});
