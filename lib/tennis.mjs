// Tenis ATP (singles masculino): normalizadores puros del scoreboard y rankings de ESPN, envoltorios de fetch,
// Elo por superficie y cadena de Markov punto → game → set → partido. Lo que llega de ESPN es dato no confiable:
// solo se copian campos conocidos, como texto o número.
import { readFileSync } from 'node:fs';
import { fetchJson, TTL, uniqueById } from './espn.mjs';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp';
const DAY = 24 * 3_600_000;
const str = (v) => (v == null ? null : String(v));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// ---------- superficie ----------
// shortcut: ESPN no trae la superficie; se deduce del nombre del torneo. Cambiar si aparece una fuente.
const CLAY = /roland garros|french|monte|madrid|rome|italia|barcelona|hamburg|munich|geneva|lyon|estoril|buenos aires|rio|santiago|bastad|båstad|gstaad|kitzb|umag|houston|marrakech|bucharest/i;
const GRASS = /wimbledon|halle|queen|hertogenbosch|stuttgart|mallorca|eastbourne|newport/i;
export const SURFACE = (name = '') => (CLAY.test(name) ? 'clay' : GRASS.test(name) ? 'grass' : 'hard');

// ---------- normalizadores ----------
const player = (a = {}) => ({
  id: str(a.id),
  name: str(a.displayName),
  short: str(a.shortName ?? a.shortname),
  country: str(a.flag?.alt ?? a.flagAltText ?? a.citizenshipCountry),
  flag: str(typeof a.flag === 'string' ? a.flag : a.flag?.href),
});

const RET = /\bret\b|w\/o|walkover/i;

function normMatch(ev, c) {
  const [ca, cb] = [...(c.competitors ?? [])].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  if (!ca?.id || !cb?.id || !ca.athlete || !cb.athlete) return null; // cuadro con rival por definir
  const state = str(c.status?.type?.state);
  const slam = ev.major === true;
  const bestOf = slam && !/qualif/i.test(c.round?.displayName ?? '') ? 5 : 3;
  const la = ca.linescores ?? [];
  const lb = cb.linescores ?? [];
  const sets = [];
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const s = [num(la[i].value), num(lb[i].value)];
    if (s.some((v) => v == null)) break;
    if (la[i].tiebreak != null && lb[i].tiebreak != null) s.push(num(la[i].tiebreak), num(lb[i].tiebreak));
    sets.push(s);
  }
  const winner = state === 'post' ? (ca.winner ? 'a' : cb.winner ? 'b' : null) : null;
  const need = Math.ceil(bestOf / 2);
  const won = sets.filter(([x, y]) => (winner === 'a' ? x > y : y > x)).length;
  const retired =
    /RETIRED|WALKOVER/.test(c.status?.type?.name ?? '') ||
    (c.notes ?? []).some((n) => RET.test(n?.text ?? '')) ||
    (winner != null && won < need);
  return {
    id: str(c.id),
    date: str(c.date),
    tournament: str(ev.name),
    surface: SURFACE(ev.name),
    round: str(c.round?.displayName),
    bestOf,
    slam,
    state,
    a: player({ ...ca.athlete, id: ca.id }), // en el scoreboard el id del jugador está en el competidor
    b: player({ ...cb.athlete, id: cb.id }),
    winner,
    sets,
    retired,
  };
}

export function normScoreboard(body) {
  const out = [];
  for (const ev of body?.events ?? [])
    for (const g of ev.groupings ?? [])
      if (g.grouping?.slug === 'mens-singles')
        for (const c of g.competitions ?? []) {
          const m = normMatch(ev, c);
          if (m?.id) out.push(m);
        }
  return out;
}

export function normRankings(body) {
  return (body?.rankings?.[0]?.ranks ?? [])
    .map((r) => ({ rank: num(r.current), prev: num(r.previous), points: num(r.points), player: player(r.athlete) }))
    .filter((r) => r.rank != null && r.player.id)
    .sort((x, y) => x.rank - y.rank)
    .slice(0, 150); // ESPN publica hasta el 150
}

// ---------- fetch ----------
const ym = (d) => d.toISOString().slice(0, 7).replace('-', '');
const months = new Map(); // yyyymm -> { at, ttl, promise } con la versión normalizada (un mes crudo pesa ~4 MB)

