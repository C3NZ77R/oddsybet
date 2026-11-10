// Mercados por deporte desde el modelo de expected(): cada selección con su p, cuota justa y cuota Oddsy.
import { price, scoreGrid, normalOver, halfLine, countOver, publishable } from './pricing.mjs';
import { readFileSync } from 'node:fs';
import { SPORT_MODEL, ratingsFromResults, expected } from './ratings.mjs';
import { getEvent, getGames, getLines, getSeasonResults, httpError } from './espn.mjs';
import { anchor } from './book.mjs';
import { leagueById } from '../public/leagues.js';
import { getToday, getHistory, getEloHistory, getRankings, eloStep, matchProb, serveFromMatchProb, matchDist, setLengthFrom, firstSetGames, setDone } from './tennis.mjs';
import { getChallengerToday, getChallengerHistory, NEW_DROP, calibrate } from './challenger.mjs';
import { getStatsHistory, statRates, expectedStat, cardsMarkets } from './corners.mjs';
import { ABSENCE, absenceDeltas } from './absences.mjs';
import { fewOf, applyModel } from './learn.mjs';

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

function normal({ mu, sigma, total, sigmaT }) {
  const [over, under] = [normalOver(mu, sigma, 0), normalOver(-mu, sigma, 0)];
  const ml = over / (over + under); // sin push: el empate se excluye y se renormaliza
  const l = halfLine(-mu);
  // Sin empate también en el hándicap: el margen 0 (entre −0.5 y 0.5) se excluye igual que en el ganador, así que con
  // la línea en ±0.5 los dos mercados dan la misma p. Con l > 0 ese tramo caía del lado de quien recibe puntos.
  const tie = 1 - over - under, below = normalOver(mu, sigma, -l);
  const cover = (l < 0 ? below : below - tie) / (1 - tie);
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

// Mercados anclados a la línea, y en cada selección qué decía el modelo solo (pModel) y la línea de apertura (pOpen),
// cuando el mismo mercado existe en los dos: el porqué de Mejores apuestas.
function compared(sport, base, line, open) {
  const index = (ms) => new Map(ms.flatMap((m) => m.selections.map((s) => [`${m.key}|${m.label}|${s.name}`, s.p])));
  const [plain, opened] = [index(marketsFor(sport, base)), open ? index(marketsFor(sport, anchor(sport, base, open))) : new Map()];
  return marketsFor(sport, anchor(sport, base, line)).map((m) => ({ ...m, selections: m.selections.map((s) => {
    const k = `${m.key}|${m.label}|${s.name}`;
    return { ...s, ...(plain.has(k) && { pModel: plain.get(k) }), ...(opened.has(k) && { pOpen: opened.get(k) }) };
  }) }));
}

export function marketsFor(sport, model) {
  const kind = sport === 'tennis' ? 'tennis' : SPORT_MODEL[sport];
  if (!kind) throw new TypeError(`Deporte sin modelo: ${sport}`);
  if (model?.kind !== kind) throw new TypeError(`Modelo ${model?.kind} no sirve para ${sport}`);
  if (kind === 'tennis') return tennis(model.dist);
  if (kind === 'normal') return normal(model);
  return soccer(model);
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
  if (lg?.sport === 'tennis') return tennisMarkets(lg.id, game, date);
  if (!lg || !SPORT_MODEL[lg.sport]) throw httpError(400, 'Liga sin modelo de cuotas');
  const current = ratingsFor(lg); // en paralelo con los partidos (memo compartido: casi siempre ya está)
  const games = game ? [await getEvent(lg.id, game)] : await getGames(lg.id, date);
  // Tarjetas solo en Liga BetPlay (hay snapshot de estadísticas). Los córners no se publican: el backtest 2026 los deja en la media de liga.
  const cards = lg.id === 'colombia' ? await getStatsHistory(lg.id).catch(() => null) : null;
  const rates = new Map(); // corte -> tasas de tarjetas: una vez por corte, no por partido
  const ratesAt = (cut) => rates.get(cut) ?? rates.set(cut, statRates(cards, 'cards', { asOf: cut })).get(cut);
  // Bajas del reporte de lesiones en los partidos por venir (NBA); si ESPN falla, sin ajuste. La línea de la casa
  // (lib/book.mjs), igual: si falla, el modelo solo.
  const [deltas, lines] = await Promise.all([ABSENCE[lg.id] ? absenceDeltas(lg.id, games).catch(() => ({})) : {}, getLines(lg.id, { date, game }).catch(() => new Map())]);
  const data = await Promise.all(games.filter((g) => g.home?.id && g.away?.id).map(async (g) => {
    const cut = cutOf(g);
    const ratings = await (cut === Infinity ? current : ratingsFor(lg, cut));
    const model = expected(lg.sport, ratings, g.home.id, g.away.id, { neutral: g.neutral, league: lg.id });
    // Un terminado va sin la línea: su "close" del summary a veces ya es la cuota en vivo (4 de 1 609 en .cache/espn/).
    const line = g.status?.state === 'post' ? null : lines.get(g.id)?.close ?? null;
    const base = deltas[g.id] ? { ...model, mu: model.mu + deltas[g.id] } : model;
    const markets = publishable(line ? compared(lg.sport, base, line, lines.get(g.id).open) : marketsFor(lg.sport, base));
    if (cards?.length) markets.push(...cardsMarkets(expectedStat(ratesAt(cut), g.home.id, g.away.id)));
    // Señales del aprendizaje (lib/learn.mjs): pocos partidos en la temporada y tamaño del ajuste por bajas.
    const gpNow = Math.min(...[g.home.id, g.away.id].map((id) => ratings.teams.get(id)?.gpNow ?? 0));
    // mkt: cotizado con la línea de la casa (lo aprendido no se aplica: corrige al modelo solo, ver picksOf).
    return { gameId: g.id, x: { few: fewOf(lg.sport, gpNow), abs: Math.round(Math.min(1, Math.abs(deltas[g.id] ?? 0) / 5) * 1e4) / 1e4, ...(line && { mkt: 1 }) }, markets };
  }));
  return { source: 'oddsy', accuracy: accuracyOf(lg.id), data: game ? data[0] ?? null : data };
}

// ---------- servicio: tenis (ATP de ESPN, Challenger de LiveScore en lib/challenger.mjs) ----------
// Elo de cada circuito con su historia (ATP: desde 2018 con getEloHistory; Challenger: el año de LiveScore, con el
// circuito ATP de LiveScore en la misma escala): se recalcula solo cuando cambia el historial. En la misma pasada,
// pre = P(gana a) de cada partido con el Elo de antes de jugarlo: un terminado se cotiza sin su resultado. history: los
// partidos con los que se ajusta el largo del set y se encuentra un terminado por id.
const TENNIS = {
  atp: { today: getToday, history: getHistory, long: getEloHistory },
  challenger: { today: getChallengerToday, history: getChallengerHistory, long: getChallengerHistory, newDrop: NEW_DROP },
};
const elos = new Map(); // liga -> { key, history, ratings, pre, preN }
async function tennisElo(league) {
  const t = TENNIS[league];
  const [history, long] = await Promise.all([t.history(), t.long()]);
  const key = `${long.length}:${long.at(-1)?.id}`;
  if (elos.get(league)?.key !== key) {
    // preN: partidos en la historia del que tiene menos, antes de este (con los de hoy, el relleno sabría el futuro).
    const ratings = Object.assign(new Map(), { newDrop: t.newDrop }), pre = new Map(), preN = new Map();
    const nOf = (id) => ratings.get(id)?.n ?? 0;
    for (const m of long) pre.set(m.id, matchProb(ratings, m.a.id, m.b.id, m.surface)), preN.set(m.id, Math.min(nOf(m.a.id), nOf(m.b.id))), eloStep(ratings, m);
    elos.set(league, { key, history, ratings, pre, preN });
  }
  return elos.get(league);
}
export const atpElo = () => tennisElo('atp');

// Largo del set (setLengthFrom, ~1.4 s) una vez por día y solo al cotizar: el ranking y la ficha del jugador no lo usan.
const setLens = new Map(); // liga -> { day, fit }
function setLength(league, history) {
  const day = new Date().toISOString().slice(0, 10);
  if (setLens.get(league)?.day !== day) setLens.set(league, { day, fit: setLengthFrom(history) });
  return setLens.get(league).fit;
}

// El ranking (ESPN, top 150 ATP) solo decora la lista (#rank): si ESPN falla, los partidos salen sin él. Challenger: sin.
const ranksOf = (league) => (league !== 'atp' ? Promise.resolve(new Map()) : getRankings().then((rs) => new Map(rs.map((r) => [r.player.id, r.rank])), () => new Map()));
const isoDay = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined); // YYYYMMDD → YYYY-MM-DD
const setTxt = (s) => `${s[0]}-${s[1]}${s.length > 2 ? `(${Math.min(s[2], s[3])})` : ''}`;

