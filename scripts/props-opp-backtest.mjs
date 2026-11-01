// Factor del rival en los props de la NBA 2025-26 (OPP en lib/props.mjs): por cada partido de la temporada de los jugadores
// de la muestra de scripts/live-props-backtest.mjs, la P(Más) de propLine contra la misma con la media escalada por lo que
// el rival permitió antes de ese día (oppEvents de todos los game logs). Log-loss pareado por partido en cada mitad de la
// temporada. Uso: node scripts/props-opp-backtest.mjs. Sin red: solo .cache/espn/. Escribe docs/accuracy.json → props.nba.opp.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getGamelog } from '../lib/espn.mjs';
import { propLine, NORMAL, OPP, oppEvents, oppFactor, withOpp } from '../lib/props.mjs';
import { sampleRows } from './live-props-backtest.mjs';

const OUT = new URL('../docs/accuracy.json', import.meta.url);
const EPS = 1e-12;
const loss = (p, won) => -Math.log(Math.max(won ? p : 1 - p, EPS));
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Filas { game, date, kind, r (propLine), m20, tot (lo del rival hasta el día anterior), final, won } en orden de fecha.
export function oppRows(logs, season, cfg) {
  const events = [...logs.values()].flatMap((gs) => oppEvents(gs, cfg.stats)).sort((a, b) => a.date.localeCompare(b.date));
  const plays = [...logs.values()].flatMap((gs) => {
    const played = gs.filter((g) => g.minutes > 0); // del más reciente al más viejo
    return played.map((g, i) => ({ g, before: played.slice(i + 1) })).filter(({ g }) => g.season === season);
  }).sort((a, b) => a.g.date.localeCompare(b.g.date));
  const acc = {};
  const rows = [];
  let k = 0;
  for (const { g, before } of plays) {
    const day = g.date.slice(0, 10);
    for (; k < events.length && events[k].date.slice(0, 10) < day; k++) {
      const x = events[k], o = ((acc[x.opp] ??= {})[x.stat] ??= { v: 0, e: 0 });
      o.v += x.v;
      o.e += x.e;
    }
    if (avg(before.slice(0, 10).map((x) => x.minutes ?? 0)) < 20) continue; // titulares y rotación, como logRows
    for (const s of cfg.stats) {
      const values = before.map((x) => x.stats[s]).filter((v) => v != null), final = g.stats[s], kind = NORMAL.has(s) ? 'normal' : 'count';
      const r = final != null && values.some((v) => v > 0) && propLine(values, kind);
      if (!r || r.pOver < 0.03 || r.pOver > 0.97) continue;
      const tot = acc[String(g.opp?.id)]?.[s] ? { ...acc[String(g.opp.id)][s] } : null;
      rows.push({ game: g.eventId, date: g.date, kind, r, m20: avg(values.slice(0, 20)), tot, final, won: final > r.line });
    }
  }
  return rows;
}

export const pWith = (row, cfg) => withOpp(row.r, row.kind, oppFactor(row.tot, row.m20, cfg)).pOver;

// Log-loss con el factor menos sin él, promedio por partido, con su error estándar. Negativo: el factor mejora.
export function paired(rows, cfg) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.game) ?? by.set(r.game, { s: 0, n: 0 }).get(r.game);
    g.s += loss(pWith(r, cfg), r.won) - loss(r.r.pOver, r.won);
    g.n++;
  }
  const d = [...by.values()].map((g) => g.s / g.n), m = avg(d);
  return { games: d.length, n: rows.length, diff: r4(m), se: r4(Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1) / d.length)) };
}

async function main() {
  globalThis.fetch = async () => new Response('{}', { status: 504 }); // sin red
  const got = await sampleRows(300);
  if (!got) return;
  const logs = new Map();
  for (const pid of new Set(got.rows.map((r) => r.player))) {
    const ls = await Promise.all([got.season, got.season - 1].map((s) => getGamelog('nba', pid, s, { athlete: { id: pid } }).then((l) => l.games, () => [])));
    logs.set(pid, [...new Map(ls.flat().map((g) => [g.eventId, g])).values()].sort((a, b) => b.date.localeCompare(a.date)));
  }
  const cfg = OPP.nba;
  const rows = oppRows(logs, got.season, cfg);
  const h = rows.length >> 1;
  const e = { season: got.season, players: logs.size, w: cfg.w, k: cfg.k, stats: cfg.stats, calibration: paired(rows.slice(0, h), cfg), test: paired(rows.slice(h), cfg) };
  console.log(`nba ${e.season}: ${e.players} jugadores, ${rows.length} líneas. Log-loss con rival − sin rival: calibración ${e.calibration.diff} ± ${e.calibration.se}, prueba ${e.test.diff} ± ${e.test.se}`);
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  await writeFile(OUT, `${JSON.stringify({ ...old, props: { ...old.props, nba: { ...old.props?.nba, opp: e } } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
