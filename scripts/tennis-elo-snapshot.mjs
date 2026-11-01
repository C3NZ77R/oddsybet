// Genera data/atp-elo.json: partidos ATP de singles terminados desde 2018 hasta hace dos meses, en forma compacta y solo con
// lo que usa el Elo, [fecha, superficie, id A, id B, ganador 'a'|'b', sets "6-4 7-6", retiro 0|1]. Se solapa con
// data/atp-history.json (24 meses, completo); getEloHistory deduplica por id. Uso: node scripts/tennis-elo-snapshot.mjs
// shortcut: se refresca a mano; los meses nuevos los cubren atp-history.json y getHistory en vivo.
import { writeFileSync } from 'node:fs';
import { getMonth, uniqueById, finished } from '../lib/tennis.mjs';

const FROM = Date.UTC(2018, 0, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = new Date();
const all = [];
for (let d = new Date(FROM); d < Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1); d.setUTCMonth(d.getUTCMonth() + 1)) {
  const yyyymm = d.toISOString().slice(0, 7).replace('-', '');
  for (let k = 1; ; k++) {
    try {
      const ms = await getMonth(yyyymm);
      console.log(yyyymm, ms.length);
      all.push(...ms);
      break;
    } catch (err) {
      if (k === 4) throw err;
      await sleep(5000 * 2 ** k);
    }
  }
  await sleep(300); // un mes crudo pesa ~4 MB: sin ráfagas
}
const S = { hard: 'h', clay: 'c', grass: 'g' };
const rows = finished(uniqueById(all)).map((m) => [m.id, m.date, S[m.surface], m.a.id, m.b.id, m.winner, m.sets.map((s) => `${s[0]}-${s[1]}`).join(' '), m.retired ? 1 : 0]);
writeFileSync(new URL('../data/atp-elo.json', import.meta.url), `${JSON.stringify({ at: now.toISOString(), rows })}\n`);
console.log('partidos', rows.length);