// Match → forma de Game para reusar la lista de partidos: home = a, away = b, logo = bandera, record = rank, score = sets.
export function tennisGame(m, ranks = new Map(), league = 'atp') {
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
    league,
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

export async function getTennisGames(league, date) {
  const [day, ranks] = await Promise.all([TENNIS[league].today(isoDay(date)), ranksOf(league)]);
  return day.map((m) => tennisGame(m, ranks, league));
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
async function tennisMarkets(league, game, date) {
  const [day, { history, ratings, pre, preN }, ranks] = await Promise.all([TENNIS[league].today(isoDay(date)), tennisElo(league), ranksOf(league)]);
  const found = game && (day.find((m) => m.id === game) ?? history.find((m) => m.id === game));
  if (game && !found) throw httpError(404, 'Partido no encontrado');
  const data = (game ? [found] : day).map((m) => {
    // slope: la del backtest de la liga (solo el Challenger la tiene; sin ella, la p del Elo).
    const p = Math.round(calibrate(pre.get(m.id) ?? matchProb(ratings, m.a.id, m.b.id, m.surface), accuracyOf(league)?.slope) * 1e4) / 1e4;
    const dist = { ...tennisDist(p, m.bestOf, m.slam), set1: firstSetGames(setLength(league, history), m, p) };
    const markets = publishable(marketsFor('tennis', { kind: 'tennis', dist }));
    const n = preN.get(m.id) ?? Math.min(ratings.get(m.a.id)?.n ?? 0, ratings.get(m.b.id)?.n ?? 0);
    return { gameId: m.id, game: tennisGame(m, ranks, league), x: { few: fewOf('tennis', n), abs: 0 }, markets: named(markets, m.a, m.b) };
  });
  return { source: 'oddsy', accuracy: accuracyOf(league), data: game ? data[0] : data };
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
// publishable quita las de doble oportunidad sobre MAX_P y corre las posiciones: ahí la posición sale del nombre.
const DC = ['Local o empate', 'Local o visitante', 'Empate o visitante'];
// Pick del partido: la apuesta de mayor probabilidad de cada partido, la que cuenta en el registro (lib/picklog.mjs). Todo
// partido con alguna apuesta visible (p ≥ 0.5, el corte de la vista) tiene la suya: antes pedía 0.70 y los partidos parejos
// quedaban sin pick y fuera del "acierto de ayer".
export const FEATURED_MIN = 0.5;

// raw = p del modelo; p = la que se muestra, con lo aprendido (lib/learn.mjs; sin modelo, la misma). El corte de min es
// sobre raw: el registro guarda también los que el ajuste dejó bajo el 50 % y la vista no los muestra.
export function picksOf(sport, markets, { min = 0.5, model = null, league = null, x = {} } = {}) {
  const bins = ACCURACY._bins?.[sport] ?? {};
  const main = new Map(); // la más pareja de cada total con varias líneas; en empate, la primera
  for (const m of markets) if (MAIN_LINE.has(m.key) && !(main.has(m.key) && evenness(main.get(m.key)) <= evenness(m))) main.set(m.key, m);
  return markets.filter((m) => PICKABLE.has(m.key) && (!MAIN_LINE.has(m.key) || main.get(m.key) === m))
    .map((m) => [m, m.selections.reduce((a, b) => (b.p > a.p ? b : a))])
    .filter(([, s]) => s.p >= min)
    .map(([m, s]) => {
      const p = applyModel(x.mkt ? null : model, { sport, league, market: m.key, p: s.p, x });
      return { market: m.key, label: m.label, name: s.name, line: s.line ?? null, side: m.key === 'dc' ? DC.indexOf(s.name) : m.selections.indexOf(s),
        raw: s.p, p, fair: p === s.p ? s.fair : price(p).fair, minOdds: minOdds(p), record: recordOf(bins[m.key], s.p),
        ...(s.pModel != null && { pModel: s.pModel }), ...(s.pOpen != null && { pOpen: s.pOpen }) };
    })
    .sort((a, b) => b.p - a.p);
}

// model: el que aprendió el registro (currentModel en server.mjs); sin él, la p del modelo base (tests, relleno).
export async function getPicks(league, { date = null, model = null } = {}) {
  const r = await getMarkets(league, { date });
  const { sport } = leagueById(league);
  return { ...r, data: r.data.map((g) => {
    const picks = picksOf(sport, g.markets, { model, league, x: g.x });
    if (picks[0]?.p >= FEATURED_MIN) picks[0] = { ...picks[0], featured: true };
    return { gameId: g.gameId, x: g.x, picks };
  }) };
}