export function getMonth(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  const ttl = yyyymm === ym(new Date()) ? TTL.board : DAY;
  const hit = months.get(yyyymm);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const promise = fetchJson(`${BASE}/scoreboard?dates=${yyyymm}01-${yyyymm}${last}`, 0).then(normScoreboard);
  months.set(yyyymm, { at: Date.now(), ttl, promise });
  promise.catch(() => months.delete(yyyymm));
  return promise;
}

// Snapshot de meses pasados (scripts/tennis-snapshot.mjs); si falta, solo se usan los dos meses en vivo.
let snapshot;
const loadSnapshot = () => {
  if (snapshot) return snapshot;
  try {
    snapshot = JSON.parse(readFileSync(new URL('../data/atp-history.json', import.meta.url), 'utf8')).matches ?? [];
  } catch {
    snapshot = [];
  }
  return snapshot;
};

export { uniqueById }; // scripts/tennis-snapshot.mjs lo importa de aquí
export const finished = (ms) => ms.filter((m) => m.state === 'post' && m.winner).sort((x, y) => Date.parse(x.date) - Date.parse(y.date));

export async function getHistory(n = 24, now = new Date()) {
  const snap = loadSnapshot();
  const prev = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n + 1, 1);
  // En vivo desde el mes del último partido del snapshot: si el snapshot envejece, los meses del medio no se pierden.
  const start = new Date(Math.max(from, Math.min(prev, Date.parse(snap.at(-1)?.date) || prev)));
  const yms = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) yms.push(ym(d));
  const live = (await Promise.all(yms.map(getMonth))).flat();
  return finished(uniqueById([...snap, ...live])).filter((m) => Date.parse(m.date) >= from);
}

// Historia larga para el Elo (scripts/tennis-elo-snapshot.mjs): filas compactas → partidos con lo que usa eloStep.
const SURF = { h: 'hard', c: 'clay', g: 'grass' };
let eloRows;
export function eloSnapshot() {
  if (eloRows) return eloRows;
  try {
    eloRows = JSON.parse(readFileSync(new URL('../data/atp-elo.json', import.meta.url), 'utf8')).rows.map(([id, date, sf, a, b, winner, sets, ret]) => ({
      id, date, surface: SURF[sf], state: 'post', winner, retired: ret === 1, a: { id: a }, b: { id: b },
      sets: sets ? sets.split(' ').map((x) => x.split('-').map(Number)) : [],
    }));
  } catch {
    eloRows = [];
  }
  return eloRows;
}

// Partidos para el Elo: la historia larga más getHistory (completo y en vivo), que gana en los ids repetidos.
export async function getEloHistory() {
  return finished(uniqueById([...eloSnapshot(), ...(await getHistory())]));
}

export async function getRankings() {
  return normRankings(await fetchJson(`${BASE}/rankings`, TTL.sched));
}

const bogota = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

// date = 'YYYY-MM-DD' en hora de Colombia. ESPN devuelve el torneo completo: se filtra al día pedido.
export async function getToday(date = bogota(Date.now())) {
  const body = await fetchJson(`${BASE}/scoreboard?dates=${date.replaceAll('-', '')}`, TTL.board);
  return normScoreboard(body).filter((m) => m.date && bogota(m.date) === date);
}

export async function getPlayer(id) {
  const [history, rankings] = await Promise.all([getHistory(), getRankings()]);
  const matches = history.filter((m) => m.a.id === id || m.b.id === id).reverse();
  const r = rankings.find((x) => x.player.id === id);
  const p = r?.player ?? (matches[0] ? (matches[0].a.id === id ? matches[0].a : matches[0].b) : null);
  return { player: p, rank: r?.rank ?? null, matches };
}

// ---------- Elo por superficie ----------
// Ajustado en 2025 y medido en 2026 con la historia desde 2018 (scripts/backtest.mjs atp): Brier de 2026 0.2273 (24 meses,
// K = 250/(n+5)^0.4, mitad superficie) → 0.2202. Lo que más suma es la historia larga; después, que un jugador que aparece
// cuando la historia ya lleva BURN días arranque NEW puntos abajo (suele venir de la qualy) y el margen en games.
const START = 1500;
const NEW = 100;
const BURN = 180 * DAY;
const SURF_W = 0.4; // peso del Elo de la superficie frente al general
const MOV = 0.25; // K × (1 + MOV·(proporción de games del ganador − 0.55)/0.15), con piso 0.3
const K = (n) => 200 / (n + 5) ** 0.45;
const pElo = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));
const fresh = (start = START) => ({ all: start, hard: start, clay: start, grass: start, n: 0, ns: { hard: 0, clay: 0, grass: 0 } });
// Arranque de un jugador nuevo: el de todos al principio de la historia; pasado BURN, NEW abajo. elo.t0 y elo.last los
// lleva eloStep (primer y último partido visto).
const startOf = (elo, t) => (elo.t0 != null && t - elo.t0 > BURN ? START - NEW : START);

