// Núcleo de precios: probabilidad → cuota justa y cuota con margen. price, normalOver y negBinPmf viven en
// public/betmath.js porque el navegador también cotiza (líneas personalizadas de props).
import { poissonPmf, MAX_P } from '../public/betmath.js';

export { MARGIN, MAX_P, price, negBinPmf, normalOver } from '../public/betmath.js';

export const halfLine = (x) => Math.floor(x) + 0.5;

// Marcadores 0..max con corrección Dixon-Coles en 0-0, 0-1, 1-0, 1-1; suma 1.
export function scoreGrid(lh, la, { rho = -0.1, max = 10 } = {}) {
  const tau = (i, j) => {
    if (i === 0 && j === 0) return 1 - lh * la * rho;
    if (i === 0 && j === 1) return 1 + lh * rho;
    if (i === 1 && j === 0) return 1 + la * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  };
  const g = [];
  let total = 0;
  for (let i = 0; i <= max; i++) {
    g.push([]);
    for (let j = 0; j <= max; j++) {
      const v = poissonPmf(i, lh) * poissonPmf(j, la) * tau(i, j);
      g[i].push(v);
      total += v;
    }
  }
  return g.map((row) => row.map((v) => v / total));
}

export const countOver = (pmf, line) => pmf.reduce((s, p, k) => (k > line ? s + p : s), 0);

// Margen por mercado, el que cobra Betano.co en las ligas grandes (docs/betano-audit.md): 5 % en los principales,
// 7 % en los secundarios de dos lados, 9 % en los 1X2 secundarios y más con muchas salidas. ah/aou no se midieron:
// van como el hándicap y el total principal.
export const MARGINS = { '1x2': 0.05, ml: 0.05, spread: 0.05, ou: 0.05, ah: 0.05, aou: 0.05, ou_games: 0.06, games_hcp: 0.06, dc: 0.09, sets: 0.12, cs: 0.25 };
export const marginOf = (key) => MARGINS[key] ?? (key.endsWith('_1x2') ? 0.09 : 0.07);
const oddsyOf = (q) => Math.floor(Math.min(101, Math.max(1.01, 1 / q)) * 100 + 1e-9) / 100; // truncada, como price()
// Método de potencias: cuota 1/pᵏ con Σpᵏ = 1 + m. El no favorito carga más margen, como en Betano.
export function powerOdds(ps, m) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (ps.reduce((s, p) => s + p ** k, 0) > 1 + m) lo = k; else hi = k;
  }
  return ps.map((p) => oddsyOf(p ** hi));
}

// Sin selecciones con p > MAX_P (topan en 1.01 sin margen). Si las opciones suman 1 (dos lados, 1X2) cae el mercado
// entero: sin una quedaría incompleto. Si no (doble oportunidad, marcador exacto), solo ellas.
const partition = (m) => Math.abs(m.selections.reduce((t, s) => t + s.p, 0) - 1) < 1e-6;
// Varias líneas Más/Menos en un mercado (córners, tarjetas): cada par suma 1.
const pairs = (ss) => ss.length % 2 === 0 && ss.every((s, i) => i % 2 || Math.abs(s.p + ss[i + 1].p - 1) < 1e-6);
function withMargin(m) {
  const mg = marginOf(m.key), ps = m.selections.map((s) => s.p);
  const odds = partition(m) ? powerOdds(ps, mg)
    : pairs(m.selections) ? ps.flatMap((p, i) => (i % 2 ? [] : powerOdds([p, ps[i + 1]], mg)))
    : ps.map((p) => oddsyOf(p * (1 + mg))); // doble oportunidad: no suma 1, margen proporcional
  return { ...m, selections: m.selections.map((s, i) => ({ ...s, oddsy: odds[i] })) };
}
export const publishable = (markets) => markets
  .map((m) => (partition(m) ? m : { ...m, selections: m.selections.filter((s) => s.p <= MAX_P) }))
  .filter((m) => m.selections.length >= 2 && m.selections.every((s) => s.p <= MAX_P))
  .map(withMargin);
