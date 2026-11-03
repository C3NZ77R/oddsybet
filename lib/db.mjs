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
    activeBets: async () => (await rest(`track_bets?status=in.(pendiente,en_juego)&select=${WITH_SELS},track_devices(id,subscription)`)).map(betOf),
    saveBet: ({ id, status, notified, settledAt }) => rest(`track_bets?id=${eq(id)}`, { method: 'PATCH', body: snake({ status, notified, settledAt }) }),
    // Upsert por id en una sola petición: cada fila va completa (las columnas not null también).
    saveSelections: (sels) => (sels.length ? rest('track_selections?on_conflict=id', { method: 'POST', body: sels.map(selRow), prefer: 'resolution=merge-duplicates' }) : null),

    bumpReads: (day, keys, limits) => rpc('track_bump', { p_day: day, p_keys: keys, p_limits: limits }),
    takeLease: (seconds) => rpc('track_take_lease', { p_seconds: seconds }),
    releaseLease: () => rest('track_lease?id=eq.1', { method: 'PATCH', body: { until: '1970-01-01T00:00:00Z' } }),
  };
}
