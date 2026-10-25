// El modelo contra el mercado: P de ganador, hándicap y total de los partidos con la línea de una casa en el summary de
// ESPN (pickcenter: la última previa al partido, DraftKings en la NBA), con los ratings de antes del partido (predict de
// scripts/backtest.mjs, sin fuga). Por mercado: log-loss del modelo y de la casa sin margen (pareado por partido), el peso
// del modelo en la mezcla w·modelo + (1−w)·casa que mejor predice, y el ROI a la cuota de la casa de apostar el lado que
// el modelo da más probable (como picksOf) o solo con EV > 0 / > 5 % según el modelo.
// Uso: node scripts/market-backtest.mjs [liga…] (sin ligas: nba wnba nfl). Sin red: solo .cache/espn/ (los summaries que
// dejaron los otros backtests; una liga sin líneas en la caché se salta). Escribe docs/accuracy.json → market.<liga>.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leagueById } from '../public/leagues.js';
import { getPastSeason } from '../lib/espn.mjs';
import { normalOver } from '../lib/pricing.mjs';
import { SPORT_MODEL } from '../lib/ratings.mjs';
import { politeFetch, predict } from './backtest.mjs';

const OUT = new URL('../docs/accuracy.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const EPS = 1e-12;
const WEIGHTS = Array.from({ length: 11 }, (_, i) => i / 10);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const avg = (xs) => sum(xs) / xs.length;
const loss = (p, won) => -Math.log(Math.max(won ? p : 1 - p, EPS));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export const decimal = (american) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
const noVig = ([a, b]) => (1 / a) / (1 / a + 1 / b);

// Línea de la casa de un summary, en decimal y del lado local / del Más; null sin pickcenter. Mercados sin cuota faltan.
export function bookLines(summary) {
  const pc = summary?.pickcenter?.find((p) => p.homeTeamOdds?.moneyLine != null) ?? summary?.pickcenter?.[0];
  if (!pc) return null;
  const [H, A] = [pc.homeTeamOdds ?? {}, pc.awayTeamOdds ?? {}];
  const two = (a, b) => (a != null && b != null ? [decimal(a), decimal(b)] : null);
  const ml = two(H.moneyLine, A.moneyLine), so = two(H.spreadOdds, A.spreadOdds), to = two(pc.overOdds, pc.underOdds);
  return {
    provider: pc.provider?.name ?? null,
    ...(ml && { ml }),
    ...(so && pc.spread != null && { spread: { line: pc.spread, odds: so } }),
    ...(to && pc.overUnder != null && { total: { line: pc.overUnder, odds: to } }),
  };
}

// Una fila por mercado del partido, del lado local / del Más: p del modelo, p de la casa sin margen, cuotas y resultado.
// Las devoluciones (margen o total justo en la línea) no entran.
export function marketRows(pred, lines) {
  const { mu, sigma, total, sigmaT } = pred.model;
  const rows = [];
  const add = (market, p, odds, result) => result !== 0 && rows.push({ game: pred.id, market, p, book: noVig(odds), odds, won: result > 0 });
  if (lines.ml) {
    const [o, u] = [normalOver(mu, sigma, 0), normalOver(-mu, sigma, 0)];
    add('ml', o / (o + u), lines.ml, pred.margin); // como marketsFor: sin empate, renormalizado
  }
  if (lines.spread) add('spread', normalOver(mu, sigma, -lines.spread.line), lines.spread.odds, pred.margin + lines.spread.line);
  if (lines.total) add('ou', normalOver(total, sigmaT, lines.total.line), lines.total.odds, pred.points - lines.total.line);
  return rows;
}

// Apuestas de una regla: por fila, el lado elegido (0 = local/Más, 1 = el otro) o null.
const RULES = {
  probable: (r) => (r.p >= 0.5 ? 0 : 1),
  ev0: (r) => best(r, 0),
  ev5: (r) => best(r, 0.05),
};
function best(r, min) {
  const ev = [r.p * r.odds[0] - 1, (1 - r.p) * r.odds[1] - 1];
  const k = ev[0] >= ev[1] ? 0 : 1;
  return ev[k] > min ? k : null;
}
function roi(rows, rule) {
  const bets = rows.map((r) => [r, RULES[rule](r)]).filter(([, k]) => k != null).map(([r, k]) => ({ won: r.won === (k === 0), odds: r.odds[k] }));
  if (!bets.length) return { n: 0 };
  return { n: bets.length, hit: avg(bets.map((b) => +b.won)), roi: avg(bets.map((b) => (b.won ? b.odds - 1 : -1))) };
}

// Resumen por mercado y para todos juntos. vsBook.diff < 0: el modelo predice mejor que la casa.
export function marketEntry(rows) {
  const one = (rs) => {
    const d = rs.map((r) => loss(r.p, r.won) - loss(r.book, r.won)), m = avg(d);
    const blend = WEIGHTS.map((w) => [w, avg(rs.map((r) => loss(w * r.p + (1 - w) * r.book, r.won)))]).reduce((a, b) => (b[1] < a[1] ? b : a));
    return {
      n: rs.length,
      logloss: avg(rs.map((r) => loss(r.p, r.won))),
      book: avg(rs.map((r) => loss(r.book, r.won))),
      vsBook: { diff: m, se: Math.sqrt(sum(d.map((x) => (x - m) ** 2)) / (d.length - 1) / d.length) },
      blendWeight: blend[0],
      roi: Object.fromEntries(Object.keys(RULES).map((k) => [k, roi(rs, k)])),
    };
  };
  const markets = [...new Set(rows.map((r) => r.market))];
  return { ...Object.fromEntries(markets.map((m) => [m, one(rows.filter((r) => r.market === m))])), all: { roi: Object.fromEntries(Object.keys(RULES).map((k) => [k, roi(rows, k)])) } };
}

const round = (x) => (typeof x === 'number' ? r4(x) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round(v)])) : x);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// Líneas de los summaries de la caché por liga de ESPN y id de partido (escanea .cache/espn/ una vez: el nombre es el
// hash de la URL).
async function cachedLines() {
  const out = new Map();
  for (const f of await readdir(CACHE)) {
    const text = await readFile(CACHE + f, 'utf8');
    if (!text.includes('"pickcenter"')) continue;
    const d = JSON.parse(text);
    const lines = bookLines(d);
    const slug = d.header?.league?.slug;
    if (lines && slug) (out.get(slug) ?? out.set(slug, new Map()).get(slug)).set(String(d.header.id), lines);
  }
  return out;
}

