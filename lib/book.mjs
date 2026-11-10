// La línea de la casa que trae ESPN (DraftKings: odds del scoreboard y pickcenter del summary) como insumo de las cuotas
// propias. El mercado predice mejor que el modelo solo (scripts/market-backtest.mjs → docs/accuracy.json → market), así
// que cada partido con línea se cotiza con una mezcla de los parámetros del modelo y los que reproducen la línea. La
// línea nunca se muestra: Oddsy no muestra precios ajenos (Ruling 11).
import { normalOver } from '../public/betmath.js';
import { scoreGrid } from './pricing.mjs';

// Peso del modelo en la mezcla (0 = solo el mercado), de scripts/market-backtest.mjs. Fútbol: en log de las λ.
// Backtest de 2026-11-09 (docs/accuracy.json → anchor): NBA 2025-26 (246 partidos), LaLiga, Premier y Champions 2025-26
// (587) y Libertadores 2026 (141). Ganador y hándicap: 0 en toda la temporada y en cada mitad; total 0.2 (mitades 0 y
// 0.9: la ganancia es de 0.001 en log-loss). Fútbol: 0 en LaLiga, Premier y Libertadores, 0.3 en Champions (96).
export const MODEL_WEIGHT = { basketball: { mu: 0, total: 0.2 }, soccer: 0 };

const american = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  const n = s === 'EVEN' ? 100 : Number(s);
  return s && Number.isFinite(n) && Math.abs(n) >= 100 ? (n > 0 ? 1 + n / 100 : 1 + 100 / -n) : null;
};
const number = (v) => (v == null || v === '' ? null : Number.isFinite(Number(String(v).replace(/^[ou]/i, ''))) ? Number(String(v).replace(/^[ou]/i, '')) : null);
// Sin margen, proporcional; null si falta alguna cuota. Potencias y Shin empatan con él en los 1 607 cierres de
// .cache/espn/ (ganador/1X2 −0.0006 de log-loss por partido, totales +0.001): no vale la complejidad.
const fair = (odds) => (odds.every(Boolean) ? odds.map((o) => (1 / o) / odds.reduce((s, x) => s + 1 / x, 0)) : null);

// Línea de una entrada de odds de ESPN (scoreboard competitions[0].odds[i] o summary pickcenter[i]), la última previa
// al partido: los campos planos y, si faltan, close u open. Nunca current: en juego es la cuota en vivo.
// → { ml: [local, visita] | [local, empate, visita], spread: { line /*local*/, p /*cubre el local*/ }, total: { line, p /*Más*/ } }
// en probabilidades sin margen, o null sin ninguna. open: la de apertura (para el movimiento de la línea).
export function lineOf(o, { open = false } = {}) {
  if (!o) return null;
  const at = (x) => (open ? x?.open : x?.close ?? x?.open);
  const flat = (v) => (open ? null : v);
  const ml = fair([american(flat(o.homeTeamOdds?.moneyLine) ?? at(o.moneyline?.home)?.odds),
    ...(o.drawOdds || o.moneyline?.draw ? [american(flat(o.drawOdds?.moneyLine) ?? at(o.moneyline?.draw)?.odds)] : []),
    american(flat(o.awayTeamOdds?.moneyLine) ?? at(o.moneyline?.away)?.odds)]);
  const sLine = number(flat(o.spread) ?? at(o.pointSpread?.home)?.line);
  const sp = fair([american(flat(o.homeTeamOdds?.spreadOdds) ?? at(o.pointSpread?.home)?.odds), american(flat(o.awayTeamOdds?.spreadOdds) ?? at(o.pointSpread?.away)?.odds)]);
  const tLine = number(flat(o.overUnder) ?? at(o.total?.over)?.line);
  const tp = fair([american(flat(o.overOdds) ?? at(o.total?.over)?.odds), american(flat(o.underOdds) ?? at(o.total?.under)?.odds)]);
  const out = { ...(ml && { ml }), ...(sp && sLine != null && { spread: { line: sLine, p: sp[0] } }), ...(tp && tLine != null && { total: { line: tLine, p: tp[0] } }) };
  return Object.keys(out).length ? out : null;
}

