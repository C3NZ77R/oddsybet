// Cuánto pesa el modelo frente a la línea de la casa (lib/book.mjs, anchor): con los ratings de antes de cada partido
// (predict de scripts/backtest.mjs, sin fuga) y la última línea previa del pickcenter de los summaries en .cache/espn/,
// log-loss de cada peso del modelo (0 = solo la línea, 1 = solo el modelo) en los mercados que publica Oddsy. Básquet:
// peso de mu (ganador y hándicap en la línea de la casa) y del total (Más/Menos en la línea). Fútbol: un peso para las
// λ, medido en 1X2, total en la línea y ambos marcan (este último no está en la línea: prueba que las λ de la casa
// sirven también fuera de ella). Imprime el mejor peso de toda la temporada y de cada mitad; copiar a MODEL_WEIGHT.
// Uso: node scripts/anchor-backtest.mjs [--vigente] [liga…] (sin ligas: nba laliga epl ucl). Sin red: solo .cache/espn/.
// --vigente: la temporada en curso (lo jugado este año calendario, como Liga BetPlay y Libertadores) contra lo anterior,
// con red educada para los calendarios que falten (quedan en la caché).
// Escribe docs/accuracy.json → anchor.<liga>.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { leagueById } from '../public/leagues.js';
import { getPastSeason, getSeasonResults } from '../lib/espn.mjs';
import { normalOver } from '../lib/pricing.mjs';
import { marketsFor } from '../lib/markets.mjs';
import { anchor, lineFrom } from '../lib/book.mjs';
import { politeFetch, predict, halves } from './backtest.mjs';

