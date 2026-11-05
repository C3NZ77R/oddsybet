// Estadio en vivo: presión, calor, rachas y zonas de tiro a partir de las jugadas (lib/plays.mjs). Funciones puras, sin DOM:
// las usa la vista Estadio (views/stadium.js) y los tests.

// Qué tan cerca de ser gol estuvo cada tipo de jugada de fútbol.
const WEIGHT = { goal: 5, 'shot-on': 3, post: 3, 'pen-miss': 3, 'shot-off': 2, blocked: 2, corner: 1.5, offside: 0.5, 'free-kick': 1 };
const SIDES = ['home', 'away'];

// Peligro de una jugada de fútbol: el peso del tipo, más si ocurre cerca del arco rival. La x es absoluta (el local ataca
// hacia 100), así que se pasa al marco de quien ataca. Un tiro libre (de quien lo gana) solo cuenta en el último tercio; sin
// posición no se sabe dónde fue y vale 0, la falta no cuenta, y el resto de tipos sin posición queda con factor 1.
export function danger(p) {
  const ax = Number.isFinite(p.x) ? (p.side === 'home' ? p.x : 100 - p.x) : null;
  const w = p.kind === 'free-kick' ? (ax >= 66 ? 1 : 0) : WEIGHT[p.kind] ?? 0;
  return ax == null ? w : w * (0.5 + ax / 100);
}

// Presión por tramos de `bucket` segundos (5 min): suma del peligro de cada lado. Siempre cubre los 90 min; el tiempo
// añadido o la prórroga abren tramos nuevos.
export function momentum(plays, bucket = 300) {
  const out = Array.from({ length: Math.ceil(5400 / bucket) }, (_, i) => ({ t0: i * bucket, home: 0, away: 0 }));
  for (const p of plays) {
    // t de más de 3 h es un dato roto: no vale la pena abrir miles de tramos.
    if (!Number.isFinite(p.t) || p.t < 0 || p.t > 10800 || !SIDES.includes(p.side)) continue;
    const i = Math.floor(p.t / bucket);
    while (out.length <= i) out.push({ t0: out.length * bucket, home: 0, away: 0 });
    out[i][p.side] += danger(p);
  }
  return out;
}

// Rachas de básquet: puntos seguidos de un mismo lado sin que el rival anote. Una racha abierta al final también cuenta.
export function runs(plays, min = 8) {
  const out = [];
  let cur = null;
  const close = () => { if (cur && cur.pts >= min) out.push(cur); };
  for (const p of plays) {
    if (!(p.pts > 0) || !SIDES.includes(p.side)) continue;
    if (cur?.side !== p.side) { close(); cur = { side: p.side, pts: 0, fromSeq: p.seq, toSeq: p.seq }; }
    cur.pts += p.pts;
    cur.toSeq = p.seq;
  }
  close();
  return out;
}

// Mapa de calor (filas × columnas) de las jugadas con posición de un lado, de 0 a 1 contra la celda más cargada.
export function heat(plays, side, cols = 12, rows = 8) {
  const g = Array.from({ length: rows }, () => Array(cols).fill(0));
  const cell = (v, n) => Math.max(0, Math.min(n - 1, Math.floor((v / 100) * n))); // 100 justo cae en la última celda
  let max = 0;
  for (const p of plays) {
    if (p.side !== side || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    max = Math.max(max, ++g[cell(p.y, rows)][cell(p.x, cols)]);
  }
  return max ? g.map((r) => r.map((v) => v / max)) : g;
}

// Tiros de básquet de un lado por zona (la zona solo la trae un tiro con coordenadas válidas): anotados e intentados.
export function shotZones(plays, side) {
  const z = { paint: { made: 0, att: 0 }, mid: { made: 0, att: 0 }, corner3: { made: 0, att: 0 }, arc3: { made: 0, att: 0 } };
  for (const p of plays) {
    if (p.side !== side || !Object.hasOwn(z, p.zone)) continue;
    z[p.zone].att++;
    if (p.made) z[p.zone].made++;
  }
  return z;
}

// Quién tiró en el partido (tiros de campo de básquet), de más a menos intentos: la lista para elegir los tiros de uno.
export function shooters(plays) {
  const by = new Map();
  for (const p of plays) {
    if (p.kind !== 'shot' || !p.who || !SIDES.includes(p.side)) continue;
    const s = by.get(p.who) ?? by.set(p.who, { who: p.who, side: p.side, att: 0, made: 0 }).get(p.who);
    s.att++;
    if (p.made) s.made++;
  }
  return [...by.values()].sort((a, b) => b.att - a.att || a.who.localeCompare(b.who));
}

// Planilla de tiro de un jugador: de campo, triples (por la zona del tiro) y libres. Lo que miran las props de puntos.
export function shotLine(plays, who) {
  const line = { fg: { made: 0, att: 0 }, three: { made: 0, att: 0 }, ft: { made: 0, att: 0 } };
  const add = (k, made) => { line[k].att++; if (made) line[k].made++; };
  for (const p of plays) {
    if (p.who !== who) continue;
    if (p.kind === 'ft') add('ft', p.made);
    if (p.kind !== 'shot') continue;
    add('fg', p.made);
    if (p.zone === 'corner3' || p.zone === 'arc3') add('three', p.made);
  }
  return line;
}

// Jugadas que dicen dónde está atacando un equipo de fútbol. La falta no: su tiro libre (del que la recibe) ya lo dice.
const ATTACK = new Set(['goal', 'shot-on', 'shot-off', 'blocked', 'post', 'pen-miss', 'corner', 'free-kick', 'offside']);
// Hacia dónde va el ataque en la jugada i, según la última jugada de ataque con posición: quién ataca, la x en su marco
// (hacia 100) y el nivel. Si esa jugada es de hace más de `window` segundos de partido ya no dice nada y da null.
export function attackNow(plays, i, window = 180) {
  const now = plays[i];
  for (let k = Math.min(i, plays.length - 1); k >= 0; k--) {
    const p = plays[k];
    if (!ATTACK.has(p.kind) || !SIDES.includes(p.side) || !Number.isFinite(p.x)) continue;
    if (Number.isFinite(now?.t) && Number.isFinite(p.t) && now.t - p.t > window) return null;
    const ax = p.side === 'home' ? p.x : 100 - p.x;
    return { side: p.side, ax, level: ax >= 66 ? 'peligro' : ax >= 33 ? 'ataque' : 'salida' };
  }
  return null;
}

// Las jugadas que la vista aún no mostró, en orden y solo las últimas `max`: si la pestaña estuvo oculta no se reproduce
// todo el atraso de golpe.
export function newPlays(seen, plays, max = 12) {
  const fresh = plays.filter((p) => !seen.has(p.id));
  return fresh.slice(Math.max(0, fresh.length - max));
}
