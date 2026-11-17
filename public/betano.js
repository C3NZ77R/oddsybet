// Líneas de Betano para los props de NBA: el marcador que las lee en betano.co y lo que Oddsy hace con ellas
// (#/betano?d=…). Diseño: docs/superpowers/specs/2026-11-04-lineas-betano-design.md.
import * as bm from './betmath.js';

// Título del mercado Más/Menos en la API de Betano → estadística de Oddsy (visto el 2026-11-04).
export const TITLES = {
  'Puntos Más/Menos': 'pts',
  'Rebotes Más/Menos': 'reb',
  'Asistencias Más/Menos': 'ast',
  'Total de Tiros de tres puntos anotados - Más/Menos': '3pm',
  'Puntos+Rebotes+Asistencias Más/Menos': 'pra',
  'Puntos+Rebotes Más/Menos': 'pr',
  'Puntos+Asistencias Más/Menos': 'pa',
  'Rebotes+Asistencias Más/Menos': 'ra',
  'Robos Más/Menos': 'stl',
  'Bloqueos Más/Menos': 'blk',
  'Robos+bloqueos Más/Menos': 'sb',
  'Pérdidas de balón Más/Menos': 'to',
  'Goles de campo convertidos Más/Menos': 'fgm',
  'Tiros libres anotados Más/Menos': 'ftm',
  'Tiros libres intentados Más/Menos': 'fta',
};
const TTL = 12 * 3600 * 1000;
const MAX_BYTES = 1 << 20; // los 14 partidos de una noche son ~85 KB