const OUT = new URL('../docs/accuracy.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const WEIGHTS = Array.from({ length: 11 }, (_, i) => i / 10);
const EPS = 1e-12;
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const loss = (p) => -Math.log(Math.max(p, EPS));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Líneas por liga de ESPN e id de partido. grep primero: leer los ~3 GB de la caché en Node tarda minutos.
async function cachedLines() {
  const files = execFileSync('grep', ['-rlF', '"pickcenter":[{', CACHE], { maxBuffer: 1 << 26 }).toString().split('\n').filter(Boolean);
  const out = new Map();
  for (const f of files) {
    const d = JSON.parse(await readFile(f, 'utf8'));
    const line = lineFrom(d.pickcenter), slug = d.header?.league?.slug;
    if (line && slug) (out.get(slug) ?? out.set(slug, new Map()).get(slug)).set(String(d.header.id), line);
  }
  return out;
}

// −ln p del resultado de cada mercado medido, por partido; null si el mercado no aplica (sin línea o devuelta).
function lossesNormal(pred, line, model) {
  const { mu, sigma, total, sigmaT } = model;
  const out = {};
  if (line.ml || line.spread) {
    const [o, u] = [normalOver(mu, sigma, 0), normalOver(-mu, sigma, 0)];
    out.ml = loss(pred.margin > 0 ? o / (o + u) : u / (o + u));
  }
  if (line.spread && pred.margin + line.spread.line !== 0) {
    const p = normalOver(mu, sigma, -line.spread.line);
    out.spread = loss(pred.margin + line.spread.line > 0 ? p : 1 - p);
  }
  if (line.total && pred.points !== line.total.line) {
    const p = normalOver(total, sigmaT, line.total.line);
    out.ou = loss(pred.points > line.total.line ? p : 1 - p);
  }
  return out;
}

function lossesSoccer(pred, line, model) {
  const ms = marketsFor('soccer', model);
  const p = (key, name) => ms.find((m) => m.key === key).selections.find((s) => s.name === name).p;
  const out = { '1x2': loss(p('1x2', { H: 'Local', D: 'Empate', A: 'Visitante' }[pred.outcome])) };
  out.btts = loss(p('btts', pred.homeScore > 0 && pred.awayScore > 0 ? 'Sí' : 'No'));
  if (line.total && pred.points !== line.total.line) {
    // La grilla da el Más en cualquier línea .5; en una entera (rara) se salta.
    const m = ms.find((x) => x.key === 'ou' && x.selections[0].line === line.total.line);
    if (m) out.ou = loss(pred.points > line.total.line ? m.selections[0].p : m.selections[1].p);
  }
  return out;
}

// Log-loss medio por mercado para cada peso; best = el peso con menos log-loss sumando los mercados del grupo.
function sweep(rows, sport, group) {
  const by = WEIGHTS.map((w) => {
    const ls = rows.map(({ pred, line }) => {
      const wt = sport === 'soccer' ? w : { mu: group === 'mu' ? w : 0, total: group === 'total' ? w : 0 };
      const m = anchor(sport, pred.model, line, wt);
      return sport === 'soccer' ? lossesSoccer(pred, line, m) : lossesNormal(pred, line, m);
    });
    const keys = sport === 'soccer' ? ['1x2', 'ou', 'btts'] : group === 'mu' ? ['ml', 'spread'] : ['ou'];
    return { w, ...Object.fromEntries(keys.map((k) => [k, avg(ls.map((l) => l[k]).filter((x) => x != null))])) };
  });
  const keys = Object.keys(by[0]).filter((k) => k !== 'w');
  const score = (r) => keys.reduce((s, k) => s + r[k], 0);
  return { best: by.reduce((a, b) => (score(b) < score(a) ? b : a)).w, model: by.at(-1), market: by[0], byWeight: by };
}

async function main(args) {
  const current = args.includes('--vigente');
  const leagues = args.filter((a) => a !== '--vigente');
  const ids = leagues.length ? leagues : ['nba', 'laliga', 'epl', 'ucl'];
  globalThis.fetch = politeFetch(current ? globalThis.fetch : () => Promise.reject(new Error('sin red: falta en .cache/espn/')), { dir: CACHE });
  const year = String(new Date().getUTCFullYear());
  const cached = await cachedLines();
  const fresh = {};
  for (const id of ids) {
    const lg = leagueById(id);
    const lines = cached.get(lg.espn) ?? new Map();
    let test, prev;
    try {
      if (current) {
        const rs = await getSeasonResults(id);
        [test, prev] = [{ season: year, results: rs.filter((r) => r.date >= year) }, { results: rs.filter((r) => r.date < year) }];
      } else [test, prev] = [await getPastSeason(id, 1), await getPastSeason(id, 2)];
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      continue;
    }
    const rows = predict(lg.sport, prev.results, test.results).filter((p) => lines.has(String(p.id))).map((pred) => ({ pred, line: lines.get(String(pred.id)) }));
    if (rows.length < 50) {
      console.log(`${id} ${test.season}: ${rows.length} partidos con línea, se salta`);
      continue;
    }
    const groups = lg.sport === 'soccer' ? ['lambda'] : ['mu', 'total'];
    const e = { season: test.season, games: rows.length };
    for (const g of groups) {
      const all = sweep(rows, lg.sport, g), parts = halves(rows).map((h) => sweep(h, lg.sport, g).best);
      e[g] = { best: all.best, halves: parts, model: all.model, market: all.market, atBest: all.byWeight.find((r) => r.w === all.best) };
      console.log(`${id} ${test.season} (${rows.length} partidos) ${g}: mejor peso del modelo ${all.best} (mitades ${parts.join(' / ')})`);
      for (const k of ['model', 'market', 'atBest']) console.log(`  ${k.padEnd(6)} ${Object.entries(e[g][k]).map(([m, v]) => `${m} ${r4(v)}`).join('  ')}`);
    }
    fresh[current ? `${id}_${year}` : id] = JSON.parse(JSON.stringify(e, (k, v) => (typeof v === 'number' ? r4(v) : v)));
  }
  if (!Object.keys(fresh).length) return;
  const old = JSON.parse(await readFile(OUT, 'utf8')); // releer justo antes: otros scripts escriben el mismo archivo
  await writeFile(OUT, `${JSON.stringify({ ...old, anchor: { ...old.anchor, ...fresh } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