// La primera entrada con alguna línea (ESPN ordena por prioridad del proveedor).
export const lineFrom = (list, opts) => (Array.isArray(list) ? list : []).reduce((got, o) => got ?? lineOf(o, opts), null);

// x con f(x) = target, f creciente en [lo, hi].
function solve(f, target, lo, hi) {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// P(Más de x) sin la devolución, como la cuota sin margen de la casa: en una línea entera el push no cuenta.
const twoWay = (m, sd, x) => {
  const over = normalOver(m, sd, x), under = Number.isInteger(x) ? 1 - normalOver(m, sd, x - 1) : 1 - over;
  return over / (over + under);
};

// mu (margen del local) y total del modelo normal que reproducen la línea con los σ del modelo; null lo que falte. El
// hándicap manda sobre el ganador porque su cuota es pareja (el ganador del favorito grande casi no informa).
export function impliedNormal(line, { sigma, sigmaT }) {
  const mu = line?.spread ? solve((m) => twoWay(m, sigma, -line.spread.line), line.spread.p, -80, 80)
    : line?.ml?.length === 2 ? solve((m) => twoWay(m, sigma, 0), line.ml[0], -80, 80) : null;
  const total = line?.total ? solve((t) => twoWay(t, sigmaT, line.total.line), line.total.p, 0, 400) : null;
  return { mu, total };
}

// Probabilidades de la grilla de Dixon-Coles que se comparan con la línea: 1X2 y Más de la línea de goles.
function gridProbs(lh, la, tLine) {
  const g = scoreGrid(lh, la);
  let H = 0, D = 0, over = 0, under = 0;
  g.forEach((row, i) => row.forEach((p, j) => {
    if (i > j) H += p; else if (i === j) D += p;
    if (i + j > tLine) over += p; else if (i + j < tLine) under += p; // en una línea entera el push no cuenta
  }));
  return { H, D, A: 1 - H - D, over: over / (over + under) };
}

// λ local y visitante que mejor reproducen el 1X2 y el total de la línea (mínimos cuadrados, búsqueda por coordenadas
// en log). null sin 1X2 de tres salidas.
export function impliedPoisson(line, start = { lh: 1.4, la: 1.1 }) {
  if (line?.ml?.length !== 3) return null;
  const [H, D, A] = line.ml;
  const err = (lh, la) => {
    const q = gridProbs(lh, la, line.total?.line);
    return (q.H - H) ** 2 + (q.D - D) ** 2 + (q.A - A) ** 2 + (line.total ? (q.over - line.total.p) ** 2 : 0);
  };
  let x = [Math.log(start.lh), Math.log(start.la)], e = err(...x.map(Math.exp));
  for (let step = 0.3; step > 1e-4; step /= 2) {
    for (let moved = true, k = 0; moved && k < 50; k++) {
      moved = false;
      for (const d of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const y = [x[0] + d[0], x[1] + d[1]].map((v) => Math.max(Math.log(0.05), Math.min(Math.log(6), v)));
        const ey = err(...y.map(Math.exp));
        if (ey < e) [x, e, moved] = [y, ey, true];
      }
    }
  }
  return { lh: Math.exp(x[0]), la: Math.exp(x[1]) };
}

// El modelo anclado a la línea: mezcla de parámetros con MODEL_WEIGHT (o w). Sin línea útil, el modelo igual.
export function anchor(sport, model, line, w = MODEL_WEIGHT[sport]) {
  if (!line || w == null) return model;
  if (model.kind === 'normal') {
    const imp = impliedNormal(line, model);
    const mix = (k, a, b) => (b == null ? a : k * a + (1 - k) * b);
    return { ...model, mu: mix(w.mu, model.mu, imp.mu), total: mix(w.total, model.total, imp.total) };
  }
  const imp = impliedPoisson(line, model);
  return imp ? { ...model, lh: model.lh ** w * imp.lh ** (1 - w), la: model.la ** w * imp.la ** (1 - w) } : model;
}
