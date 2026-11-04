// Cliente del API de server.mjs. Cada función devuelve el cuerpo completo { source, data, remaining? }.
// Caché en memoria de 60 s por URL y deduplicación de peticiones simultáneas.
const TTL = 60_000;
const TIMEOUT = 15_000; // sin límite, una petición colgada dejaba «Cargando…» para siempre
const MAX = 200; // un lote de /api/gamelogs pesa ~2 MB: en sessionStorage llenaba la cuota y dejaba de cachear
const cache = new Map(); // url -> { at, body }, de la más vieja a la más nueva
const inflight = new Map();
export const SLOW = 'El servidor tardó demasiado en responder. Revisa tu conexión e intenta de nuevo.';

const param = (v) => (v && typeof v === 'object' ? v.id ?? String(v) : v); // acepta ctx.league (objeto) o 'nba'

export async function get(path, params = {}, { fresh = false } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, param(v));
  const s = String(qs); // sin qs.size: Safari ≤16 y Chrome <113 no lo tienen
  const url = s ? `${path}?${s}` : path;
  if (!fresh) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL) return hit.body;
    cache.delete(url); // vencida
    if (inflight.has(url)) return inflight.get(url);
  }
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let res, body;
    try {
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch {
        throw new Error(ctrl.signal.aborted ? SLOW : 'No se pudo conectar con el servidor. Revisa tu conexión.');
      }
      try {
        body = await res.json();
      } catch {
        if (ctrl.signal.aborted) throw new Error(SLOW);
        throw Object.assign(new Error(`Respuesta inválida del servidor (${res.status}).`), { status: res.status });
      }
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw Object.assign(new Error(body?.error || `El servidor respondió ${res.status}.`), { status: res.status });
    cache.delete(url); // al final del Map: se saca primero la más vieja
    cache.set(url, { at: Date.now(), body });
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
    return body;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

// Game logs pedidos en el mismo instante viajan juntos en /api/gamelogs (máx. 40 por petición): insights pedía ~50
// por separado. Con temporada explícita va al endpoint de uno.
const BATCH = 40;
const queued = new Map(); // liga -> Map(id -> { promise, resolve, reject })
function gamelog(league, athleteId, season) {
  if (season) return get('/api/gamelog', { league, athlete: athleteId, season });
  const lg = param(league), id = String(athleteId);
  if (!queued.has(lg)) {
    queued.set(lg, new Map());
    setTimeout(() => flush(lg), 0);
  }
  const q = queued.get(lg);
  if (!q.has(id)) {
    const w = {};
    w.promise = new Promise((resolve, reject) => Object.assign(w, { resolve, reject }));
    q.set(id, w);
  }
  return q.get(id).promise;
}
function flush(lg) {
  const q = queued.get(lg);
  queued.delete(lg);
  const ids = [...q.keys()];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    get('/api/gamelogs', { league: lg, ids: chunk.join(',') }).then(
      (body) => chunk.forEach((id) => (body.data?.[id] ? q.get(id).resolve({ source: body.source, data: body.data[id] }) : q.get(id).reject(new Error('ESPN no devolvió el game log de este jugador.')))),
      (err) => chunk.forEach((id) => q.get(id).reject(err)),
    );
  }
}

export const api = {
  get,
  leagues: () => get('/api/leagues'),
  markets: (league, gameId, date) => get('/api/markets', { league, game: gameId, date }),
  accuracy: () => get('/api/accuracy'),
  games: (league, date) => get('/api/games', { league, date }),
  game: (league, id) => get('/api/game', { league, id }),
  gamelog,
  props: (league, gameId) => get('/api/props', { league, game: gameId }),
  injuries: (league) => get('/api/injuries', { league }),
  roster: (league, team) => get('/api/roster', { league, team }),
  search: (league, q) => get('/api/search', { league, q }),
  tennisRankings: () => get('/api/tennis/rankings'),
  tennisPlayer: (id) => get('/api/tennis/player', { id }),
};
export default api;