// Actualiza elo (Map id → rating) con un partido terminado; los retiros no cuentan para el rating.
export function eloStep(elo, m) {
  const t = Date.parse(m.date);
  elo.t0 ??= t;
  elo.last = Math.max(elo.last ?? t, t);
  if (m.retired || !m.winner) return;
  const get = (id) => elo.get(id) ?? elo.set(id, fresh(startOf(elo, t))).get(id);
  const [w, l] = m.winner === 'a' ? [get(m.a.id), get(m.b.id)] : [get(m.b.id), get(m.a.id)];
  const won = (x) => (m.winner === 'a' ? x[0] : x[1]);
  const sets = m.sets ?? [];
  const gw = sets.reduce((s, x) => s + won(x), 0), gl = sets.reduce((s, x) => s + x[0] + x[1] - won(x), 0);
  const mult = gw + gl ? Math.max(0.3, 1 + (MOV * (gw / (gw + gl) - 0.55)) / 0.15) : 1;
  const e = pElo(w.all, l.all);
  [w.all, l.all] = [w.all + mult * K(w.n) * (1 - e), l.all - mult * K(l.n) * (1 - e)];
  const s = m.surface;
  const es = pElo(w[s], l[s]);
  [w[s], l[s]] = [w[s] + mult * K(w.ns[s]) * (1 - es), l[s] - mult * K(l.ns[s]) * (1 - es)];
  w.n++, l.n++, w.ns[s]++, l.ns[s]++;
}

export function eloFrom(matches, { asOf = Infinity } = {}) {
  const elo = new Map();
  for (const m of [...matches].sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) if (Date.parse(m.date) < asOf) eloStep(elo, m);
  return elo;
}

export const ratingOf = (elo, id) => elo.get(id) ?? fresh(startOf(elo, elo.last ?? 0));
const blend = (r, surface) => (1 - SURF_W) * r.all + SURF_W * (r[surface] ?? r.all);
export const matchProb = (elo, aId, bId, surface = 'hard') => pElo(blend(ratingOf(elo, aId), surface), blend(ratingOf(elo, bId), surface));

// ---------- Markov ----------
// P(gana el game quien saca), con deuce cerrado.
const holdP = (p) => {
  const q = 1 - p;
  return p ** 4 * (1 + 4 * q + 10 * q * q) + (20 * p ** 3 * q ** 3 * p * p) / (1 - 2 * p * q);
};

// P(A gana el tiebreak a `to` puntos) con A sacando el primer punto; luego saques de a dos (B, B, A, A, …).
function tiebreakP(sa, sb, to) {
  const aServes = (k) => Math.floor((k + 1) / 2) % 2 === 0;
  let grid = new Map([['0,0', 1]]);
  let win = 0;
  for (let k = 0; grid.size; k++) {
    const next = new Map();
    const pa = aServes(k) ? sa : 1 - sb;
    for (const [key, pr] of grid) {
      const [i, j] = key.split(',').map(Number);
      if (i === to - 1 && j === to - 1) {
        // empate: cada par de puntos tiene un saque de cada uno
        const x = sa * (1 - sb);
        win += (pr * x) / (x + (1 - sa) * sb);
        continue;
      }
      for (const [ni, nj, pp] of [[i + 1, j, pa], [i, j + 1, 1 - pa]]) {
        if (ni === to && nj <= to - 2) win += pr * pp;
        else if (nj === to && ni <= to - 2) continue;
        else next.set(`${ni},${nj}`, (next.get(`${ni},${nj}`) ?? 0) + pr * pp);
      }
    }
    grid = next;
  }
  return win;
}

