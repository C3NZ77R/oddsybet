// Lo que el modelo aprende de sus picks cerrados (registro en lib/picklog.mjs). Señales por partido y un ajuste
// logístico por deporte sobre la p del modelo: logit p' = a_mercado + b_mercado·logit p + c_liga + w·señales.
// Sin ajuste en uso (o sin base), p' = p: nada de esto puede tumbar Mejores apuestas.

// Partidos desde los que la muestra ya no es "poca": temporada actual del equipo con menos, o historia Elo del tenista.
export const FEW_N = { soccer: 10, basketball: 10, tennis: 20 };
export const fewOf = (sport, n) => Math.max(0, 1 - (n ?? 0) / FEW_N[sport]);

import { MAX_P } from '../public/betmath.js';
import { dbFromEnv } from './db.mjs';

const DAY = 86_400_000;
// days: ventana de filas; testDays: las más recientes, aparte para validar; minRows: filas para que un mercado o una liga
// tengan término propio; minTrain/minTest: mínimos para ajustar; lambda: L2 hacia "no cambiar nada".
export const LEARN = { days: 120, testDays: 14, minRows: 30, minTrain: 100, minTest: 40, lambda: 5, iters: 25 };
export const MAX_SHIFT = 1; // en logit: de 70 % no sube de 86 % ni baja de 46 %
export const STATUS = ['en_uso', 'sin_mejora', 'pocos_datos'];
const SIGNALS = ['few', 'abs'];

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// p ajustada de un pick con los parámetros de su deporte, con el tope de ±MAX_SHIFT y MAX_P.
function adjust(s, { league, market, p, x = {} }) {
  const L = logit(Math.min(1 - 1e-6, Math.max(1e-6, p)));
  const m = s.markets?.[market];
  const eta = (m ? m.a + m.b * L : L) + (s.leagues?.[league] ?? 0) + SIGNALS.reduce((t, k) => t + (s.w?.[k] ?? 0) * (x[k] ?? 0), 0);
  return Math.min(MAX_P, sigmoid(L + Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, eta - L))));
}

export function applyModel(model, { sport, ...pick }) {
  const s = model?.sports?.[sport];
  return s?.status === 'en_uso' ? Math.min(MAX_P, r4(adjust(s, pick))) : pick.p;
}

// Lo que viene de la base se valida antes de usarlo: un modelo roto sería peor que ninguno.
export function parseModel(raw) {
  if (!raw || typeof raw !== 'object' || !raw.sports || typeof raw.sports !== 'object') return null;
  for (const s of Object.values(raw.sports)) {
    if (!STATUS.includes(s?.status)) return null;
    if (s.status !== 'en_uso') continue;
    const ok = Object.values(s.markets ?? {}).every((m) => Number.isFinite(m?.a) && Number.isFinite(m?.b))
      && Object.values(s.leagues ?? {}).every(Number.isFinite) && SIGNALS.every((k) => Number.isFinite(s.w?.[k] ?? 0));
    if (!ok) return null;
  }
  return raw;
}

// Ax = b por eliminación gaussiana con pivoteo parcial (A chica y simétrica definida positiva por el λ).
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) x[r] = (M[r][n] - M[r].slice(r + 1, n).reduce((s, v, k) => s + v * x[r + 1 + k], 0)) / M[r][r];
  return x;
}