async function main(args) {
  const ids = args.length ? args : ['nba', 'wnba', 'nfl'];
  const bad = ids.filter((id) => SPORT_MODEL[leagueById(id)?.sport] !== 'normal');
  if (bad.length) {
    console.error(`Sin backtest de mercado: ${bad.join(', ')} (solo ligas del modelo normal: nba wnba nfl)`);
    process.exitCode = 2;
    return;
  }
  // Sin red: lo que no está en la caché falla y esa liga se salta.
  globalThis.fetch = politeFetch(() => Promise.reject(new Error('sin red: falta en .cache/espn/')), { dir: CACHE });
  const fresh = {};
  const cached = await cachedLines();
  for (const id of ids) {
    const lg = leagueById(id);
    const lines = cached.get(lg.espn) ?? new Map();
    if (!lines.size) {
      console.log(`${id}: sin líneas de casas en la caché, se salta`);
      continue;
    }
    let test, prev;
    try {
      [test, prev] = [await getPastSeason(id, 1), await getPastSeason(id, 2)];
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    const preds = predict(lg.sport, prev.results, test.results).filter((p) => lines.has(String(p.id)));
    const rows = preds.flatMap((p) => marketRows(p, lines.get(String(p.id))));
    if (!rows.length) {
      console.log(`${id} ${test.season}: las líneas de la caché no son de esta temporada, se salta`);
      continue;
    }
    const provider = [...new Set(preds.map((p) => lines.get(String(p.id)).provider))].join(', ');
    const e = (fresh[id] = round({ season: test.season, games: preds.length, provider, ...marketEntry(rows) }));
    console.log(`${id} ${e.season}: ${e.games} partidos con línea de ${provider}`);
    for (const [m, x] of Object.entries(e)) {
      if (!x?.roi) continue;
      const head = x.n ? `  ${m}: log-loss ${x.logloss} vs casa ${x.book} (dif ${x.vsBook.diff} ± ${x.vsBook.se}), peso del modelo ${x.blendWeight};` : `  ${m}:`;
      console.log(`${head} ROI ${Object.entries(x.roi).map(([k, r]) => (r.n ? `${k} ${pct(r.roi)} (${r.n}, acierto ${pct(r.hit)})` : `${k} —`)).join(', ')}`);
    }
  }
  if (!Object.keys(fresh).length) return;
  const old = JSON.parse(await readFile(OUT, 'utf8')); // releer justo antes: otros scripts escriben el mismo archivo
  await writeFile(OUT, `${JSON.stringify({ ...old, market: { ...old.market, ...fresh } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
