// Seguimiento: dispositivos, apuestas y selecciones en Supabase por su API REST (PostgREST) con fetch, sin SDK. Solo el
// servidor habla con Supabase, con la service role key. snake_case en la base, camelCase en el resto de Oddsy.
import { httpError } from './espn.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Solo el primer nivel: jsonb (state, notified, subscription, prior) se guarda tal cual.
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_(\w)/g, (_, c) => c.toUpperCase()), v]));
const snake = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

const SEL_COLS = ['id', 'betId', 'league', 'gameId', 'gameStart', 'market', 'stat', 'athleteId', 'athleteName', 'side', 'line', 'odds', 'label', 'prior', 'status', 'current', 'state'];
const selRow = (s) => snake(Object.fromEntries(SEL_COLS.filter((k) => k in s).map((k) => [k, s[k]])));
function betOf({ track_selections: sels, track_devices: dev, ...row }) {
  const b = { ...camel(row), selections: (sels ?? []).map(camel) };
  if (dev) b.device = dev;
  return b;
}
const WITH_SELS = '*,track_selections(*)';

export function createDb({ url, key, fetch = globalThis.fetch }) {
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    let res;
    try {
      res = await fetch(`${url}/rest/v1/${path}`, {
        method,
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(prefer && { prefer }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw httpError(502, 'No se pudo guardar el seguimiento');
    }
    if (!res.ok) throw httpError(502, 'No se pudo guardar el seguimiento');
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args });
  const eq = (v) => `eq.${encodeURIComponent(v)}`;

  return {
    async createDevice({ secretHash, subscription, platform }) {
      const [row] = await rest('track_devices', { method: 'POST', body: snake({ secretHash, subscription, platform }), prefer: 'return=representation' });
      return { id: row.id };
    },
    async getDevice(id) {
      if (!UUID.test(String(id))) return null; // un id inventado sería un 400 de PostgREST, no un error del servidor
      const [row] = await rest(`track_devices?id=${eq(id)}&select=*`);
      return row ? camel(row) : null;
    },
    touchDevice: (id, patch = {}) => rest(`track_devices?id=${eq(id)}`, { method: 'PATCH', body: snake({ ...patch, lastSeenAt: new Date().toISOString() }) }),
    deleteDevice: (id) => rest(`track_devices?id=${eq(id)}`, { method: 'DELETE' }),

    // Dos peticiones: si fallan las selecciones, se borra la apuesta para no dejarla vacía.
    async createBet(deviceId, { book = null, odds = null } = {}, selections) {
      const [bet] = await rest('track_bets', { method: 'POST', body: snake({ deviceId, book, odds }), prefer: 'return=representation' });
      try {
        const sels = await rest('track_selections', { method: 'POST', body: selections.map((s) => selRow({ ...s, betId: bet.id })), prefer: 'return=representation' });
        return betOf({ ...bet, track_selections: sels });
      } catch (err) {
        await rest(`track_bets?id=${eq(bet.id)}`, { method: 'DELETE' }).catch(() => {});
        throw err;
      }
    },
    listBets: async (deviceId) => (await rest(`track_bets?device_id=${eq(deviceId)}&select=${WITH_SELS}&order=created_at.desc`)).map(betOf),
    async deleteBet(deviceId, betId) {
      if (!UUID.test(String(betId))) return false;
      return (await rest(`track_bets?id=${eq(betId)}&device_id=${eq(deviceId)}`, { method: 'DELETE', prefer: 'return=representation' })).length > 0;
    },
    async activeBets() { // de a 1 000, el tope de PostgREST: sin paginar, las que pasan del tope nunca se cierran
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await rest(`track_bets?status=in.(pendiente,en_juego)&select=${WITH_SELS},track_devices(id,subscription)&order=id&limit=1000&offset=${offset}`);
        out.push(...page.map(betOf));
        if (page.length < 1000) return out;
      }
    },
    saveBet: ({ id, status, notified, settledAt }) => rest(`track_bets?id=${eq(id)}`, { method: 'PATCH', body: snake({ status, notified, settledAt }) }),
    // Upsert por id en una sola petición: cada fila va completa (las columnas not null también).
    saveSelections: (sels) => (sels.length ? rest('track_selections?on_conflict=id', { method: 'POST', body: sels.map(selRow), prefer: 'resolution=merge-duplicates' }) : null),

    bumpReads: (day, keys, limits) => rpc('track_bump', { p_day: day, p_keys: keys, p_limits: limits }),
    takeLease: (seconds) => rpc('track_take_lease', { p_seconds: seconds }),
    releaseLease: () => rest('track_lease?id=eq.1', { method: 'PATCH', body: { until: '1970-01-01T00:00:00Z' } }),

    // ---------- registro de picks (pick_log, pick_model, pick_state) ----------
    // Filas completas y con las mismas claves: PostgREST exige columnas parejas en un insert de varias filas.
    upsertPicks: (rows) => (rows.length ? rest('pick_log?on_conflict=id', { method: 'POST', body: rows.map(snake), prefer: 'resolution=merge-duplicates' }) : null),
    insertPicks: (rows) => (rows.length ? rest('pick_log?on_conflict=id', { method: 'POST', body: rows.map(snake), prefer: 'resolution=ignore-duplicates' }) : null),
    // Pendientes de un partido que ya no están en la foto nueva (un mercado cuyo pick desapareció).
    dropMissing: (league, gameId, keepIds) => rest(`pick_log?league=${eq(league)}&game_id=${eq(gameId)}&status=eq.pendiente${keepIds.length
      ? `&id=${encodeURIComponent(`not.in.(${keepIds.map((id) => `"${id}"`).join(',')})`)}` : ''}`, { method: 'DELETE' }),
    pendingPicks: async (before) => (await rest(`pick_log?status=eq.pendiente&game_start=lt.${encodeURIComponent(before)}&select=*&order=game_start&limit=1000`)).map(camel),
    // Paginado de a 1 000 (el tope por defecto de PostgREST en Supabase) hasta una página corta.
    async rowsSince({ since, select = '*', sport, league, source, settled = false }) {
      const filters = [`game_start=gte.${encodeURIComponent(since)}`, sport && `sport=${eq(sport)}`, league && `league=${eq(league)}`,
        source && `source=${eq(source)}`, settled && 'status=in.(ganada,perdida)'].filter(Boolean).join('&');
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await rest(`pick_log?select=${select}&${filters}&order=game_start,id&limit=1000&offset=${offset}`);
        out.push(...page.map(camel));
        if (page.length < 1000) return out;
      }
    },
    latestModel: async () => (await rest('pick_model?select=model&order=id.desc&limit=1'))[0]?.model ?? null,
    saveModel: (model) => rest('pick_model', { method: 'POST', body: { model } }),
    getState: async () => (await rest('pick_state?id=eq.1&select=backfill'))[0]?.backfill ?? {},
    setState: (backfill) => rest('pick_state?id=eq.1', { method: 'PATCH', body: { backfill } }),
  };
}

// La base del registro de picks: null si falta alguna variable (local, preview).
export const dbFromEnv = (env = process.env) => (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? createDb({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY }) : null);
