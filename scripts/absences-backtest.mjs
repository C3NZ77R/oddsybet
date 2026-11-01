// Bajas en la NBA 2025-26 (ABSENCE en lib/absences.mjs): el modelo de backtest.mjs (calibrado en la primera mitad) con
// mu += beta·(bajas de la visita − del local). Baja = jugador de los game logs de la muestra de live-props-backtest.mjs que
// no aparece en el partido; su valor sale de absentValue con lo jugado antes. beta: mínimos cuadrados del residuo del
// margen en la primera mitad. Las bajas son las reales (en producción, las Out del reporte de lesiones).
// Uso: node scripts/absences-backtest.mjs. Sin red: solo .cache/espn/. Escribe docs/accuracy.json → nba.absences.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPastSeason, getGamelog } from '../lib/espn.mjs';
import { ABSENCE, absentValue } from '../lib/absences.mjs';
import { politeFetch, predict, score, baseline, halves, adjust, fitNormal } from './backtest.mjs';
import { sampleRows } from './live-props-backtest.mjs';

const OUT = new URL('../docs/accuracy.json', import.meta.url);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// apps: [{ pid, team, ev, date, minutes, stats }] de todos los jugadores. Devuelve el valor de las bajas de team en ev.
export function missingOf(apps, results) {
  const byPlayer = new Map(), roster = new Map(), teamDates = new Map(), seen = new Set();
  for (const a of [...apps].sort((x, y) => y.date.localeCompare(x.date))) {
    (byPlayer.get(a.pid) ?? byPlayer.set(a.pid, []).get(a.pid)).push(a); // del más reciente al más viejo
    (roster.get(a.team) ?? roster.set(a.team, new Set()).get(a.team)).add(a.pid);
    seen.add(`${a.ev}|${a.pid}`);
  }
  for (const r of [...results].sort((x, y) => y.date.localeCompare(x.date))) {
    for (const t of [r.homeId, r.awayId]) (teamDates.get(t) ?? teamDates.set(t, []).get(t)).push(r.date);
  }
  return (team, ev, date, cfg) => {
    let v = 0;
    for (const pid of roster.get(team) ?? []) {
      if (seen.has(`${ev}|${pid}`)) continue;
      const played = byPlayer.get(pid).filter((a) => a.date < date);
      if (!played.length || played[0].team !== team) continue; // traspasado: su último partido fue con otro equipo
      v += absentValue(played, teamDates.get(team).filter((d) => d < date), cfg);
    }
    return v;
  };
}

async function main() {
  globalThis.fetch = async () => new Response('{}', { status: 504 });
  const got = await sampleRows(300);
  if (!got) return;
  globalThis.fetch = politeFetch(async () => new Response('{}', { status: 504 }), { dir: fileURLToPath(new URL('../.cache/espn/', import.meta.url)) });
  const [t, p] = [await getPastSeason('nba', 1), await getPastSeason('nba', 2)];
  const results = [...p.results, ...t.results];
  const byEv = new Map(results.map((r) => [r.id, r]));
  const apps = [];
  for (const pid of new Set(got.rows.map((r) => r.player))) {
    const ls = await Promise.all([t.season, t.season - 1].map((s) => getGamelog('nba', pid, s, { athlete: { id: pid } }).then((l) => l.games, () => [])));
    for (const g of new Map(ls.flat().map((x) => [x.eventId, x])).values()) {
      const r = byEv.get(String(g.eventId));
      if (r && g.minutes > 0) apps.push({ pid, team: g.home ? r.homeId : r.awayId, ev: String(g.eventId), date: g.date, minutes: g.minutes, stats: g.stats });
    }
  }
  const cfg = ABSENCE.nba;
  const miss = missingOf(apps, results);
  let preds = predict('basketball', p.results, t.results);
  preds = adjust(preds, fitNormal('basketball', halves(preds)[0]));
  const d = preds.map((x) => { const r = byEv.get(x.id); return miss(r.awayId, x.id, r.date, cfg) - miss(r.homeId, x.id, r.date, cfg); });
  const [cal, hold] = halves(preds.map((x, i) => ({ x, d: d[i] })));
  const beta = cal.reduce((s, { x, d: v }) => s + v * (x.margin - x.model.mu), 0) / cal.reduce((s, { d: v }) => s + v * v, 0);
  const with_ = (rs, b) => rs.map(({ x, d: v }) => ({ ...x, model: { ...x.model, mu: x.model.mu + b * v } }));
  const e = { season: t.season, beta: r4(beta), players: new Set(apps.map((a) => a.pid)).size, n: hold.length,
    brier: r4(score('basketball', with_(hold, cfg.beta)).brier), without: r4(score('basketball', with_(hold, 0)).brier),
    baseline: r4(baseline('basketball', p.results, hold.map((r) => r.x)).brier) };
  console.log(`nba ${e.season}: beta ajustado ${e.beta} (lib/absences.mjs tiene ${cfg.beta}); mitad de prueba ${e.n} partidos, Brier ${e.without} → ${e.brier} con bajas (referencia ${e.baseline})`);
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  await writeFile(OUT, `${JSON.stringify({ ...old, nba: { ...old.nba, absences: e } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
