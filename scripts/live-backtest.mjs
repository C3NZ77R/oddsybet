// Backtest de En vivo (public/live.js) en la última temporada completa de la NBA. Con el marcador al terminar el
// 1.º, 2.º y 3.er cuarto (25, 50 y 75 % del partido) calcula P(Más) del total como la vista (remaining + liveOver)
// contra la línea previa de Oddsy: el mercado 'ou' de marketsFor con el modelo sin fuga de scripts/backtest.mjs
// (getMarkets usaría los ratings de hoy, que ya conocen esos resultados). Para cada peso del promedio previo
// (PRIOR.total) mide log-loss, Brier y una tabla por deciles; con paceZ y strength, cuántas señales de cada nivel salen
// y cuántas aciertan su lado contra esa línea. Escribe docs/accuracy.json → live. Uso: node scripts/live-backtest.mjs [nba]
// El marcador por cuarto sale de los linescores del scoreboard de cada día (~100 KB): en esos cortes es el mismo que el
// de las jugadas del summary (~0.5 MB por partido). Todo queda en .cache/espn/ vía politeFetch.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leagueById } from '../public/leagues.js';
import { getPastSeason, mapLimit } from '../lib/espn.mjs';
import { marketsFor } from '../lib/markets.mjs';
import { remaining, liveOver, paceZ, strength, scoringShare, TOTAL } from '../public/live.js';
import { politeFetch, predict } from './backtest.mjs';

export const PRIORS = [1, 2, 3, 5, 8];
export const CUTS = [1, 2, 3]; // cuartos terminados: f = k / 4
const LEAGUES = ['nba'];
const EPS = 1e-12;
const OUT = new URL('../docs/accuracy.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Puntos de los dos equipos al terminar cada cuarto de CUTS. null si faltan cuartos o no suman el final.
export function cutTotals(comp, final) {
  const qs = (comp?.competitors ?? []).map((c) => (c.linescores ?? []).map((l) => Number(l.value)));
  if (qs.length !== 2 || qs.some((q) => q.length < 4 || !q.every(Number.isFinite)) || sum(qs.flat()) !== final) return null;
  return CUTS.map((k) => sum(qs.flatMap((q) => q.slice(0, k))));
}

// P(Más) que daría la vista con lo que van (current) a la fracción f, igual que totalSignal (con la curva de anotación)
// pero con el peso prior.
export function overAt(sport, { current, f, line }, prior) {
  const { kind, sd } = TOTAL[sport];
  return liveOver(kind, current, remaining({ current, progress: scoringShare(sport, f), mean: line, variance: sd ** 2, prior }), line);
}

const loss = (p, won) => -Math.log(Math.max(won ? p : 1 - p, EPS));

// Log-loss, Brier y tramos de 10 en 10 de P(Más) frente a lo que pasó, con el formato de _bins (said = p promedio).
export function calibration(rows) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, said: 0, hit: 0 }));
  for (const { p, won } of rows) {
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++;
    b.said += p;
    b.hit += won;
  }
  return { n: rows.length, brier: sum(rows.map(({ p, won }) => (p - won) ** 2)) / rows.length, logloss: sum(rows.map(({ p, won }) => loss(p, won))) / rows.length,
    bins: bins.flatMap((b, i) => (b.n ? [{ from: i * 10, n: b.n, said: b.said / b.n, hit: b.hit / b.n }] : [])) };
}

// Señales de total por nivel (sin contexto: totalSignal no usa scriptFor): qué parte de los cortes la dispara y cuántas
// aciertan su lado (z ≥ 0 → Más) contra la línea previa.
export function levels(sport, rows) {
  const out = [1, 2, 3].map((level) => ({ level, n: 0, hit: 0 }));
  for (const r of rows) {
    const z = paceZ({ current: r.current, progress: scoringShare(sport, r.f), mean: r.line, variance: TOTAL[sport].sd ** 2 });
    const lv = strength(z);
    if (lv) out[lv - 1].n++, (out[lv - 1].hit += (z >= 0) === r.won);
  }
  return out.map((o) => ({ ...o, share: o.n / rows.length, hit: o.n ? o.hit / o.n : null }));
}

// Log-loss de a menos b por corte, con el error estándar entre partidos (los tres cortes de un partido no son independientes).
export function paired(sport, rows, a, b) {
  const by = new Map();
  for (const r of rows) by.set(r.game, (by.get(r.game) ?? 0) + loss(overAt(sport, r, a), r.won) - loss(overAt(sport, r, b), r.won));
  const d = [...by.values()].map((x) => x / CUTS.length);
  const m = sum(d) / d.length;
  return { diff: m, se: Math.sqrt(sum(d.map((x) => (x - m) ** 2)) / (d.length - 1) / d.length) };
}

