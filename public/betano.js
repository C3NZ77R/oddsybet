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
  if (!/(^|\.)betano\./.test(location.hostname) || !ids.length) return alert('Abre en Betano la página de la NBA o un partido y vuelve a tocar el marcador.');
  const events = await Promise.all(ids.slice(0, 20).map(async (id) => {
    const ev = await fetch(`/api/cuotas-de-partido/x/${id}/?bt=1`).then((r) => r.json()).then((j) => j.data?.event).catch(() => null);
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
    return markets.length ? [ev.name, ev.startTime, markets] : null;
  }));
  const found = events.filter(Boolean);
  if (!found.length) return alert('No encontré líneas Más/Menos de jugadores en esta página de Betano.');
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

// El parámetro d de #/betano: base64url de deflate-raw. Si algo falla o descomprime a más de MAX_BYTES, {}.
export async function decode(d) {
  try {
    const bin = atob(String(d ?? '').replace(/-/g, '+').replace(/_/g, '/'));
    const reader = new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    for (let n = 0; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((n += value.length) > MAX_BYTES) { await reader.cancel(); return {}; }
      parts.push(value);
    }
    return linesOf(JSON.parse(await new Blob(parts).text()));
  } catch {
    return {};
  }
}

// Líneas guardadas (store 'betano'), o null si no hay o tienen más de 12 h.
export const saved = (store) => { const b = store.get('betano'); return b?.lines && Date.now() - b.at < TTL ? b : null; };
// Un partido suelto se suma a lo que ya había; las líneas nuevas ganan.
export const save = (store, lines) => store.set('betano', { at: Date.now(), lines: { ...saved(store)?.lines, ...lines } });
export const lineFor = (b, player, stat) => b?.lines[keyOf(player, stat)] ?? null;

// El prop del servidor llevado a otra línea, con su misma media y varianza.
export function atLine(p, line, side = p.side) {
  const over = bm.propOver(p.kind, p.mean, p.variance, line);
  if (over > bm.MAX_P || over < 1 - bm.MAX_P) return null; // casi segura: la cuota topa en 1.01 y deja valor al apostador
  const pr = bm.price(side === 'Over' ? over : 1 - over);
  return { ...p, line, side, p: pr.p, fair: pr.fair, books: [{ key: 'oddsy', title: 'Oddsy', price: pr.oddsy }] };
}
// Ventaja con la cuota de Betano: lo que se gana por peso apostado si la probabilidad de Oddsy es la real.
export const edge = (p, price) => (Number.isFinite(price) && Number.isFinite(p) ? p * price - 1 : null);
