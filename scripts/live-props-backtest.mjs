// Backtest de PRIOR.player (public/live.js): cuántos partidos pesa el promedio previo de un jugador frente a su ritmo de
// hoy. NBA 2025-26, porque sus jugadas del summary traen el atleta. En una muestra pareja de
// la temporada reconstruye los puntos, rebotes y asistencias de cada jugador al final del 1.º, 2.º y 3.er cuarto; su línea
// previa sale de propLine con el game log anterior al partido (sin fuga), elegidos como getProps (los 8 de cada equipo
// con más minutos). Para cada peso calcula P(Más) como propSignals (remaining + liveOver con la curva de los jugadores,
// playerShare) y mide log-loss, Brier, calibración y la comparación pareada por partido. La curva se mide sin fuga: cada
// mitad de la temporada usa la de la otra mitad; también se compara contra el ritmo lineal. Escribe docs/accuracy.json →
// live.nbaProps.
// Uso: node scripts/live-props-backtest.mjs [partidos=300]. Todo queda en .cache/espn/ vía politeFetch (~0.4 MB por summary).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boxPlayers, getGamelog, getPastSeason } from '../lib/espn.mjs';
import { propLine, MIN_GAMES, PER_TEAM, NORMAL, activity } from '../lib/props.mjs';
import { remaining, liveOver, paceZ, strength, playerShare } from '../public/live.js';
import { politeFetch } from './backtest.mjs';
import { calibration, CUTS } from './live-backtest.mjs';

export const PRIORS = [0.5, 1, 2, 3, 5, 8, 13, 20];
const STATS = Object.fromEntries(['pts', 'reb', 'ast'].map((k) => [k, NORMAL.has(k) ? 'normal' : 'count'])); // kind como playerProps
const EPS = 1e-12;
const OUT = new URL('../docs/accuracy.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=';
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const mean = (xs) => sum(xs) / xs.length;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const loss = (p, won) => -Math.log(Math.max(won ? p : 1 - p, EPS));

// Puntos, rebotes y asistencias por atleta: [al final de cada cuarto de CUTS..., final con prórroga], según las jugadas.
// El anotador es participants[0]; el asistente, participants[1] si el texto dice "assists". Rebote de equipo: sin atleta.
export function cumulative(plays) {
  const out = new Map();
  const add = (id, stat, v, q) => {
    if (!out.has(id)) out.set(id, Object.fromEntries(Object.keys(STATS).map((k) => [k, Array(CUTS.length + 1).fill(0)])));
    out.get(id)[stat].forEach((_, i, a) => { if (i === CUTS.length || q <= CUTS[i]) a[i] += v; });
  };
  for (const p of plays ?? []) {
    const q = Number(p.period?.number), [a, b] = (p.participants ?? []).map((x) => x.athlete?.id);
    if (!a || !(q > 0)) continue;
    if (p.scoringPlay && p.scoreValue > 0) {
      add(a, 'pts', p.scoreValue, q);
      if (b && /assists/i.test(p.text ?? '')) add(b, 'ast', 1, q);
    } else if (/rebound/i.test(p.type?.text ?? '')) add(a, 'reb', 1, q);
  }
  return out;
}

// Filas de un partido. box = boxPlayers del summary; cum = cumulative(plays); logs = Map id → partidos del game log.
// Solo cuentan los partidos del log anteriores al inicio; un jugador que no jugó anula la apuesta y no entra.
export function propRows({ id, date }, box, cum, logs) {
  const rows = [];
  let mismatch = 0;
  const before = (pid) => (logs.get(pid) ?? []).filter((g) => g.date < date && g.eventId !== id).sort((a, b) => b.date.localeCompare(a.date));
  for (const team of new Set(box.map((p) => p.teamId))) {
    const top = box.filter((p) => p.teamId === team).map((p) => ({ p, games: before(p.id) })).filter((x) => x.games.length >= MIN_GAMES)
      .sort((a, b) => activity(b) - activity(a)).slice(0, PER_TEAM);
    for (const { p, games } of top) {
      if (!(p.stats.min > 0)) continue;
      for (const [stat, kind] of Object.entries(STATS)) {
        const values = games.map((g) => g.stats[stat]).filter((v) => v != null);
        const r = values.some((v) => v > 0) && propLine(values, kind);
        if (!r || r.pOver < 0.03 || r.pOver > 0.97) continue; // como playerProps
        const c = cum.get(p.id)?.[stat] ?? Array(CUTS.length + 1).fill(0);
        if (c.at(-1) !== p.stats[stat]) { // las jugadas no cuadran con el boxscore
          mismatch++;
          continue;
        }
        CUTS.forEach((k, i) => rows.push({ game: id, player: p.id, stat, kind, f: k / 4, current: c[i], line: r.line, mean: r.mean, variance: r.variance, won: c.at(-1) > r.line, values, final: c.at(-1) }));
      }
    }
  }
  return { rows, mismatch };
}

// P(Más) que muestra propSignals con el peso prior; r.w (parte esperada a esta altura) reemplaza la curva de public/live.js.
export const overAt = (r, prior) => liveOver(r.kind, r.current, remaining({ current: r.current, progress: r.w ?? playerShare('basketball', r.f), mean: r.mean, variance: r.variance, prior }), r.line);

// Parte del total del jugador que llevan las filas al terminar cada cuarto de CUTS (como PLAYER_CURVE de public/live.js).
export const shares = (rows) => CUTS.map((k) => {
  const at = rows.filter((r) => r.f === k / 4);
  return sum(at.map((r) => r.current)) / sum(at.map((r) => r.final));
});

// Log-loss de a menos b, promedio por partido, con el error estándar entre partidos (las filas de un partido no son
// independientes). a y b: pesos del previo, o funciones fila → P(Más).
export function paired(rows, a, b) {
  const at = (x) => (typeof x === 'function' ? x : (r) => overAt(r, x));
  const [pa, pb] = [at(a), at(b)];
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.game) ?? by.set(r.game, { s: 0, n: 0 }).get(r.game);
    g.s += loss(pa(r), r.won) - loss(pb(r), r.won);
    g.n++;
  }
  const d = [...by.values()].map((g) => g.s / g.n), m = mean(d);
  return { diff: m, se: Math.sqrt(sum(d.map((x) => (x - m) ** 2)) / (d.length - 1) / d.length) };
}

