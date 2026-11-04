// Backtest de goles en el primer tiempo (fútbol) en la última temporada completa de cada liga. Previa: P(Más de 0.5 y
// 1.5) con scoreGrid y las medias del partido (modelo sin fuga de scripts/backtest.mjs) escaladas por share, la parte
// de los goles que cae antes del descanso. En vivo: con 0-0 en el minuto t, P(gol antes del descanso) =
// 1 − e^(−λ1·q_t), con q_t la parte de los goles del primer tiempo que llegan después de t. La temporada se parte por
// fecha como en backtest.mjs: en la primera mitad se miden share, q_t y la frecuencia de cada apuesta (la referencia);
// en la segunda se compara el modelo con esa frecuencia. Los goles salen de details del scoreboard de cada día, con su
// minuto ("45'+2'" es del primer tiempo). Uso: node scripts/firsthalf-backtest.mjs [liga…] (sin ligas: las de
// fútbol). Imprime; no escribe docs/accuracy.json. Todo queda en .cache/espn/ vía politeFetch.
// Corrida 2026-11 (temporada 2025 de las 5 ligas): en ningún caso el modelo le gana a la frecuencia de la liga por más
// de 1.5 errores estándar, así que el mercado de primer tiempo no se publica.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES as ALL, leagueById } from '../public/leagues.js';
import { getPastSeason, mapLimit } from '../lib/espn.mjs';
import { scoreGrid } from '../lib/pricing.mjs';
import { politeFetch, predict, halves } from './backtest.mjs';
import { calibration, etDay } from './live-backtest.mjs';

export const LINES = [0.5, 1.5];
export const LIVE = [7, 15]; // minuto de entrada con 0-0: el video entra del 5 al 7, o espera al 15
const LEAGUES = ALL.filter((l) => l.sport === 'soccer').map((l) => l.id);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const mean = (xs) => sum(xs) / xs.length;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// Minuto de cada gol del partido; null si el scoreboard no lo trajo o sus goles no suman el marcador final.
export function goalMinutes(comp, total) {
  if (!comp) return null;
  const ms = (comp.details ?? []).filter((d) => d.scoringPlay && !d.shootout).map((d) => parseInt(d.clock?.displayValue, 10));
  return ms.length === total && ms.every(Number.isFinite) ? ms : null;
}

// P(más de line goles en el primer tiempo).
export function pOver(lh, la, share, line) {
  return sum(scoreGrid(lh * share, la * share).flatMap((row, i) => row.filter((_, j) => i + j > line)));
}

// rows: { lh, la, mins } en orden de fecha.
export function evaluate(rows) {
  const [cal, hold] = halves(rows);
  const first = (r) => r.mins.filter((m) => m <= 45);
  const share = sum(cal.map((r) => first(r).length)) / sum(cal.map((r) => r.mins.length));
  const versus = (rs, p, freq, won) => {
    const m = calibration(rs.map((r) => ({ p: p(r), won: won(r) })));
    const b = calibration(rs.map((r) => ({ p: freq, won: won(r) })));
    // Diferencia de Brier por partido (modelo − frecuencia) y su error estándar: ganar por menos de ~2 se es ruido.
    const d = rs.map((r) => (p(r) - won(r)) ** 2 - (freq - won(r)) ** 2);
    const se = Math.sqrt(sum(d.map((x) => (x - mean(d)) ** 2)) / (d.length - 1) / d.length);
    return { n: m.n, freq, hit: mean(rs.map(won)), brier: m.brier, logloss: m.logloss, base: { brier: b.brier, logloss: b.logloss }, se, bins: m.bins };
  };
  const pre = LINES.map((line) => {
    const won = (r) => first(r).length > line;
    return { line, ...versus(hold, (r) => pOver(r.lh, r.la, share, line), mean(cal.map(won)), won) };
  });
  const live = LIVE.map((t) => {
    const after = (r) => first(r).filter((m) => m > t).length;
    const q = sum(cal.map(after)) / sum(cal.map((r) => first(r).length));
    const open = (rs) => rs.filter((r) => r.mins.every((m) => m > t)); // 0-0 al llegar al minuto t
    const won = (r) => after(r) > 0;
    return { t, q, ...versus(open(hold), (r) => 1 - Math.exp(-(r.lh + r.la) * share * q), mean(open(cal).map(won)), won) };
  });
  return { share, pre, live };
}

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
  for (const pr of predict(sport, prev.results, test.results)) {
    const mins = goalMinutes(comps.get(pr.id), pr.points);
    if (mins) rows.push({ lh: pr.model.lh, la: pr.model.la, mins });
  }
  return { season: test.season, games: test.results.length, rows };
}

const said = (bins, from) => {
  const bs = bins.filter((b) => b.from >= from);
  const n = sum(bs.map((b) => b.n));
  return n ? `con p ≥ ${from}%: ${n}, dijo ${pct(sum(bs.map((b) => b.said * b.n)) / n)}, salió ${pct(sum(bs.map((b) => b.hit * b.n)) / n)}` : `ninguno con p ≥ ${from}%`;
};
const verdict = (e) => `Brier ${r4(e.brier)} (frecuencia ${r4(e.base.brier)}), log-loss ${r4(e.logloss)} (frecuencia ${r4(e.base.logloss)})`
  + `, diferencia ${r4(e.brier - e.base.brier)} ± ${r4(e.se)} → ${e.brier < e.base.brier ? 'le gana' : 'NO le gana'}`;

async function main(args) {
  const ids = args.length ? args : LEAGUES;
  const bad = ids.filter((id) => !LEAGUES.includes(id));
  if (bad.length) {
    console.error(`Sin backtest de primer tiempo: ${bad.join(', ')}. Ligas válidas: ${LEAGUES.join(' ')}`);
    process.exitCode = 2;
    return;
  }
  await mkdir(CACHE, { recursive: true });
  const espn = politeFetch(globalThis.fetch, { dir: CACHE });
  globalThis.fetch = espn; // lib/espn.mjs pide con el fetch global
  for (const id of ids) {
    try {
      const { season, games, rows } = await rowsOf(id);
      const e = evaluate(rows);
      console.log(`${id} ${season}: ${rows.length} de ${games} partidos con goles por minuto; ${pct(e.share)} de los goles antes del descanso`);
      for (const p of e.pre) console.log(`  previa Más de ${p.line} (${p.n} de prueba, salió ${pct(p.hit)}): ${verdict(p)}; ${said(p.bins, 80)}`);
      for (const l of e.live) {
        console.log(`  0-0 al ${l.t}' (${l.n} de prueba, gol antes del descanso ${pct(l.hit)}, cuota justa ${(1 / l.hit).toFixed(2)}): ${verdict(l)}; ${said(l.bins, 70)}`);
      }
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (espn.blocked) console.error(`ESPN respondió ${espn.blocked} tras 4 intentos; lo bajado quedó en .cache/espn/ y volver a correr reanuda.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
