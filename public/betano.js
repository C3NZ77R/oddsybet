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

// Corre dentro de betano.co (como marcador, o desde scripts/betano-reader.mjs por CDP), así que no puede usar nada
// de este módulo. Lee las líneas Más/Menos de jugadores y los mercados de partido del partido abierto o de todos los
// partidos de la página de la liga → [[nombre, inicio, props, mercados de partido], …]. pause = [mín, máx] en ms
// entre peticiones (el lector; el marcador las pide a la vez). Un 403 o un 429 lo corta con un error: no se insiste.
export async function read({ pause, max = 20 } = {}) {
  const idOf = (href) => String(href).match(/\/cuotas-de-partido\/[^/]+\/(\d+)/)?.[1];
  const own = idOf(location.pathname);
  const ids = own ? [own] : [...new Set([...document.querySelectorAll('a[href*="/cuotas-de-partido/"]')].map((a) => idOf(a.href)).filter(Boolean))];
  if (!/(^|\.)betano\./.test(location.hostname) || !ids.length) return null;
  // Mercados de partido que Oddsy compara (tipos de la API de Betano, vistos el 2026-11-11). El 1X2 del fútbol y
  // el ganador del tenis solo vienen en la página de la liga, así que se piden también ahí.
  const GAME = ['MRES', 'H2HT', 'HTOH', 'FHOT', 'FTPO', 'HCTG', 'BTSC',
    // Vistos el 2026-11-16 en la pestaña "Todo" de un partido. Fútbol: DBLC doble oportunidad, DNOB apuesta sin
    // empate, AHRF hándicap asiático, ASOU total asiático, OUHG/OUAG goles del equipo 1/2 (Más/Menos).
    'DBLC', 'DNOB', 'AHRF', 'ASOU', 'OUHG', 'OUAG',
    // Tenis: TGHC hándicap de games, FTGO total de games, STWN ganador del set (tabla con una fila por set).
    'TGHC', 'FTGO', 'STWN'];
  const gameOf = (m) => {
    if (!GAME.includes(m?.type)) return [];
    // En vivo el hándicap asiático parte del marcador del momento: solo vale como el del partido si va 0 - 0.
    if (m.type === 'AHRF' && !/\(Resultado actual 0 - 0\)/.test(m.name ?? '')) return [];
    const sels = m.type === 'STWN' ? m.tableLayout?.rows?.find((r) => r.title === '1')?.groupSelections?.[0]?.selections : m.selections;
    return sels?.length ? [[m.type, sels.map((s) => [s.fullName || s.name, s.price, s.handicap ?? 0])]] : [];
  };
  const get = async (url) => {
    const r = await fetch(url);
    if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const soft = (p) => p.catch((e) => { if (/^HTTP 4/.test(e?.message)) throw e; return null; });
  const main = new Map();
  if (!own) {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.events)) for (const e of o.events) if (e?.id) main.set(String(e.id), e.markets ?? []);
      for (const v of Object.values(o)) walk(v);
    };
    walk(await soft(get(`/api${location.pathname}?bt=1`)));
  }
  const nap = () => pause && new Promise((ok) => setTimeout(ok, pause[0] + Math.random() * (pause[1] - pause[0])));
  // bt = pestaña de mercados del partido. La 1 es "Jugadores" en la NBA (las líneas de props); en fútbol y tenis
  // es una pestaña parcial, así que al ver la lista de pestañas se pasa a "Todo" para ese partido y los siguientes.
  let tab = '1';
  const event = async (id) => {
    const d = (await get(`/api/cuotas-de-partido/x/${id}/?bt=${tab}`)).data;
    const all = tab === '1' && !d?.markets?.some((t) => t.type === 'players') && d?.markets?.find((t) => /^all/.test(t.type))?.id;
    if (!/^\d+$/.test(all) || all === tab) return d?.event;
    tab = String(all);
    await nap();
    return (await get(`/api/cuotas-de-partido/x/${id}/?bt=${tab}`)).data?.event ?? d.event;
  };
  const one = async (id) => {
    await nap();
    const ev = await soft(event(id));
    // "Todo" repite algunos mercados idénticos: se deja uno.
    const games = [...(main.get(id) ?? []), ...(ev?.markets ?? [])].flatMap(gameOf).filter((g, i, a) => a.findIndex((x) => JSON.stringify(x) === JSON.stringify(g)) === i);
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
  };
  const [first, ...rest] = ids.slice(0, max);
  const events = [await one(first)]; // el primero solo: decide la pestaña de los demás
  if (pause) for (const id of rest) events.push(await one(id));
  else events.push(...await Promise.all(rest.map(one)));
  return events.filter(Boolean);
}

