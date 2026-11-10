// Genera data/challenger-elo.json: partidos de singles terminados de LiveScore (Challenger y circuito ATP, para que el
// Elo de los dos quede en la misma escala) desde FROM hasta hace LIVE_DAYS días, en las filas compactas de
// atp-elo.json más el torneo y el circuito. LiveScore guarda más o menos un año y con huecos (algunos días traen solo parte de los partidos).
// Uso: node scripts/challenger-snapshot.mjs. Cada día queda en .cache/espn/: una corrida cortada reanuda.
// shortcut: se refresca a mano; los días nuevos los cubre getChallengerHistory en vivo (LIVE_DAYS).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDay, LIVE_DAYS } from '../lib/challenger.mjs';
import { finished, uniqueById } from '../lib/tennis.mjs';
import { politeFetch } from './backtest.mjs';

const FROM = Date.UTC(2025, 9, 1);
const DAY = 86_400_000;
globalThis.fetch = politeFetch(globalThis.fetch, { dir: fileURLToPath(new URL('../.cache/espn/', import.meta.url)) });
const all = [];
const now = Date.now();
for (let t = FROM; t < now - LIVE_DAYS * DAY; t += DAY) {
  const d = new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
  try {
    const ms = await getDay(d);
    all.push(...ms);
    if (d.endsWith('01')) console.log(d, ms.length);
  } catch (err) {
    console.error(d, err.message);
  }
}
const S = { hard: 'h', clay: 'c', grass: 'g' };
const done = finished(uniqueById(all));
// Más que atp-elo.json: el torneo (largo del set) y el circuito ('c' Challenger, 'a' ATP; el backtest mide solo 'c').
const rows = done.map((m) => [m.id, m.date, S[m.surface], m.a.id, m.b.id, m.winner, m.sets.map((s) => `${s[0]}-${s[1]}`).join(' '), m.retired ? 1 : 0, m.tournament, m.level[0]]);
writeFileSync(new URL('../data/challenger-elo.json', import.meta.url), `${JSON.stringify({ at: new Date(now).toISOString(), rows })}\n`);
console.log('partidos', rows.length, 'challenger', done.filter((m) => m.level === 'challenger').length);
