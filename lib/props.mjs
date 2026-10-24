// Props de jugador con línea y cuotas propias: el game log de ESPN de cada jugador da su distribución por estadística.
// Conteos: binomial negativa (Poisson si no hay sobredispersión). Volúmenes altos (puntos, yardas): normal.
import { leagueById } from '../public/leagues.js';
import { STATS, statOf } from '../public/stats.js';
import { getEvent, getGames, getGamelog, getRoster, httpError, mapLimit } from './espn.mjs';
import { price, halfLine, MAX_P } from './pricing.mjs';
import { propOver } from '../public/betmath.js';

export const MIN_GAMES = 8;
export const PER_TEAM = 8; // jugadores por equipo con más minutos (o más partidos)
const NEXT_GAMES = 3; // sin partido: los próximos de la liga (cada partido son ~2 plantillas + 30 game logs)
const IN_FLIGHT = 4; // peticiones a ESPN a la vez (Ruling 12): una ráfaga de cientos acaba en 403
export const NORMAL = new Set(['pts', 'pra', 'pr', 'pa', 'pass_yds', 'rush_yds', 'rec_yds', 'rush_rec_yds', 'pass_rush_yds']);
const POS = { football: new Set(['QB', 'RB', 'WR', 'TE']) }; // NFL: 53 por plantilla; solo los que tienen props
const MAX_FAILED = 0.1; // más plantillas o game logs caídos que esto dejaría la lista a medias en la CDN: mejor un error

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// values: del más reciente al más viejo. null con menos de MIN_GAMES partidos. kind 'binary': la media es P(Más 0.5).
export function propLine(values, kind = 'count') {
  if (values.length < MIN_GAMES) return null;
  const m = 0.5 * mean(values.slice(0, 10)) + 0.3 * mean(values) + 0.2 * mean(values.slice(0, 5));
  const line = kind === 'binary' ? 0.5 : halfLine(median(values.slice(0, 20)));
  const variance = values.reduce((s, x) => s + (x - mean(values)) ** 2, 0) / (values.length - 1);
  return { line, mean: m, variance, pOver: propOver(kind, m, variance, line) };
}

// Props de un jugador a partir de su game log normalizado (lib/espn.mjs → buildGameLog).
export function playerProps(log, sport, ctx) {
  const out = [];
  for (const d of STATS[sport] ?? []) {
    if (!d.market) continue;
    const values = log.games.map((g) => statOf(sport, d.key, g.stats)).filter((v) => v != null);
    if (!values.some((v) => v > 0)) continue;
    const kind = NORMAL.has(d.key) ? 'normal' : d.binary ? 'binary' : 'count'; // binary: 0/1 por partido, solo la línea 0.5
    const r = propLine(values, kind);
    if (!r || r.pOver < 1 - MAX_P || r.pOver > MAX_P) continue; // casi seguro (p. ej. Under 0.5 tapones): la cuota toca 1.01 y pierde el margen
    for (const [side, p] of [['Over', r.pOver], ['Under', 1 - r.pOver]]) {
      const pr = price(p);
      out.push({
        id: `${ctx.gameId}|${d.market}|${log.athlete.id}|${r.line}|${side}`, league: ctx.league, gameId: ctx.gameId, eventId: ctx.gameId,
        start: ctx.start, player: log.athlete.name ?? ctx.name, athleteId: log.athlete.id, team: ctx.team, opp: ctx.opp,
        market: d.market, stat: d.key, line: r.line, side, p, fair: pr.fair, mean: r.mean, variance: r.variance, kind, n: values.length,
        books: [{ key: 'oddsy', title: 'Oddsy', price: pr.oddsy }],
      });
    }
  }
  return out;
}

export const activity = (log) => {
  const mins = log.games.map((g) => g.minutes).filter(Number.isFinite);
  return mins.length ? mean(mins.slice(0, 10)) : log.games.length;
};

// null = ESPN falló; un 404 (jugador sin game log) queda en undefined y no cuenta como caída.
const gone = (err) => (err?.status === 404 ? undefined : null);
const failed = (xs) => xs.filter((x) => x === null).length > xs.length * MAX_FAILED;
const pre = (games) => games.filter((g) => g.status?.state === 'pre').slice(0, NEXT_GAMES);
// Día siguiente (YYYYMMDD) al último partido del tablero de hoy, o a hoy si está vacío, en Nueva York: ESPN cambia de día
// por la hora de EE. UU.
const nextDay = (games) => {
  const starts = games.map((g) => Date.parse(g.start)).filter(Number.isFinite);
  const day = new Date(starts.length ? Math.max(...starts) : Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
};
// Los próximos de hoy; de noche, cuando ya empezaron todos, los de mañana (un tablero más).
async function nextGames(league) {
  const today = await getGames(league);
  return pre(today).length ? pre(today) : pre(await getGames(league, nextDay(today)));
}

export async function getProps(league, gameId = null) {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  // shortcut: sin partido solo se cubren los próximos NEXT_GAMES de hoy (o de mañana si ya empezaron todos); para más, pedir por partido.
  const games = gameId ? [await getEvent(lg.id, gameId)] : await nextGames(lg.id);
  // Plantillas y después una lista plana de game logs, siempre con a lo sumo IN_FLIGHT pedidos a ESPN.
  const sides = games.flatMap((g) => [[g, g.home, g.away], [g, g.away, g.home]]);
  const rosters = await mapLimit(sides, IN_FLIGHT, ([, t]) => getRoster(lg.id, t.id).catch(gone));
  if (failed(rosters)) throw httpError(502, 'ESPN no devolvió las plantillas');
  const jobs = sides.flatMap((_, i) => (rosters[i] ?? []).filter((a) => !POS[lg.sport] || POS[lg.sport].has(a.pos)).map((a) => [i, a]));
  const logs = await mapLimit(jobs, IN_FLIGHT, ([, a]) => getGamelog(lg.id, a.id, null, { athlete: a }).catch(gone));
  if (failed(logs)) throw httpError(502, 'ESPN no devolvió los game logs de los jugadores');
  const bySide = sides.map(() => []);
  jobs.forEach(([i], k) => { if (logs[k]?.games.length >= MIN_GAMES) bySide[i].push(logs[k]); });
  const data = bySide.flatMap((ls, i) => {
    const [g, t, o] = sides[i];
    return ls.sort((a, b) => activity(b) - activity(a)).slice(0, PER_TEAM)
      .flatMap((l) => playerProps(l, lg.sport, { league: lg.id, gameId: g.id, start: g.start, team: t.abbr, opp: o.abbr }));
  });
  return { source: 'oddsy', data };
}