// Regresión logística con L2 hacia (a 0, b 1, c 0, w 0), por Newton. Mercados y ligas con pocas filas quedan fijos.
function fit(rows) {
  const count = (k) => rows.reduce((m, r) => m.set(r[k], (m.get(r[k]) ?? 0) + 1), new Map());
  const markets = [...count('market')].filter(([, n]) => n >= LEARN.minRows).map(([k]) => k);
  const leagues = [...count('league')].filter(([, n]) => n >= LEARN.minRows).map(([k]) => k);
  const at = new Map([...markets.map((m, i) => [`m:${m}`, 2 * i]), ...leagues.map((l, i) => [`l:${l}`, 2 * markets.length + i])]);
  const W = 2 * markets.length + leagues.length, dim = W + SIGNALS.length;
  const theta0 = Array.from({ length: dim }, (_, i) => (i < 2 * markets.length && i % 2 === 1 ? 1 : 0));
  // Cada fila: offset (logit p si su mercado no tiene término propio) y los índices/valores de sus columnas.
  const data = rows.map((r) => {
    const L = logit(Math.min(1 - 1e-6, Math.max(1e-6, r.pRaw)));
    const z = [], mi = at.get(`m:${r.market}`), li = at.get(`l:${r.league}`);
    if (mi !== undefined) z.push([mi, 1], [mi + 1, L]);
    if (li !== undefined) z.push([li, 1]);
    SIGNALS.forEach((k, i) => z.push([W + i, r.x?.[k] ?? 0]));
    return { off: mi === undefined ? L : 0, z, y: r.won ? 1 : 0 };
  });
  let theta = [...theta0];
  for (let it = 0; it < LEARN.iters; it++) {
    const g = theta.map((t, i) => -LEARN.lambda * (t - theta0[i]));
    const H = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => (i === j ? LEARN.lambda : 0)));
    for (const d of data) {
      const p = sigmoid(d.off + d.z.reduce((s, [i, v]) => s + theta[i] * v, 0));
      for (const [i, v] of d.z) {
        g[i] += (d.y - p) * v;
        for (const [j, u] of d.z) H[i][j] += p * (1 - p) * v * u;
      }
    }
    const step = solve(H, g);
    theta = theta.map((t, i) => t + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const n = count('market');
  return {
    markets: Object.fromEntries(markets.map((m, i) => [m, { a: r4(theta[2 * i]), b: r4(theta[2 * i + 1]), n: n.get(m) }])),
    leagues: Object.fromEntries(leagues.map((l, i) => [l, r4(theta[2 * markets.length + i])])),
    w: Object.fromEntries(SIGNALS.map((k, i) => [k, r4(theta[W + i])])),
  };
}

const logLoss = (rows, s) => rows.reduce((t, r) => {
  const p = s ? adjust(s, { ...r, p: r.pRaw }) : r.pRaw;
  return t - Math.log(Math.max(1e-12, r.won ? p : 1 - p));
}, 0) / rows.length;

// rows = [{ league, market, pRaw, x, won, gameStart }] de un deporte. Aprende sin los últimos testDays y solo se usa si
// en esos días acierta mejor que el modelo solo; entonces se vuelve a ajustar con todas las filas.
export function fitSport(rows, { now = Date.now() } = {}) {
  const cut = now - LEARN.testDays * DAY;
  const train = rows.filter((r) => Date.parse(r.gameStart) < cut), test = rows.filter((r) => Date.parse(r.gameStart) >= cut);
  const base = { n: rows.length, nTest: test.length };
  if (train.length < LEARN.minTrain || test.length < LEARN.minTest) return { status: 'pocos_datos', ...base };
  const llBase = logLoss(test, null), llModel = logLoss(test, fit(train));
  const scores = { llBase: r4(llBase), llModel: r4(llModel) };
  return llModel < llBase ? { status: 'en_uso', ...base, ...scores, ...fit(rows) } : { status: 'sin_mejora', ...base, ...scores };
}

export const learnModel = (rowsBySport, { now = Date.now() } = {}) => ({
  version: 1,
  at: new Date(now).toISOString(),
  sports: Object.fromEntries(Object.entries(rowsBySport).map(([sport, rows]) => [sport, fitSport(rows, { now })])),
});

// El último modelo guardado, 10 min en memoria. Sin base, con error, lento (3 s) o roto: el último bueno, o null.
let memo = { at: -Infinity, model: null };
export async function currentModel({ db = dbFromEnv(), now = Date.now() } = {}) {
  if (!db) return null;
  if (now - memo.at < 10 * 60_000) return memo.model;
  memo.at = now; // un fallo tampoco se reintenta en cada visita
  let t;
  try {
    const raw = await Promise.race([db.latestModel(), new Promise((_, no) => { t = setTimeout(no, 3000, new Error('lento')); t.unref?.(); })]);
    memo.model = parseModel(raw) ?? memo.model;
  } catch (err) {
    console.error('currentModel:', err.message);
  } finally {
    clearTimeout(t);
  }
  return memo.model;
}