function compare(rows) {
  const all = Object.fromEntries(PRIORS.map((p) => [p, calibration(rows.map((r) => ({ p: overAt(r, p), won: r.won })))]));
  const best = PRIORS.reduce((a, b) => (all[b].logloss < all[a].logloss ? b : a)); // empate = el menor
  return { n: rows.length, best, bins: all[best].bins,
    priors: Object.fromEntries(PRIORS.map((p) => [p, { brier: all[p].brier, logloss: all[p].logloss, ...(p !== best && { vsBest: paired(rows, p, best) }) }])) };
}

// Sin fuga: las filas de cada mitad de la temporada (en orden de partido) llevan la curva medida en la otra mitad.
export function crossFit(rows) {
  const ids = [...new Set(rows.map((r) => r.game))], first = new Set(ids.slice(0, ids.length / 2));
  const halves = [rows.filter((r) => first.has(r.game)), rows.filter((r) => !first.has(r.game))], fit = halves.map(shares);
  return { fit, rows: halves.flatMap((rs, h) => rs.map((r) => ({ ...r, w: fit[1 - h][CUTS.indexOf(r.f * 4)] }))) };
}

export function entry(season, games, all, skipped) {
  const { fit, rows } = crossFit(all);
  const ll = (rs) => Object.fromEntries(PRIORS.map((p) => [p, calibration(rs.map((r) => ({ p: overAt(r, p), won: r.won }))).logloss]));
  // Donde la vista muestra una señal (|z| ≥ 1): ahí se lee la P(Más).
  const signals = rows.filter((r) => strength(paceZ({ current: r.current, progress: r.w, mean: r.mean, variance: r.variance })));
  const linear = rows.map((r) => ({ ...r, w: r.f })), cmp = compare(rows);
  return { season, games, skipped, over: mean(rows.map((r) => r.won)), ...cmp,
    curve: { all: shares(all), halves: fit, linear: { ...ll(linear), vsCurve: paired(rows, (r) => overAt({ ...r, w: r.f }, cmp.best), cmp.best) } },
    cuts: CUTS.map((k) => ({ f: k / 4, logloss: ll(rows.filter((r) => r.f === k / 4)) })),
    stats: Object.fromEntries(Object.keys(STATS).map((s) => [s, ll(rows.filter((r) => r.stat === s))])),
    signals: (({ n, best, priors }) => ({ n, best, priors }))(compare(signals)) };
}

