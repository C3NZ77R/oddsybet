// Mercados por deporte desde el modelo de expected(): cada selección con su p, cuota justa y cuota Oddsy.
import { price, scoreGrid, normalOver, halfLine, countOver, publishable } from './pricing.mjs';
import { readFileSync } from 'node:fs';
import { SPORT_MODEL, ratingsFromResults, expected } from './ratings.mjs';
import { getEvent, getGames, getSeasonResults, httpError } from './espn.mjs';
import { leagueById } from '../public/leagues.js';
import { getToday, getHistory, getRankings, eloStep, matchProb, serveFromMatchProb, matchDist, setLengthFrom, firstSetGames, setDone } from './tennis.mjs';
import { getStatsHistory, statRates, expectedStat, cardsMarkets } from './corners.mjs';
import { ABSENCE, absenceDeltas } from './absences.mjs';

const sel = (name, p, line) => ({ name, ...(line !== undefined && { line }), ...price(p) });
const market = (key, label, selections) => ({ key, label, selections });
const sumGrid = (g, f) => g.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i, j) ? t + v : t), 0), 0);
const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
// Línea asiática → p equivalente (cuota justa 1/p). part(x) = [P(gana), P(devuelve)] en la línea x; las de cuarto se parten en dos.
const asian = (part, l) => {
  const ps = ((l * 4) % 2 ? [l - 0.25, l + 0.25] : [l]).map(part);
  const w = ps.reduce((s, [p]) => s + p, 0) / ps.length, q = ps.reduce((s, [, p]) => s + p, 0) / ps.length;
  return q < 1 ? w / (1 - q) : 0.5;
};