// Corre dentro de betano.co como marcador, así que no puede usar nada de este módulo. Lee las líneas Más/Menos de
// jugadores del partido abierto o de todos los partidos de la página de la liga y abre Oddsy con ellas en el hash.
export async function grab(target) {
  const idOf = (href) => String(href).match(/\/cuotas-de-partido\/[^/]+\/(\d+)/)?.[1];
  const own = idOf(location.pathname);
  const ids = own ? [own] : [...new Set([...document.querySelectorAll('a[href*="/cuotas-de-partido/"]')].map((a) => idOf(a.href)).filter(Boolean))];
  if (!/(^|\.)betano\./.test(location.hostname) || !ids.length) return alert('Abre en Betano la página de una liga o de un partido y vuelve a tocar el marcador.');
  // Mercados de partido que Oddsy compara (tipos de la API de Betano, vistos el 2026-11-11). El 1X2 del fútbol y
  // el ganador del tenis solo vienen en la página de la liga, así que se piden también ahí.
  const GAME = ['MRES', 'H2HT', 'HTOH', 'FHOT', 'FTPO', 'HCTG', 'BTSC'];
  const gameOf = (m) => (GAME.includes(m?.type) && m.selections?.length ? [[m.type, m.selections.map((s) => [s.fullName || s.name, s.price, s.handicap ?? 0])]] : []);
  const main = new Map();
  if (!own) {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.events)) for (const e of o.events) if (e?.id) main.set(String(e.id), e.markets ?? []);
      for (const v of Object.values(o)) walk(v);
    };
    walk(await fetch(`/api${location.pathname}?bt=1`).then((r) => r.json()).catch(() => null));
  }
  const events = await Promise.all(ids.slice(0, 20).map(async (id) => {
    const ev = await fetch(`/api/cuotas-de-partido/x/${id}/?bt=1`).then((r) => r.json()).then((j) => j.data?.event).catch(() => null);
    const games = [...(main.get(id) ?? []), ...(ev?.markets ?? [])].flatMap(gameOf);
    const markets = (ev?.markets ?? []).flatMap((m) => {
      const t = m.tableLayout;
      if (!/Más\/Menos/.test(t?.title ?? '')) return [];
      const rows = (t.rows ?? []).flatMap((r) => {
        const g = r.groupSelections?.[0];
        const price = (i) => g?.selections?.find((s) => s.columnIndex === i)?.price ?? null;
        return Number.isFinite(g?.handicap) ? [[r.title, g.handicap, price(0), price(1)]] : [];
      });
      return rows.length ? [[t.title.trim(), rows]] : [];
    });
    return ev && (markets.length || games.length) ? [ev.name, ev.startTime, markets, games] : null;
  }));
  const found = events.filter(Boolean);
  if (!found.length) return alert('No encontré cuotas en esta página de Betano.');
  const zip = new Blob([JSON.stringify(found)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  let bin = '';
  for (const b of new Uint8Array(await new Response(zip).arrayBuffer())) bin += String.fromCharCode(b);
  location.href = target + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// encodeURIComponent: así los saltos de línea, '#' y '%' del código sobreviven como URL de un favorito.
export const bookmarklet = (origin) => `javascript:${encodeURIComponent(`(${grab})(${JSON.stringify(`${origin}/#/betano?d=`)})`)}`;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// shortcut: solo nombre + estadística; dos jugadores con el mismo nombre el mismo día se pisan. Si pasa, sumar el partido.
const keyOf = (player, stat) => `${norm(player)}|${stat}`;

// Lo que manda grab, ya descomprimido → { 'jugador|stat': [línea, cuota Más, cuota Menos] }. Entrada no confiable.
export function linesOf(events) {
  const out = {};
  const odds = (x) => (typeof x === 'number' && x > 1 && x < 1000 ? x : null);
  for (const ev of Array.isArray(events) ? events.slice(0, 30) : []) {
    for (const m of Array.isArray(ev?.[2]) ? ev[2] : []) {
      const stat = Array.isArray(m) && Object.hasOwn(TITLES, m[0]) ? TITLES[m[0]] : null;
      if (!stat || !Array.isArray(m[1])) continue;
      for (const r of m[1].slice(0, 40)) {
        const [name, line, over, under] = Array.isArray(r) ? r : [];
        if (typeof name !== 'string' || !norm(name) || name.length > 60 || !(Number.isFinite(line) && line >= 0 && line < 200)) continue;
        out[keyOf(name, stat)] = [line, odds(over), odds(under)];
      }
    }
  }
  return out;
}

// Mercados de partido de grab (ev[3]) → [{ t, teams: [1, 2], ml: [1, (X), 2], spread: [hcp de 1, cuota 1, cuota 2],
// ou: [[línea, Más, Menos]], btts: [Sí, No] }]. En Betano la primera selección es el equipo 1 y la última el 2.
export function gamesOf(events) {
  const out = [];
  const odds = (x) => (typeof x === 'number' && x > 1 && x < 1000 ? x : null);
  for (const ev of Array.isArray(events) ? events.slice(0, 30) : []) {
    const teams = typeof ev?.[0] === 'string' ? ev[0].split(' - ') : [];
    if (teams.length !== 2 || !Number.isFinite(ev[1]) || !Array.isArray(ev[3])) continue;
    const g = { t: ev[1], teams: teams.map((s) => s.trim().slice(0, 60)), ou: [] };
    for (const [type, sels] of ev[3].slice(0, 40)) {
      if (!Array.isArray(sels)) continue;
      const s = sels.slice(0, 40).filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([n, p, h]) => [n, odds(p), Number.isFinite(h) ? h : 0]);
      if (type === 'MRES' && s.length === 3) g.ml = s.map((x) => x[1]);
      else if ((type === 'H2HT' || type === 'HTOH') && s.length === 2) g.ml = s.map((x) => x[1]);
      else if (type === 'FHOT' && s.length === 2) g.spread = [s[0][2], s[0][1], s[1][1]];
      else if (type === 'BTSC' && s.length === 2) g.btts = s.map((x) => x[1]);
      else if (type === 'FTPO' || type === 'HCTG') {
        for (const [n, p, h] of s) {
          let row = g.ou.find((r) => r[0] === h);
          if (!row) g.ou.push(row = [h, null, null]);
          row[/^Más/i.test(n) ? 1 : 2] = p;
        }
      }
    }
    if (g.ml || g.spread || g.btts || g.ou.length) out.push(g);
  }
  return out;
}

// El parámetro d de #/betano: base64url de deflate-raw → { lines, games }. Si algo falla o pasa de MAX_BYTES, vacío.
export async function decodeAll(d) {
  try {
    const bin = atob(String(d ?? '').replace(/-/g, '+').replace(/_/g, '/'));
    const reader = new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    for (let n = 0; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((n += value.length) > MAX_BYTES) { await reader.cancel(); return { lines: {}, games: [] }; }
      parts.push(value);
    }
    const events = JSON.parse(await new Blob(parts).text());
    return { lines: linesOf(events), games: gamesOf(events) };
  } catch {
    return { lines: {}, games: [] };
  }
}
export const decode = async (d) => (await decodeAll(d)).lines;

// Líneas guardadas (store 'betano'), o null si no hay o tienen más de 12 h.
export const saved = (store) => { const b = store.get('betano'); return b?.lines && Date.now() - b.at < TTL ? b : null; };
// Un partido suelto se suma a lo que ya había; lo nuevo gana (un partido se reemplaza por sus mismos equipos y hora).
export function save(store, lines, games = []) {
  const old = saved(store), same = (a, b) => a.t === b.t && a.teams.join() === b.teams.join();
  store.set('betano', { at: Date.now(), lines: { ...old?.lines, ...lines }, games: [...(old?.games ?? []).filter((g) => !games.some((n) => same(g, n))), ...games] });
}
export const lineFor = (b, player, stat) => b?.lines[keyOf(player, stat)] ?? null;

// Palabras de 3+ letras en común entre dos nombres de equipo o jugador ("Indiana Pacers" / "Pacers" → 1).
const words = (s) => new Set(String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
const shared = (a, b) => { const w = words(b); return [...words(a)].filter((x) => w.has(x)).length; };

// El partido de Betano de un juego de Oddsy (d.start, d.home.name, d.away.name) → { g, flip } o null. flip: el
// equipo 1 de Betano es el visitante de Oddsy. Pide los dos equipos y menos de 12 h de diferencia en el inicio.
export function gameFor(b, d) {
  const t = Date.parse(d?.start);
  let best = null;
  for (const g of b?.games ?? []) {
    if (!Number.isFinite(t) || Math.abs(g.t - t) > 12 * 3600 * 1000) continue;
    for (const flip of [false, true]) {
      const [h, a] = flip ? [g.teams[1], g.teams[0]] : g.teams;
      const sh = shared(h, d.home?.name), sa = shared(a, d.away?.name);
      // "Manchester City" y "Manchester United" comparten una palabra: gana la que comparte más con cada lado.
      if (sh && sa && (!best || sh + sa > best.score)) best = { g, flip, score: sh + sa };
    }
  }
  return best && { g: best.g, flip: best.flip };
}

// Líneas de Betano de un partido de básquet para que el servidor cotice ahí: { spread: hándicap del local, total }.
// null si Betano no trae ninguna (fútbol y tenis ya publican varias líneas).
export function overOf(hit) {
  if (!hit?.g.spread && hit?.g.ou.length !== 1) return null;
  const { g, flip } = hit;
  const out = { ...(g.spread && { spread: flip ? -g.spread[0] : g.spread[0] }), ...(g.ou.length === 1 && { total: g.ou[0][0] }) };
  return Object.keys(out).length ? out : null;
}

// Cuota de Betano para una selección de un mercado de Oddsy (lib/markets.mjs), o null si Betano no la tiene.
export function priceFor(hit, m, s) {
  if (!hit) return null;
  const { g, flip } = hit;
  const side = s.name === 'Local' || s.name === 'A' ? 0 : s.name === 'Visitante' || s.name === 'B' ? 1 : null;
  const bt = (i) => (flip ? 1 - i : i); // índice del equipo de Oddsy en Betano
  if ((m.key === 'ml' || m.key === '1x2') && g.ml) {
    if (s.name === 'Empate') return g.ml.length === 3 ? g.ml[1] : null;
    if (side == null || (m.key === '1x2') !== (g.ml.length === 3)) return null;
    return bt(side) === 0 ? g.ml[0] : g.ml.at(-1);
  }
  if (m.key === 'spread' && g.spread && side != null) {
    const [hcp, p1, p2] = g.spread;
    const homeLine = flip ? -hcp : hcp; // línea del local de Oddsy en Betano
    if (s.line !== (side === 0 ? homeLine : -homeLine)) return null;
    return bt(side) === 0 ? p1 : p2;
  }
  if (m.key === 'ou' && s.line != null) {
    const row = g.ou.find((r) => r[0] === s.line);
    return row ? (s.name === 'Más' ? row[1] : s.name === 'Menos' ? row[2] : null) : null;
  }
  if (m.key === 'btts' && g.btts) return s.name === 'Sí' ? g.btts[0] : s.name === 'No' ? g.btts[1] : null;
  return null;
}

// El prop del servidor llevado a otra línea, con su misma media y varianza.
export function atLine(p, line, side = p.side) {
  const over = bm.propOver(p.kind, p.mean, p.variance, line);
  if (over > bm.MAX_P || over < 1 - bm.MAX_P) return null; // casi segura: la cuota topa en 1.01 y deja valor al apostador
  const pr = bm.price(side === 'Over' ? over : 1 - over);
  return { ...p, line, side, p: pr.p, fair: pr.fair, books: [{ key: 'oddsy', title: 'Oddsy', price: pr.oddsy }] };
}
// Ventaja con la cuota de Betano: lo que se gana por peso apostado si la probabilidad de Oddsy es la real.
export const edge = (p, price) => (Number.isFinite(price) && Number.isFinite(p) ? p * price - 1 : null);