// Marcadores finales de un set: [[ga, gb, p, aSacaElSiguiente]]. `aFirst`: A saca el primer game.
function setDist(sa, sb, aFirst, tbTo) {
  const ha = holdP(sa);
  const hb = holdP(sb);
  const tbA = aFirst ? tiebreakP(sa, sb, tbTo) : 1 - tiebreakP(sb, sa, tbTo);
  const out = [];
  let grid = new Map([['0,0', 1]]);
  while (grid.size) {
    const next = new Map();
    for (const [key, pr] of grid) {
      const [i, j] = key.split(',').map(Number);
      const n = i + j;
      if (i === 6 && j === 6) {
        // el tiebreak cuenta como game 13: el siguiente set lo empieza el otro
        out.push([7, 6, pr * tbA, !aFirst], [6, 7, pr * (1 - tbA), !aFirst]);
        continue;
      }
      const aServing = aFirst === (n % 2 === 0);
      const pa = aServing ? ha : 1 - hb;
      for (const [ni, nj, pp] of [[i + 1, j, pa], [i, j + 1, 1 - pa]]) {
        const done = (Math.max(ni, nj) === 6 && Math.abs(ni - nj) >= 2) || Math.max(ni, nj) === 7;
        if (done) out.push([ni, nj, pr * pp, aFirst === ((ni + nj) % 2 === 0)]);
        else next.set(`${ni},${nj}`, (next.get(`${ni},${nj}`) ?? 0) + pr * pp);
      }
    }
    grid = next;
  }
  return out;
}

// Total de games de un set (tiebreak a 7): P[k], k = 0..13, promediando quién saca primero.
export function setGames(sa, sb) {
  const out = Array(14).fill(0);
  for (const aFirst of [true, false]) for (const [x, y, p] of setDist(sa, sb, aFirst, 7)) out[x + y] += p / 2;
  return out;
}

// sa, sb: P(ganar el punto con el propio saque). Promedia sobre quién saca primero.
// slam: el set decisivo se define con tiebreak a 10 en 6-6 (regla de Grand Slam desde 2022).
export function matchDist(sa, sb, bestOf = 3, { slam = bestOf === 5 } = {}) {
  const need = Math.ceil(bestOf / 2);
  const cache = new Map();
  const sets = (aFirst, decisive) => {
    const k = `${aFirst}${decisive}`;
    if (!cache.has(k)) cache.set(k, setDist(sa, sb, aFirst, decisive && slam ? 10 : 7));
    return cache.get(k);
  };
  const res = { pA: 0, firstSet: 0, sets: {}, games: [], margin: {} };
  for (let a = need; a >= 0; a--) for (let b = 0; b <= need; b++) if ((a === need) !== (b === need) && a + b >= need) res.sets[`${a}-${b}`] = 0;
  for (const aFirst of [true, false]) {
    res.firstSet += 0.5 * sets(aFirst, false).reduce((s, [x, y, p]) => (x > y ? s + p : s), 0);
    // estado: "setsA,setsB,aSaca,games,margen" → probabilidad
    let states = new Map([[`0,0,${aFirst},0,0`, 0.5]]);
    while (states.size) {
      const next = new Map();
      for (const [key, pr] of states) {
        const [a, b, f, g, mg] = key.split(',');
        const [na, nb] = [Number(a), Number(b)];
        for (const [x, y, p, nf] of sets(f === 'true', na === need - 1 && nb === need - 1)) {
          const sA = na + (x > y), sB = nb + (y > x), G = Number(g) + x + y, D = Number(mg) + x - y, q = pr * p;
          if (sA === need || sB === need) {
            if (sA === need) res.pA += q;
            res.sets[`${sA}-${sB}`] += q;
            res.games[G] = (res.games[G] ?? 0) + q;
            res.margin[D] = (res.margin[D] ?? 0) + q;
          } else {
            const k = `${sA},${sB},${nf},${G},${D}`;
            next.set(k, (next.get(k) ?? 0) + q);
          }
        }
      }
      states = next;
    }
  }
  res.games = Array.from(res.games, (p) => p ?? 0);
  return res;
}

// Solo P(gana A), igual a matchDist(...).pA sin contar games: cada set se resume en (gana A, A saca el siguiente).
export function winProb(sa, sb, bestOf = 3, { slam = bestOf === 5 } = {}) {
  const need = Math.ceil(bestOf / 2);
  const memo = new Map();
  const sets = (aFirst, decisive) => {
    const k = `${aFirst}${decisive}`;
    if (!memo.has(k)) {
      const o = new Map();
      for (const [x, y, p, nf] of setDist(sa, sb, aFirst, decisive && slam ? 10 : 7)) o.set(`${x > y},${nf}`, (o.get(`${x > y},${nf}`) ?? 0) + p);
      memo.set(k, [...o].map(([key, p]) => [...key.split(',').map((v) => v === 'true'), p]));
    }
    return memo.get(k);
  };
  const go = (a, b, aFirst) => (a === need ? 1 : b === need ? 0
    : sets(aFirst, a === need - 1 && b === need - 1).reduce((s, [w, nf, p]) => s + p * go(a + w, b + !w, nf), 0));
  return 0.5 * (go(0, 0, true) + go(0, 0, false));
}

