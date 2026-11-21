// Lecturas de cuotas de Betano en Supabase (tabla betano_read): el script lector las manda a /api/betano/ingest y el
// servidor las carga con loadReads, en la misma forma { games } que gameFor (public/betano.js) ya sabe leer.
import { gamesOf } from '../public/betano.js';
import { httpError } from './espn.mjs';

const MAX_BYTES = 1 << 20;
const HOUR = 3600 * 1000;
const BACK = 12 * HOUR, AHEAD = 7 * 24 * HOUR; // ventana de inicio: de hace 12 h a dentro de 7 días
const MEMO_MS = 5 * 60 * 1000;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
let memo = null; // { at, value }
// JSON con las claves ordenadas: Postgres devuelve el jsonb con otro orden y un JSON.stringify directo nunca coincidiría.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// events: lo que arma grab. Entrada no confiable: tope de 1 MB, lo que gamesOf valida y solo partidos de la ventana.
export async function ingest(db, events, { now = Date.now() } = {}) {
  let games;
  try {
    if (JSON.stringify(events ?? null).length > MAX_BYTES) throw httpError(413, 'La lectura es muy pesada');
    games = gamesOf(events);
  } catch (err) {
    throw err.status ? err : httpError(400, 'Lectura inválida'); // gamesOf lanza con mercados que no son pares
  }
  const rows = new Map(); // por clave: PostgREST rechaza un upsert con la misma clave dos veces
  for (const g of games) {
    const [team1, team2] = g.teams;
    if (!norm(team1) || !norm(team2) || !(g.t > now - BACK && g.t < now + AHEAD)) continue;
    const key = `${g.t}|${norm(team1)}|${norm(team2)}`;
    rows.set(key, { key, startAt: new Date(g.t).toISOString(), team1, team2, game: g, readAt: new Date(now).toISOString() });
  }
  // Historial (betano_history): una fila cada vez que cambian las cuotas de un partido que no empezó, con la hora desde
  // la que rigen. Se compara con la lectura guardada antes de pisarla. Si falla, la lectura de hoy se guarda igual.
  const pre = [...rows.values()].filter((r) => Date.parse(r.startAt) > now);
  const before = pre.length ? await db.betanoReadGames(pre.map((r) => r.key)).catch((err) => console.error('betano: sin lectura previa para el historial:', err.message)) : null;
  if (rows.size) await db.saveBetanoReads([...rows.values()]);
  if (before) {
    const old = new Map(before.map((r) => [r.key, canon(r.game)]));
    const changed = pre.filter((r) => old.get(r.key) !== canon(r.game)).map(({ key, startAt, game, readAt }) => ({ key, startAt, game, readAt }));
    if (changed.length) await db.saveBetanoHistory(changed).catch((err) => console.error('betano: no se guardó el historial:', err.message));
  }
  memo = null;
  return { saved: rows.size };
}

// { games: [{ ...game, at: ms de la lectura }] } de la ventana. Memo de 5 minutos; si la base falla, vacío y sin memo.
export async function loadReads(db, { now = Date.now() } = {}) {
  if (memo && now >= memo.at && now - memo.at < MEMO_MS) return memo.value;
  try {
    const rows = await db.betanoReads(new Date(now - BACK).toISOString(), new Date(now + AHEAD).toISOString());
    const value = { games: rows.map((r) => ({ ...r.game, at: Date.parse(r.readAt) })) };
    memo = { at: now, value };
    return value;
  } catch (err) {
    console.error('betano: no se cargaron las lecturas:', err.message);
    return { games: [] };
  }
}
