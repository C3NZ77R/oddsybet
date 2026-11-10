// Actualiza data/challenger-elo.json: las filas que ya tiene más los partidos de singles terminados de LiveScore
// (Challenger y circuito ATP, para que el Elo de los dos quede en la misma escala) desde una semana antes de su último
// partido (por si LiveScore completó tarde algún día) hasta ayer. Nunca borra: LiveScore guarda ~1 año y lo más viejo
// solo vive aquí. Filas compactas de atp-elo.json más el torneo y el circuito. Sin archivo, empieza en FROM.
// Uso: node scripts/challenger-snapshot.mjs (lo corre .github/workflows/challenger.yml cada lunes). Cada día queda en
// .cache/espn/: una corrida cortada reanuda.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDay } from '../lib/challenger.mjs';
import { finished, uniqueById } from '../lib/tennis.mjs';
import { politeFetch } from './backtest.mjs';

const OUT = new URL('../data/challenger-elo.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));
const FROM = Date.UTC(2025, 9, 1);
const DAY = 86_400_000;
const S = { hard: 'h', clay: 'c', grass: 'g' };
const bogota = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).replaceAll('-', '');

// Une las filas viejas con las nuevas por id (gana la nueva) y las ordena por fecha.
export const mergeRows = (old, fresh) => [...new Map([...old, ...fresh].map((r) => [r[0], r])).values()].sort((a, b) => a[1].localeCompare(b[1]));

async function main() {
  let old = [];
  try {
    old = JSON.parse(readFileSync(OUT, 'utf8')).rows;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // un archivo roto no se pisa: se arregla a mano
  }
  const last = old.reduce((m, r) => (r[1] > m ? r[1] : m), '');
  mkdirSync(CACHE, { recursive: true });
  globalThis.fetch = politeFetch(globalThis.fetch, { dir: CACHE });
  const all = [];
  let failed = 0;
  const now = Date.now();
  for (let t = last ? Date.parse(last) - 7 * DAY : FROM; bogota(t) <= bogota(now - DAY); t += DAY) {
    try {
      all.push(...(await getDay(bogota(t))));
    } catch (err) {
      failed++;
      console.error(bogota(t), err.message);
    }
  }
  if (failed > 3) throw new Error(`${failed} días fallaron: no se escribe nada`); // LiveScore caído: mejor nada que huecos
  const fresh = finished(uniqueById(all)).map((m) => [m.id, m.date, S[m.surface], m.a.id, m.b.id, m.winner, m.sets.map((s) => `${s[0]}-${s[1]}`).join(' '), m.retired ? 1 : 0, m.tournament, m.level[0]]);
  const rows = mergeRows(old, fresh);
  writeFileSync(OUT, `${JSON.stringify({ at: new Date(now).toISOString(), rows })}\n`);
  console.log(`partidos ${rows.length} (${rows.length - old.length} nuevos), challenger ${rows.filter((r) => r[9] === 'c').length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