// Saques sa = c + d, sb = c − d que reproducen la probabilidad de partido p (bisección; pA crece con d).
// c: P(punto con saque) media del partido (0.64 por defecto; el total de games la mueve por superficie y jugadores).
export function serveFromMatchProb(p, bestOf = 3, opts, c = 0.64) {
  let lo = -0.3, hi = 0.3;
  for (let i = 0; i < 20; i++) { // 0.6 / 2^20 ≈ 6e-7 en d: sobra para 4 decimales de pA
    const d = (lo + hi) / 2;
    if (winProb(c + d, c - d, bestOf, opts) < p) lo = d;
    else hi = d;
  }
  const d = (lo + hi) / 2;
  return { sa: c + d, sb: c - d };
}

// ---------- largo del set: total de games ----------
// Un set con saques c ± d (la cadena de arriba): el centro c = P(punto con saque) media fija el largo (más alto, más
// tiebreaks) y la brecha d sale de la p de Elo. c = base de la superficie + α_superficie + T_torneo + D_a + D_b, con α,
// T (velocidad del torneo) y D (estilo: sacador > 0, restador < 0) de una regresión ridge con decaimiento sobre todos los
// sets terminados del historial (β absorbe que los sets 2 en adelante son más cortos), ajustada por IRLS: cada set se
// linealiza en su centro con la pendiente dE[games]/dc y pesa pendiente²/varianza. Ajuste y predicción usan la misma
// distribución: la del set promediada sobre c ~ N(c, sigma²) y d ~ N(d, sigmaD²), lo que un partido varía alrededor de
// lo esperado (sin la mezcla en el ajuste, la convexidad de los games en c subía la media predicha). Penalizaciones,
// vida media, kd y desvíos elegidos en mar–dic 2025 y medidos en 2026 (scripts/tennis-set1-backtest.mjs); base = el centro
// de cada superficie ajustado con los sets hasta dic 2025 (α queda cerca de 0 y sigue la deriva).
export const SET_LEN = { base: { hard: 0.6409, clay: 0.6059, grass: 0.6404 }, kd: 0.73, sigma: 0.02, sigmaD: 0.03, lP: 1500, lT: 4000, lA: 2000, half: 160 };
export const shortSets = (m) => /next gen/i.test(m.tournament ?? ''); // sets a 4 games: el modelo no aplica
export const setDone = ([x, y]) => (Math.max(x, y) >= 6 && Math.abs(x - y) >= 2) || Math.max(x, y) === 7;

// d que da la p de partido con centro c: ajuste de serveFromMatchProb (error < 2.5% con p ≤ 0.97), sin la cadena.
const GAP = { 3: [39.642, -37.726, 0.532, -0.406], 5: [49.787, -45.358, 0.67, -0.528] };
export function gapOf(p, c, bestOf = 3) {
  const q = Math.min(0.97, Math.max(0.03, p)), L = Math.log(q / (1 - q)), x = c - 0.64;
  const [r0, r1, r2, r3] = GAP[bestOf === 5 ? 5 : 3];
  return L / (r0 + r1 * x + (r2 + r3 * x) * L * L);
}

// Grillas cada 0.005 en c y |d|, llenadas a demanda, con interpolación bilineal: setGames y su mezcla (Gauss-Hermite
// 5 × 3 sobre c y d).
const STEP = 0.005;
const GH5 = [[0, 0.533333333], [1.35562618, 0.222075922], [-1.35562618, 0.222075922], [2.85697001, 0.011257411], [-2.85697001, 0.011257411]];
const GH3 = [[0, 2 / 3], [1.7320508, 1 / 6], [-1.7320508, 1 / 6]];
const grid = (f) => {
  const cells = new Map();
  const cell = (i, j) => cells.get(i * 1000 + j) ?? cells.set(i * 1000 + j, f(i * STEP, j * STEP)).get(i * 1000 + j);
  return (c, d) => {
    const x = Math.min(0.8, Math.max(0.45, c)) / STEP, y = Math.min(0.15, Math.abs(d)) / STEP;
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const [a, b, e, g] = [cell(i, j), cell(i + 1, j), cell(i, j + 1), cell(i + 1, j + 1)];
    return a.map((v, k) => (1 - fx) * (1 - fy) * v + fx * (1 - fy) * b[k] + (1 - fx) * fy * e[k] + fx * fy * g[k]);
  };
};
const plain = grid((c, d) => setGames(c + d, c - d));
const mixed = grid((c, d) => {
  const out = Array(14).fill(0);
  for (const [z, w] of GH5) for (const [zd, wd] of GH3) plain(c + SET_LEN.sigma * z, d + SET_LEN.sigmaD * zd).forEach((v, k) => (out[k] += w * wd * v));
  return out;
});
const meanOf = (P) => P.reduce((s, p, k) => s + p * k, 0);