// Muestra pareja de n partidos de la temporada pasada y sus filas (con values, el game log previo, y final, el total del
// jugador); null si ESPN cortó. scripts/props-backtest.mjs la reusa sin red.
export async function sampleRows(n) {
  await mkdir(CACHE, { recursive: true });
  const polite = politeFetch(globalThis.fetch, { dir: CACHE });
  // Un summary de 0.4 MB a veces pasa los 8 s de politeFetch: tres intentos antes de cortar (volver a correr reanuda).
  const espn = async (url, init) => {
    for (let k = 1; ; k++) {
      try {
        return await polite(url, init);
      } catch (err) {
        if (k === 3) throw err;
      }
    }
  };
  globalThis.fetch = espn; // lib/espn.mjs pide con el fetch global
  const { season, results } = await getPastSeason('nba', 1);
  const all = [...results].sort((a, b) => a.date.localeCompare(b.date));
  const step = Math.max(1, Math.floor(all.length / Number(n)));
  const sample = all.filter((_, i) => i % step === 0);
  // Game log de la temporada y la anterior, como getGamelog sin season en producción. Un pedido caído = jugador sin log.
  const memo = new Map();
  const logOf = (pid) => {
    if (!memo.has(pid)) memo.set(pid, Promise.all([season, season - 1].map((s) => getGamelog('nba', pid, s, { athlete: { id: pid } }).then((l) => l.games, () => [])))
      .then((ls) => [...new Map(ls.flat().map((g) => [g.eventId, g])).values()]));
    return memo.get(pid);
  };
  const rows = [], skipped = { noPlays: 0, mismatch: 0 };
  for (const [i, g] of sample.entries()) {
    if (polite.blocked) break;
    const res = await espn(`${SUMMARY}${g.id}`);
    const json = res.ok ? await res.json() : null;
    if (!json?.plays?.length) {
      skipped.noPlays++;
      continue;
    }
    const box = boxPlayers(json, 'basketball');
    const logs = new Map(await Promise.all(box.map(async (p) => [p.id, await logOf(p.id)])));
    const got = propRows(g, box, cumulative(json.plays), logs);
    rows.push(...got.rows);
    skipped.mismatch += got.mismatch;
    if ((i + 1) % 25 === 0) console.log(`${i + 1}/${sample.length} partidos, ${rows.length} filas`);
  }
  if (polite.blocked) {
    console.error(`ESPN respondió ${polite.blocked} tras 4 intentos; lo bajado quedó en .cache/espn/ y volver a correr reanuda.`);
    process.exitCode = 1;
    return null;
  }
  return { season, games: sample.length - skipped.noPlays, rows, skipped };
}

async function main([n = '300']) {
  const got = await sampleRows(Number(n));
  if (!got) return;
  const { season, games, rows, skipped } = got;
  const e = JSON.parse(JSON.stringify(entry(season, games, rows, skipped), (k, v) => (typeof v === 'number' ? r4(v) : v)));
  console.log(`nba ${season}: ${e.games} partidos, ${e.n} filas (jugador × estadística × corte), Más en el ${e.over}; sin jugadas ${skipped.noPlays}, `
    + `no cuadran con el boxscore ${skipped.mismatch}. Log-loss por peso (diferencia con el mejor ± error): `
    + PRIORS.map((p) => `${p} → ${e.priors[p].logloss}${p === e.best ? ' (mejor)' : ` (+${e.priors[p].vsBest.diff} ± ${e.priors[p].vsBest.se})`}`).join(', '));
  console.log(`  curva de los jugadores (toda la temporada → PLAYER_CURVE): ${e.curve.all.join('/')}; por mitad ${e.curve.halves.map((c) => c.join('/')).join(' y ')}. `
    + `Lineal: ${PRIORS.map((p) => `${p} → ${e.curve.linear[p]}`).join(', ')}; lineal − curva con ${e.best}: ${e.curve.linear.vsCurve.diff} ± ${e.curve.linear.vsCurve.se}`);
  for (const c of e.cuts) console.log(`  ${c.f * 100}%: ${PRIORS.map((p) => `${p} → ${c.logloss[p]}`).join(', ')}`);
  for (const [s, l] of Object.entries(e.stats)) console.log(`  ${s}: ${PRIORS.map((p) => `${p} → ${l[p]}`).join(', ')}`);
  console.log(`  con señal (${e.signals.n} filas): ${PRIORS.map((p) => `${p} → ${e.signals.priors[p].logloss}${p === e.signals.best ? ' (mejor)' : ` (+${e.signals.priors[p].vsBest.diff} ± ${e.signals.priors[p].vsBest.se})`}`).join(', ')}`);
  const old = JSON.parse(await readFile(OUT, 'utf8')); // releer justo antes: otros scripts escriben el mismo archivo
  await writeFile(OUT, `${JSON.stringify({ ...old, live: { ...old.live, nbaProps: e } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