// El marcador: lee con read (va pegada al código del favorito) y abre Oddsy con lo leído en el hash.
export async function grab(target, rd = read) {
  const found = await rd().catch(() => []);
  if (!found) return alert('Abre en Betano la página de una liga o de un partido y vuelve a tocar el marcador.');
  if (!found.length) return alert('No encontré cuotas en esta página de Betano.');
  const zip = new Blob([JSON.stringify(found)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  let bin = '';
  for (const b of new Uint8Array(await new Response(zip).arrayBuffer())) bin += String.fromCharCode(b);
  location.href = target + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// encodeURIComponent: así los saltos de línea, '#' y '%' del código sobreviven como URL de un favorito.
export const bookmarklet = (origin) => `javascript:${encodeURIComponent(`(${grab})(${JSON.stringify(`${origin}/#/betano?d=`)},${read})`)}`;

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

// Mercados de partido de read (ev[3]) → [{ t, teams: [1, 2], ml: [1, (X), 2], spread: [hcp de 1, cuota 1, cuota 2],
// ou: [[línea, Más, Menos]], btts: [Sí, No] }]. En Betano la primera selección es el equipo 1 y la última el 2.
// Si Betano los trae, además (fútbol): dc: [1X, X2, 12], dnb: [1, 2], ah: [[hcp asiático de 1, cuota 1, cuota 2]],
// aou: [[línea asiática, Más, Menos]], tt1 y tt2: [[línea de goles del equipo 1 / 2, Más, Menos]];
// (tenis): gh: [[hcp de games de 1, cuota 1, cuota 2]], gou: [[línea de games, Más, Menos]], s1: [1, 2] (primer set).
export function gamesOf(events) {
  const out = [];
  const odds = (x) => (typeof x === 'number' && x > 1 && x < 1000 ? x : null);
  const OU = { FTPO: 'ou', HCTG: 'ou', ASOU: 'aou', OUHG: 'tt1', OUAG: 'tt2', FTGO: 'gou' }, HCP = { AHRF: 'ah', TGHC: 'gh' }, TWO = { BTSC: 'btts', DNOB: 'dnb', STWN: 's1' };
  for (const ev of Array.isArray(events) ? events.slice(0, 30) : []) {
    const teams = typeof ev?.[0] === 'string' ? ev[0].split(' - ').map((s) => s.trim()) : [];
    if (teams.length !== 2 || !Number.isFinite(ev[1]) || !Array.isArray(ev[3])) continue;
    const g = { t: ev[1], teams: teams.map((s) => s.slice(0, 60)), ou: [] };
    for (const [type, sels] of ev[3].slice(0, 40)) {
      if (!Array.isArray(sels) || typeof type !== 'string') continue;
      const s = sels.slice(0, 40).filter((x) => Array.isArray(x) && typeof x[0] === 'string').map(([n, p, h]) => [n, odds(p), Number.isFinite(h) ? h : 0]);
      if (type === 'MRES' && s.length === 3) g.ml = s.map((x) => x[1]);
      else if ((type === 'H2HT' || type === 'HTOH') && s.length === 2) g.ml = s.map((x) => x[1]);
      else if (type === 'FHOT' && s.length === 2) g.spread = [s[0][2], s[0][1], s[1][1]];
      else if (Object.hasOwn(TWO, type) && s.length === 2) g[TWO[type]] = s.map((x) => x[1]);
      else if (type === 'DBLC' && s.length === 3) {
        // Por nombre y no por posición: "1 o Empate", "2 o Empate" y "1 o 2".
        const of = (a, b) => s.find(([n]) => n === `${a} o ${b}` || n === `${b} o ${a}`)?.[1] ?? null;
        const dc = [of(teams[0], 'Empate'), of(teams[1], 'Empate'), of(teams[0], teams[1])];
        if (dc.some(Boolean)) g.dc = dc;
      } else if (Object.hasOwn(HCP, type)) {
        // Vienen por parejas: el equipo 1 con su hándicap y el 2 con el opuesto.
        const rows = g[HCP[type]] ??= [];
        for (let i = 0; i + 1 < s.length; i += 2) {
          const [a, b] = [s[i], s[i + 1]];
          if (a[0].startsWith(teams[0]) && b[0].startsWith(teams[1]) && a[2] === -b[2] && !rows.some((r) => r[0] === a[2])) rows.push([a[2], a[1], b[1]]);
        }
      } else if (Object.hasOwn(OU, type)) {
        const rows = g[OU[type]] ??= [];
        for (const [n, p, h] of s) {
          let row = rows.find((r) => r[0] === h);
          if (!row) rows.push(row = [h, null, null]);
          row[/^Más/i.test(n) ? 1 : 2] = p;
        }
      }
    }
    if (Object.keys(g).length > 3 || g.ou.length) out.push(g);
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
  // Hándicaps: filas [hcp del equipo 1 de Betano, cuota 1, cuota 2]; vale la fila cuya línea es la de la selección.
  const hcp = (rows) => {
    if (side == null) return null;
    const row = (rows ?? []).find((r) => s.line === (side === 0 ? 1 : -1) * (flip ? -r[0] : r[0]));
    return row ? row[bt(side) + 1] : null;
  };
  // Totales: filas [línea, Más, Menos].
  const tot = (rows) => {
    const row = s.line != null && (rows ?? []).find((r) => r[0] === s.line);
    return row ? (s.name === 'Más' ? row[1] : s.name === 'Menos' ? row[2] : null) : null;
  };
  const two = (pair) => (pair && side != null ? pair[bt(side)] : null);
  if (m.key === 'spread') return hcp(g.spread && [g.spread]);
  if (m.key === 'ah') return hcp(g.ah);
  if (m.key === 'games_hcp') return hcp(g.gh);
  if (m.key === 'ou') return tot(g.ou);
  if (m.key === 'ou_games') return tot(g.gou);
  if (m.key === 'aou') return tot(g.aou);
  if (m.key === 'ou_home') return tot(flip ? g.tt2 : g.tt1);
  if (m.key === 'ou_away') return tot(flip ? g.tt1 : g.tt2);
  if (m.key === 'dnb') return two(g.dnb);
  if (m.key === 'first_set') return two(g.s1);
  // dc de Betano: [1X, X2, 12], con 1 = su equipo 1.
  if (m.key === 'dc' && g.dc) return g.dc[{ 'Local o empate': flip ? 1 : 0, 'Empate o visitante': flip ? 0 : 1, 'Local o visitante': 2 }[s.name]] ?? null;
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