function soccer({ lh, la }) {
  const g = scoreGrid(lh, la);
  const [H, D, A] = [sumGrid(g, (i, j) => i > j), sumGrid(g, (i, j) => i === j), sumGrid(g, (i, j) => i < j)];
  const dnb = H + A > 0 ? H / (H + A) : 0.5; // sin goles no hay ganador: reparto parejo
  const btts = sumGrid(g, (i, j) => i > 0 && j > 0);
  const cells = g.flatMap((row, i) => row.map((p, j) => ({ name: `${i}-${j}`, p }))).sort((a, b) => b.p - a.p).slice(0, 10);
  return [
    market('1x2', 'Resultado (1X2)', [sel('Local', H), sel('Empate', D), sel('Visitante', A)]),
    market('dc', 'Doble oportunidad', [sel('Local o empate', H + D), sel('Local o visitante', H + A), sel('Empate o visitante', D + A)]),
    market('dnb', 'Empate no válido', [sel('Local', dnb), sel('Visitante', 1 - dnb)]),
    ...[0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((l) => {
      const over = sumGrid(g, (i, j) => i + j > l);
      return market('ou', `Total de goles ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    }),
    ...[['home', 'Local', (i) => i], ['away', 'Visitante', (i, j) => j]].flatMap(([k, n, f]) => [0.5, 1.5, 2.5, 3.5].map((l) => {
      const over = sumGrid(g, (i, j) => f(i, j) > l);
      return market(`ou_${k}`, `Goles ${n.toLowerCase()} ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    })),
    market('btts', 'Ambos marcan', [sel('Sí', btts), sel('No', 1 - btts)]),
    // Líneas de Betano.co. Entera: si empata con la línea devuelve. De cuarto: media apuesta en cada línea vecina.
    ...[-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1].map((l) => {
      const home = asian((x) => [sumGrid(g, (i, j) => i - j + x > 0), sumGrid(g, (i, j) => i - j + x === 0)], l);
      return market('ah', `Hándicap asiático local ${fmt(l)}`, [sel('Local', home, l), sel('Visitante', 1 - home, -l)]);
    }),
    ...[-0.5, -0.25, 0.25, 0.5].map((d) => halfLine(lh + la) + d).filter((l) => l > 0).map((l) => {
      const over = asian((x) => [sumGrid(g, (i, j) => i + j > x), sumGrid(g, (i, j) => i + j === x)], l);
      return market('aou', `Total asiático de goles ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    }),
    market('cs', 'Marcador exacto', [...cells.map((c) => sel(c.name, c.p)), sel('Otro', Math.max(0, 1 - cells.reduce((s, c) => s + c.p, 0)))]),
  ];
}

// Béisbol: sin empate. El empate en tiempo regular se reparte según lh/(lh+la).
function noDraw({ lh, la }) {
  const g = scoreGrid(lh, la, { rho: 0, max: 20 });
  const share = lh + la > 0 ? lh / (lh + la) : 0.5;
  const home = sumGrid(g, (i, j) => i > j) + sumGrid(g, (i, j) => i === j) * share;
  const homeFav = lh >= la;
  const fav = sumGrid(g, (i, j) => (homeFav ? i - j : j - i) >= 2);
  const [pHome, pAway] = homeFav ? [fav, 1 - fav] : [1 - fav, fav];
  const line = halfLine(lh + la);
  const over = sumGrid(g, (i, j) => i + j > line);
  return [
    market('ml', 'Ganador', [sel('Local', home), sel('Visitante', 1 - home)]),
    market('rl', 'Hándicap de carreras', [sel('Local', pHome, homeFav ? -1.5 : 1.5), sel('Visitante', pAway, homeFav ? 1.5 : -1.5)]),
    market('ou', `Total de carreras ${line}`, [sel('Más', over, line), sel('Menos', 1 - over, line)]),
  ];
}

function normal({ mu, sigma, total, sigmaT }) {
  const [over, under] = [normalOver(mu, sigma, 0), normalOver(-mu, sigma, 0)];
  const ml = over / (over + under); // sin push: el empate se excluye y se renormaliza
  const l = halfLine(-mu);
  const cover = normalOver(mu, sigma, -l);
  const t = halfLine(total);
  const ou = normalOver(total, sigmaT, t);
  return [
    market('ml', 'Ganador', [sel('Local', ml), sel('Visitante', 1 - ml)]),
    market('spread', `Hándicap local ${fmt(l)}`, [sel('Local', cover, l), sel('Visitante', 1 - cover, -l)]),
    market('ou', `Total de puntos ${t}`, [sel('Más', ou, t), sel('Menos', 1 - ou, t)]),
  ];
}

// Tenis: todo sale de matchDist (lib/tennis.mjs); A es el primer jugador del partido y B el segundo. set1 (opcional):
// P[k] de k games en el primer set, de firstSetGames.
function tennis({ pA, firstSet, sets, games, margin, set1 }) {
  const won = (f) => Object.entries(sets).reduce((s, [k, p]) => (f(...k.split('-').map(Number)) ? s + p : s), 0);
  const fiveSets = '3-0' in sets;
  const g = halfLine(games.reduce((s, p, k) => s + p * k, 0));
  const overG = countOver(games, g);
  const ds = Object.entries(margin).map(([d, p]) => [Number(d), p]); // d = games de A − games de B
  const l = halfLine(-ds.reduce((s, [d, p]) => s + d * p, 0));
  const cover = ds.reduce((s, [d, p]) => (d + l > 0 ? s + p : s), 0);
  return [
    market('ml', 'Ganador', [sel('A', pA), sel('B', 1 - pA)]),
    market('sets', 'Resultado exacto en sets', Object.entries(sets).map(([k, p]) => sel(k, p))),
    ...(fiveSets ? [3.5, 4.5] : [2.5]).map((t) => {
      const over = won((a, b) => a + b > t);
      return market('ou_sets', `Total de sets ${t}`, [sel('Más', over, t), sel('Menos', 1 - over, t)]);
    }),
    market('ou_games', `Total de games ${g}`, [sel('Más', overG, g), sel('Menos', 1 - overG, g)]),
    market('games_hcp', `Hándicap de games A ${fmt(l)}`, [sel('A', cover, l), sel('B', 1 - cover, -l)]),
    ...[['A', (a) => a > 0], ['B', (a, b) => b > 0]].map(([n, f]) => {
      const p = won(f);
      return market('win_set', `${n} gana al menos un set`, [sel('Sí', p), sel('No', 1 - p)]);
    }),
    market('first_set', 'Ganador del primer set', [sel('A', firstSet), sel('B', 1 - firstSet)]),
    ...(set1 ? [8.5, 9.5, 10.5, 12.5] : []).map((t) => {
      const over = countOver(set1, t);
      return market('ou_set1', `Total de games del 1er set ${t}`, [sel('Más', over, t), sel('Menos', 1 - over, t)]);
    }),
  ];
}

export function marketsFor(sport, model) {
  const kind = sport === 'tennis' ? 'tennis' : SPORT_MODEL[sport];
  if (!kind) throw new TypeError(`Deporte sin modelo: ${sport}`);
  if (model?.kind !== kind) throw new TypeError(`Modelo ${model?.kind} no sirve para ${sport}`);
  if (kind === 'tennis') return tennis(model.dist);
  if (kind === 'normal') return normal(model);
  return sport === 'soccer' ? soccer(model) : noDraw(model);
}

// ---------- servicio: mercados de partidos reales de ESPN ----------
const ACCURACY = JSON.parse(readFileSync(new URL('../docs/accuracy.json', import.meta.url), 'utf8'));
export const accuracyOf = (league) => ACCURACY[league] ?? null;
export const getAccuracy = () => ACCURACY;

const RATINGS_TTL = 30 * 60_000;
const RATINGS_FAIL_TTL = 60_000; // ESPN en 403: sin recordar el error, cada pedido volvía a disparar ~60 calendarios
const RATINGS_MAX = 100;
const DAY = 86_400_000;
const ratingsMemo = new Map(); // liga|corte -> { at, ttl, promise }
// cut (ms): ratings con lo jugado antes; Infinity = todo lo terminado.
function ratingsFor(lg, cut = Infinity) {
  const key = `${lg.id}|${cut}`;
  const hit = ratingsMemo.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const promise = getSeasonResults(lg.id).then((rs) => ratingsFromResults(rs, { sport: lg.sport, asOf: cut }));
  const entry = { at: Date.now(), ttl: RATINGS_TTL, promise };
  ratingsMemo.set(key, entry);
  if (ratingsMemo.size > RATINGS_MAX) ratingsMemo.delete(ratingsMemo.keys().next().value);
  promise.catch(() => Object.assign(entry, { at: Date.now(), ttl: RATINGS_FAIL_TTL }));
  return promise;
}

// Terminado: corte de scripts/backtest.mjs (cutOf, día UTC de 6 h antes), sin su resultado y un ajuste por liga y día.
const cutOf = (g) => (g.status?.state === 'post' && g.start ? Math.floor((Date.parse(g.start) - 6 * 3_600_000) / DAY) * DAY : Infinity);

// Con game: mercados de ese partido. Sin game: de todos los partidos de date (YYYYMMDD; por defecto hoy).
export async function getMarkets(league, { game = null, date = null } = {}) {
  const lg = leagueById(league);
  if (lg?.sport === 'tennis') return tennisMarkets(game, date);
  if (!lg || !SPORT_MODEL[lg.sport]) throw httpError(400, 'Liga sin modelo de cuotas');
  const current = ratingsFor(lg); // en paralelo con los partidos (memo compartido: casi siempre ya está)
  const games = game ? [await getEvent(lg.id, game)] : await getGames(lg.id, date);
  // Tarjetas solo en Liga BetPlay (hay snapshot de estadísticas). Los córners no se publican: el backtest 2026 los deja en la media de liga.
  const cards = lg.id === 'colombia' ? await getStatsHistory(lg.id).catch(() => null) : null;
  const rates = new Map(); // corte -> tasas de tarjetas: una vez por corte, no por partido
  const ratesAt = (cut) => rates.get(cut) ?? rates.set(cut, statRates(cards, 'cards', { asOf: cut })).get(cut);
  // Bajas del reporte de lesiones en los partidos por venir (NBA); si ESPN falla, sin ajuste.
  const deltas = ABSENCE[lg.id] ? await absenceDeltas(lg.id, games).catch(() => ({})) : {};
  const data = await Promise.all(games.filter((g) => g.home?.id && g.away?.id).map(async (g) => {
    const cut = cutOf(g);
    const ratings = await (cut === Infinity ? current : ratingsFor(lg, cut));
    const model = expected(lg.sport, ratings, g.home.id, g.away.id, { neutral: g.neutral, league: lg.id });
    const markets = publishable(marketsFor(lg.sport, deltas[g.id] ? { ...model, mu: model.mu + deltas[g.id] } : model));
    if (cards) markets.push(...cardsMarkets(expectedStat(ratesAt(cut), g.home.id, g.away.id)));
    return { gameId: g.id, markets };
  }));
  return { source: 'oddsy', accuracy: accuracyOf(lg.id), data: game ? data[0] ?? null : data };
}

// ---------- servicio: tenis ATP ----------
// Elo de los últimos 24 meses: se recalcula solo cuando cambia el historial (getHistory ya cachea los meses). En la misma
// pasada, pre = P(gana a) de cada partido con el Elo de antes de jugarlo: un terminado se cotiza sin su resultado.
let elo = { key: null };
export async function atpElo() {
  const history = await getHistory();
  const key = `${history.length}:${history.at(-1)?.id}`;
  if (elo.key !== key) {
    const ratings = new Map(), pre = new Map();
    for (const m of history) pre.set(m.id, matchProb(ratings, m.a.id, m.b.id, m.surface)), eloStep(ratings, m);
    elo = { key, history, ratings, pre };
  }
  return elo;
}

// Largo del set (setLengthFrom, ~1.4 s) una vez por día y solo al cotizar: el ranking y la ficha del jugador no lo usan.
let setLen = { day: null };
function setLength(history) {
  const day = new Date().toISOString().slice(0, 10);
  if (setLen.day !== day) setLen = { day, fit: setLengthFrom(history) };
  return setLen.fit;
}

// El ranking solo decora la lista (#rank): si ESPN falla, los partidos salen sin él.
const atpRanks = () => getRankings().then((rs) => new Map(rs.map((r) => [r.player.id, r.rank])), () => new Map());
const isoDay = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined); // YYYYMMDD → YYYY-MM-DD
const setTxt = (s) => `${s[0]}-${s[1]}${s.length > 2 ? `(${Math.min(s[2], s[3])})` : ''}`;

// Match → forma de Game para reusar la lista de partidos: home = a, away = b, logo = bandera, record = rank, score = sets.
export function tennisGame(m, ranks = new Map()) {
  const side = (p, i) => ({
    id: p.id,
    abbr: p.short,
    name: p.name,
    logo: p.flag ?? null,
    record: ranks.has(p.id) ? `#${ranks.get(p.id)}` : null,
    score: m.state === 'pre' ? null : m.sets.filter((s) => setDone(s) && s[i] > s[1 - i]).length,
    color: null,
  });
  const score = m.sets.map(setTxt).join(' ');
  return {
    id: m.id,
    league: 'atp',
    start: m.date,
    status: { state: m.state ?? 'pre', detail: score ? `${score}${m.retired ? ' (ret.)' : ''}` : null },
    home: side(m.a, 0),
    away: side(m.b, 1),
    tournament: m.tournament,
    round: m.round,
    surface: m.surface,
    bestOf: m.bestOf,
  };
}

export async function getTennisGames(date) {
  const [day, ranks] = await Promise.all([getToday(isoDay(date)), atpRanks()]);
  return day.map((m) => tennisGame(m, ranks));
}

// serveFromMatchProb cuesta ~40–200 ms por partido (bisección de 20 pasos): memo por p y formato.
const dists = new Map();
function tennisDist(p, bestOf, slam) {
  const key = `${p}|${bestOf}|${slam}`;
  if (!dists.has(key)) {
    if (dists.size > 2000) dists.clear();
    const { sa, sb } = serveFromMatchProb(p, bestOf, { slam });
    dists.set(key, matchDist(sa, sb, bestOf, { slam }));
  }
  return dists.get(key);
}

// marketsFor('tennis') nombra a los jugadores A y B: se cambian por sus nombres cortos.
function named(markets, a, b) {
  const n = { A: a.short ?? a.name ?? 'A', B: b.short ?? b.name ?? 'B' };
  const sub = (s) => s.replace(/\b[AB]\b/g, (k) => n[k]);
  return markets.map((m) => ({
    ...m,
    label: m.key === 'sets' ? `${m.label} (${n.A} primero)` : sub(m.label),
    selections: m.selections.map((s) => ({ ...s, name: sub(s.name) })),
  }));
}

// Con game: ese partido (del día pedido o, si no está, del historial). Sin game: todos los del día (YYYYMMDD; hoy en Bogotá).
async function tennisMarkets(game, date) {
  const [day, { history, ratings, pre }, ranks] = await Promise.all([getToday(isoDay(date)), atpElo(), atpRanks()]);
  const found = game && (day.find((m) => m.id === game) ?? history.find((m) => m.id === game));
  if (game && !found) throw httpError(404, 'Partido no encontrado');
  const data = (game ? [found] : day).map((m) => {
    const p = Math.round((pre.get(m.id) ?? matchProb(ratings, m.a.id, m.b.id, m.surface)) * 1e4) / 1e4;
    const dist = { ...tennisDist(p, m.bestOf, m.slam), set1: firstSetGames(setLength(history), m, p) };
    const markets = publishable(marketsFor('tennis', { kind: 'tennis', dist }));
    return { gameId: m.id, game: tennisGame(m, ranks), markets: named(markets, m.a, m.b) };
  });
  return { source: 'oddsy', accuracy: accuracyOf('atp'), data: game ? data[0] : data };
}

// ---------- mejores apuestas ----------
// Por partido, una selección por mercado (la más probable) con p ≥ min: la escalera del resultado (directa, sin empate,
// doble oportunidad), hándicap, la línea principal de cada total con varias líneas (la más pareja) y ambos marcan. Los
// totales extremos (Menos de 5.5 goles al 97%) no se apuestan y quedan fuera. Cada una con la cuota mínima a la que vale
// la pena (justa más 5% de colchón por el error del modelo) y cuánto se cumplió ese mercado en ese tramo de p en el
// backtest.
const PICKABLE = new Set(['1x2', 'dnb', 'dc', 'ml', 'spread', 'rl', 'games_hcp', 'first_set', 'btts', 'ou', 'ou_sets', 'ou_games', 'ou_set1']);
const MAIN_LINE = new Set(['ou', 'ou_sets', 'ou_set1']); // totales con varias líneas: solo se apuesta la más pareja
export const minOdds = (p) => Math.ceil(Math.round(10500 / p) / 100) / 100;
const recordOf = (bins, p) => bins?.find((b) => b.from === Math.min(90, Math.floor(p * 10) * 10) && b.n >= 20) ?? null;
const evenness = (m) => Math.abs(m.selections[0].p - 0.5);

export function picksOf(sport, markets, { min = 0.5 } = {}) {
  const bins = ACCURACY._bins?.[sport] ?? {};
  const main = new Map(); // la más pareja de cada total con varias líneas; en empate, la primera
  for (const m of markets) if (MAIN_LINE.has(m.key) && !(main.has(m.key) && evenness(main.get(m.key)) <= evenness(m))) main.set(m.key, m);
  return markets.filter((m) => PICKABLE.has(m.key) && (!MAIN_LINE.has(m.key) || main.get(m.key) === m))
    .map((m) => [m, m.selections.reduce((a, b) => (b.p > a.p ? b : a))])
    .filter(([, s]) => s.p >= min)
    .map(([m, s]) => ({ market: m.key, label: m.label, name: s.name, line: s.line, p: s.p, fair: s.fair, minOdds: minOdds(s.p), record: recordOf(bins[m.key], s.p) }))
    .sort((a, b) => b.p - a.p);
}

export async function getPicks(league, { date = null } = {}) {
  const r = await getMarkets(league, { date });
  const { sport } = leagueById(league);
  return { ...r, data: r.data.map((g) => ({ gameId: g.gameId, picks: picksOf(sport, g.markets) })) };
}
