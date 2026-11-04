// Estado del usuario en localStorage (con respaldo en memoria si el navegador lo bloquea).
// Claves: picks, settings, views, presets, league (última liga), heroSeen, track.
const PREFIX = 'oddsy.';
const DEFAULTS = {
  picks: [], // [{ id, label, price (decimal), book, league, gameId, addedAt, shared? (vino de un enlace, sin verificar) }]
  settings: { oddsFormat: 'decimal' },
  views: {}, // { [propKey]: { view, add, last } } → "Populares" con actividad local
  presets: {}, // { [vista]: [{ name, ... }] }
  league: 'nba',
  track: null, // { deviceId, secret } del seguimiento de apuestas (avisos al celular)
};
const MAX_VIEWS = 300;
const mem = {};
const subs = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function load(k) {
  let v;
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + k);
    if (raw != null) v = JSON.parse(raw);
  } catch { /* bloqueado o corrupto: se usan los valores por defecto */ }
  if (v === undefined) return clone(DEFAULTS[k]);
  if (k === 'settings') return { ...DEFAULTS.settings, ...v };
  if (k === 'picks' && !Array.isArray(v)) return [];
  return v;
}

function get(k) {
  if (!(k in mem)) mem[k] = load(k);
  return mem[k];
}

function set(k, v) {
  const prev = mem[k];
  mem[k] = v;
  try { globalThis.localStorage?.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* sin espacio o bloqueado: queda en memoria */ }
  emit(k, v, prev);
  return v;
}

function emit(k, v, prev) {
  for (const fn of subs.get(k) ?? []) {
    try { fn(v, prev); } catch (err) { console.error(err); }
  }
}

// Devuelve la función para desuscribirse (úsala en el cleanup de la vista).
function on(k, fn) {
  if (!subs.has(k)) subs.set(k, new Set());
  subs.get(k).add(fn);
  return () => subs.get(k).delete(fn);
}

function addPick(p) {
  const pick = { ...p, addedAt: p.addedAt ?? Date.now() };
  return set('picks', [...get('picks').filter((x) => x.id !== pick.id), pick]);
}
const removePick = (id) => set('picks', get('picks').filter((x) => x.id !== id));
const hasPick = (id) => get('picks').some((x) => x.id === id);

function track(propKey, kind = 'view') {
  const views = { ...get('views') };
  const cur = views[propKey] ?? { view: 0, add: 0 };
  views[propKey] = { ...cur, [kind]: (cur[kind] ?? 0) + 1, last: Date.now() };
  // Solo los MAX_VIEWS más recientes: sin tope Populares se volvía lento y localStorage se llenaba.
  return set('views', Object.fromEntries(Object.entries(views).sort(([, a], [, b]) => (b?.last ?? 0) - (a?.last ?? 0)).slice(0, MAX_VIEWS)));
}

// Otra pestaña cambió algo: se recarga y se avisa.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    const k = e.key.slice(PREFIX.length);
    const prev = mem[k];
    delete mem[k];
    emit(k, get(k), prev);
  });
}

// ---------- enlace para compartir el boleto ----------
// Formato: base64url(JSON [[id, label, price, book, league, gameId], ...]).
export function encodePicks(picks) {
  const json = JSON.stringify(picks.map((p) => [p.id, p.label, p.price, p.book ?? null, p.league ?? null, p.gameId ?? null]));
  let bin = '';
  for (const b of new TextEncoder().encode(json)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Entrada no confiable (viene de una URL): se valida cada campo y se descarta lo que no cuadre.
export function decodePicks(s) {
  try {
    const bin = atob(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'));
    const arr = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (!Array.isArray(arr)) return [];
    const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
    const seen = new Set(); // un id repetido se agregaría dos veces y «Quitar» borraría ambos
    return arr.slice(0, 50).flatMap((x) => {
      if (!Array.isArray(x)) return [];
      const [id, label, price, book, league, gameId] = x;
      if (!str(id) || !str(label) || typeof price !== 'number' || !(price > 1 && price < 100000) || seen.has(str(id))) return [];
      seen.add(str(id));
      return [{ id: str(id), label: str(label), price, book: str(book), league: str(league), gameId: str(gameId) }];
    });
  } catch {
    return [];
  }
}

export const store = { get, set, on, addPick, removePick, hasPick, track, encodePicks, decodePicks };
export default store;