// α, β, T y D con los partidos terminados antes de asOf (ms); p de cada partido con el Elo de ese momento.
export function setLengthFrom(matches, { asOf = Date.now() } = {}) {
  const K = SET_LEN, elo = new Map(), rows = [];
  for (const m of finished(matches)) {
    const t = Date.parse(m.date);
    if (!(t < asOf)) break;
    const p = matchProb(elo, m.a.id, m.b.id, m.surface);
    eloStep(elo, m);
    if (shortSets(m)) continue;
    const w = 0.5 ** ((asOf - t) / (K.half * DAY));
    m.sets.filter(setDone).forEach((s, k) => rows.push({ s: m.surface, tn: m.tournament, a: m.a.id, b: m.b.id, p, bo: m.bestOf, later: k > 0, g: s[0] + s[1], w }));
  }
  const al = { hard: 0, clay: 0, grass: 0 }, T = new Map(), D = new Map();
  let be = 0;
  const eff = (r) => al[r.s] + (r.later ? be : 0) + (T.get(r.tn) ?? 0) + (D.get(r.a) ?? 0) + (D.get(r.b) ?? 0);
  // Una pasada de backfitting: key(r) da los grupos de r; el efecto de cada grupo = Σw·residuo / (Σw + λ).
  const solve = (key, get, set, lambda) => {
    const num = new Map(), den = new Map();
    for (const r of rows) for (const k of key(r)) {
      num.set(k, (num.get(k) ?? 0) + r.wf * (r.y - eff(r) + get(k)));
      den.set(k, (den.get(k) ?? 0) + r.wf);
    }
    for (const [k, n] of num) set(k, den.get(k) + lambda > 0 ? n / (den.get(k) + lambda) : 0);
  };
  for (let outer = 0; outer < 3; outer++) {
    for (const r of rows) { // linealizar en el centro actual del set
      const e = eff(r), c = K.base[r.s] + e, d = K.kd * gapOf(r.p, c, r.bo), h = 0.005;
      const P = mixed(c, d), E = meanOf(P), V = P.reduce((s, p, k) => s + p * (k - E) ** 2, 0);
      const slope = (meanOf(mixed(c + h, d)) - meanOf(mixed(c - h, d))) / (2 * h);
      const ok = slope > 1 && V > 0; // en el borde de la grilla la pendiente es 0: ese set no informa
      r.y = ok ? e + (r.g - E) / slope : e;
      r.wf = ok ? (r.w * slope * slope) / V : 0;
    }
    for (let it = 0; it < 6; it++) {
      solve((r) => [r.s], (k) => al[k], (k, v) => (al[k] = v), K.lA);
      solve((r) => (r.later ? ['later'] : []), () => be, (k, v) => (be = v), 0);
      solve((r) => [r.tn], (k) => T.get(k) ?? 0, (k, v) => T.set(k, v), K.lT);
      solve((r) => [r.a, r.b], (k) => D.get(k) ?? 0, (k, v) => D.set(k, v), K.lP);
    }
  }
  return { al, be, T, D };
}

// P[k] de k games en el primer set (k = 0..13; 13 = tiebreak), o null en formatos de sets cortos.
export function firstSetGames(fit, m, p) {
  if (shortSets(m)) return null;
  const K = SET_LEN;
  const c = K.base[m.surface] + fit.al[m.surface] + (fit.T.get(m.tournament) ?? 0) + (fit.D.get(m.a.id) ?? 0) + (fit.D.get(m.b.id) ?? 0);
  return mixed(c, K.kd * gapOf(p, c, m.bestOf));
}