// Día del scoreboard de ESPN (hora del Este) de un inicio en UTC.
export const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');

async function rowsOf(id) {
  const { sport, espn } = leagueById(id);
  const [test, prev] = [await getPastSeason(id, 1), await getPastSeason(id, 2)];
  const comps = new Map();
  await mapLimit([...new Set(test.results.map((r) => etDay(r.date)))], 2, async (day) => {
    const res = await fetch(`${SITE}/${sport}/${espn}/scoreboard?dates=${day}&limit=300`);
    if (!res.ok) throw new Error(`scoreboard ${day}: ESPN respondió ${res.status}`);
    for (const e of (await res.json()).events ?? []) comps.set(String(e.id), e.competitions?.[0]);
  });
  const rows = [];
  let skipped = 0;
  for (const pr of predict(sport, prev.results, test.results)) {
    const totals = cutTotals(comps.get(pr.id), pr.points);
    if (!totals) {
      skipped++;
      continue;
    }
    const line = marketsFor(sport, pr.model).find((m) => m.key === 'ou').selections[0].line;
    totals.forEach((current, i) => rows.push({ game: pr.id, f: CUTS[i] / 4, current, line, won: pr.points > line }));
  }
  return { sport, season: test.season, skipped, rows };
}

function entry({ sport, season, skipped, rows }) {
  const fit = (rs, prior) => calibration(rs.map((r) => ({ p: overAt(sport, r, prior), won: r.won })));
  const all = Object.fromEntries(PRIORS.map((p) => [p, fit(rows, p)]));
  const best = PRIORS.reduce((a, b) => (all[b].logloss < all[a].logloss ? b : a)); // empate = el menor
  const priors = Object.fromEntries(PRIORS.map((p) => [p, { brier: all[p].brier, logloss: all[p].logloss, ...(p !== best && { vsBest: paired(sport, rows, p, best) }) }]));
  const cuts = CUTS.map((k) => {
    const rs = rows.filter((r) => r.f === k / 4);
    const zs = rs.map((r) => paceZ({ current: r.current, progress: scoringShare(sport, r.f), mean: r.line, variance: TOTAL[sport].sd ** 2 }));
    const mean = sum(zs) / zs.length;
    return { f: k / 4, z: { mean, sd: Math.sqrt(sum(zs.map((z) => (z - mean) ** 2)) / (zs.length - 1)) },
      priors: Object.fromEntries(PRIORS.map((p) => [p, (({ brier, logloss }) => ({ brier, logloss }))(fit(rs, p))])) };
  });
  return { season, games: rows.length / CUTS.length, skipped, best, priors, bins: all[best].bins, cuts, levels: levels(sport, rows) };
}

async function main(args) {
  const ids = args.length ? args : LEAGUES;
  const bad = ids.filter((id) => !LEAGUES.includes(id));
  if (bad.length) {
    console.error(`Sin backtest en vivo: ${bad.join(', ')}. Ligas válidas: ${LEAGUES.join(' ')}`);
    process.exitCode = 2;
    return;
  }
  await mkdir(CACHE, { recursive: true });
  const espn = politeFetch(globalThis.fetch, { dir: CACHE });
  globalThis.fetch = espn; // lib/espn.mjs pide con el fetch global
  const fresh = {};
  for (const id of ids) {
    try {
      const e = (fresh[id] = JSON.parse(JSON.stringify(entry(await rowsOf(id)), (k, v) => (typeof v === 'number' ? r4(v) : v))));
      console.log(`${id} ${e.season}: ${e.games} partidos (${e.skipped} sin marcador por cuarto). Log-loss por peso del previo `
        + `(diferencia con el mejor ± error): ${PRIORS.map((p) => `${p} → ${e.priors[p].logloss}${p === e.best ? ' (mejor)' : ` (+${e.priors[p].vsBest.diff} ± ${e.priors[p].vsBest.se})`}`).join(', ')}`);
      for (const c of e.cuts) console.log(`  ${c.f * 100}%: z media ${c.z.mean}, desvío ${c.z.sd}; ${PRIORS.map((p) => `${p} → ${c.priors[p].logloss}`).join(', ')}`);
      console.log(`  señales: ${e.levels.map((l) => `nivel ${l.level} ${l.n} (${Math.round(l.share * 100)}% de los cortes), acierta ${l.hit}`).join('; ')}`);
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (espn.blocked) console.error(`ESPN respondió ${espn.blocked} tras 4 intentos; lo bajado quedó en .cache/espn/ y volver a correr reanuda.`);
  if (!Object.keys(fresh).length) return;
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  await writeFile(OUT, `${JSON.stringify({ ...old, live: { ...old.live, ...fresh } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
