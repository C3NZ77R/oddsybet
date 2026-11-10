// ATP Challenger (singles masculino) desde el JSON público de LiveScore, sin clave: ESPN solo cubre el circuito ATP.
// Los partidos salen con la forma de los de lib/tennis.mjs para reusar el Elo y los mercados; sus ids llevan "ls"
// delante para no chocar con los de ESPN. Lo que llega es dato no confiable: solo se copian campos conocidos.
import { readFileSync } from 'node:fs';
import { fetchJson, mapLimit, TTL } from './espn.mjs';
import { SURFACE, finished, uniqueById } from './tennis.mjs';

const BASE = 'https://prod-public-api.livescore.com/v1/api/app/date/tennis';
const TZ = -5; // el día del pedido y las horas (Esd) en hora de Bogotá
const DAY = 86_400_000;
// Días que se piden en vivo desde el último del snapshot (data/challenger-elo.json, que .github/workflows/challenger.yml
// refresca cada lunes): con el workflow al día son ~9; si deja de correr, hasta este tope antes de perder partidos.
export const MAX_LIVE_DAYS = 60;
// Elo del Challenger (scripts/backtest.mjs → accuracy.challenger): los nuevos arrancan 200 abajo (no 100 como en la ATP;
// muchos suben de los ITF y entraban sobrevalorados) y la P(gana) se aplana con la pendiente que mide el backtest.
export const NEW_DROP = 200;
// σ(c·logit p): c < 1 acerca p a 0.5 (el Elo del Challenger se pasa de confiado: dijo 74 %, salió 65 %).
export const calibrate = (p, c = 1) => 1 / (1 + ((1 - p) / p) ** c);
const str = (v) => (v == null ? null : String(v));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// shortcut: LiveScore no trae la superficie; arcilla por la sede (las de Sudamérica y Europa en arcilla), el resto
// dura. Cambiar si aparece una fuente.
const CLAY = /lima|santiago|buenos aires|montevideo|guayaquil|campinas|sao paulo|são paulo|florianopolis|cordoba|córdoba|bogota|bogotá|medellin|medellín|cali\b|asuncion|asunción|tigre|temuco|santa cruz|la paz|santa fe|piracicaba|rosario|concepcion|concepción|curitiba|brasilia|sarasota|tallahassee|savannah|rome|roma|naples|napoli|prague|praha|ostrava|heilbronn|bordeaux|aix|mauthausen|braunschweig|todi|perugia|milan|verona|trieste|modena|salzburg|iasi|cordenons|szczecin|genoa|genova|como\b|barletta|francavilla|sanremo|oeiras|tunis|split|zagreb|banja luka|seville|sevilla|murcia|madrid|valencia|girona|alicante|san marino|bastad|båstad|tampere|amersfoort|meerbusch|ludenscheid|lüdenscheid|liberec|pullach|poznan|poznań|bratislava|prostejov|prostějov|sibiu|cagliari|mestre|vicenza|turin|torino|bergamo|bad waltersdorf|kitzbuhel|kitzbühel|marbella|tenerife clay|skopje|belgrade|sarajevo|porto|lisbon|lisboa|estoril|knokke|troyes|blois|santos|marburg|augsburg|karlsruhe|ilkley clay/i;
export const surfaceOf = (name = '') => (CLAY.test(name) ? 'clay' : SURFACE(name));

const RET = /ret|w\.?\s?o|walk|aband/i;
const VOID = /canc|postp|susp|delay|aband/i;
const short = (n) => {
  const p = String(n ?? '').trim().split(/\s+/);
  return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : p[0] || null;
};
const iso = (esd) => {
  const s = String(esd ?? '');
  return /^\d{14}$/.test(s) ? new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00-05:00`).toISOString() : null;
};

// Un partido de singles; null en dobles o sin jugadores. level: 'challenger' o 'atp' (el Elo usa los dos).
function normEvent(st, e, level) {
  const [p1, p2] = [e.T1, e.T2];
  if (p1?.length !== 1 || p2?.length !== 1 || !p1[0]?.ID || !p2[0]?.ID) return null;
  const eps = String(e.Eps ?? '');
  const sets = [];
  for (let i = 1; i <= 5; i++) {
    const s = [num(e[`Tr1S${i}`]), num(e[`Tr2S${i}`])];
    if (s.some((v) => v == null)) break;
    const tb = [num(e[`Tr1S${i}T`]), num(e[`Tr2S${i}T`])];
    sets.push(tb.every((v) => v != null) ? [...s, ...tb] : s);
  }
  const done = eps === 'FT' || RET.test(eps);
  const state = done || VOID.test(eps) ? 'post' : eps === 'NS' ? 'pre' : 'in';
  const won = num(e.Ewt) === 1 ? 'a' : num(e.Ewt) === 2 ? 'b' : num(e.Tr1) > num(e.Tr2) ? 'a' : num(e.Tr2) > num(e.Tr1) ? 'b' : null;
  const winner = done ? won : null;
  const player = (t) => ({ id: `ls${t.ID}`, name: str(t.Nm), short: short(t.Nm), country: null, flag: null });
  return {
    id: `ls${e.Eid}`,
    date: iso(e.Esd),
    tournament: str(st.Snm),
    surface: surfaceOf(st.Snm),
    round: null,
    bestOf: 3,
    slam: false,
    state,
    a: player(p1[0]),
    b: player(p2[0]),
    winner,
    sets,
    retired: RET.test(eps) || (winner != null && sets.filter(([x, y]) => (winner === 'a' ? x > y : y > x)).length < 2),
    level,
  };
}

// Partidos de un día de LiveScore: los Challenger y, con atp, también los del circuito ATP (no WTA, ITF ni dobles).
export function normDay(body, { atp = false } = {}) {
  const out = [];
  for (const st of body?.Stages ?? []) {
    const c = String(st.Cnm ?? '');
    const level = c === 'ATP Challenger' ? 'challenger' : atp && /^ATP\b/.test(c) && !/doubles/i.test(String(st.Snm)) ? 'atp' : null;
    if (!level || /doubles/i.test(String(st.Snm))) continue;
    for (const e of st.Events ?? []) {
      const m = normEvent(st, e, level);
      if (m?.id && m.date) out.push(m);
    }
  }
  return out;
}

// Un día (YYYYMMDD, Bogotá) con ATP y Challenger. Hoy y mañana como el scoreboard (en vivo); los pasados, un día.
export const dayUrl = (yyyymmdd) => `${BASE}/${yyyymmdd}/${TZ}?MD=1`;
export async function getDay(yyyymmdd) {
  const ttl = Date.parse(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}T23:59:59-05:00`) < Date.now() - DAY ? DAY : TTL.live;
  return normDay(await fetchJson(dayUrl(yyyymmdd), ttl), { atp: true });
}

const bogota = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).replaceAll('-', '');
// Los Challenger del día (YYYY-MM-DD de Bogotá; por defecto hoy).
export async function getChallengerToday(date = null) {
  return (await getDay(date ? date.replaceAll('-', '') : bogota(Date.now()))).filter((m) => m.level === 'challenger');
}

// Snapshot de data/challenger-elo.json (scripts/challenger-snapshot.mjs): filas compactas como las de atp-elo.json,
// más el torneo y el circuito.
const SURF = { h: 'hard', c: 'clay', g: 'grass' };
let rows;
export function challengerSnapshot() {
  if (rows) return rows;
  try {
    const j = JSON.parse(readFileSync(new URL('../data/challenger-elo.json', import.meta.url), 'utf8'));
    rows = j.rows.map(([id, date, sf, a, b, winner, sets, ret, tournament, lv]) => ({ id, date, surface: SURF[sf], state: 'post', winner, retired: ret === 1,
      a: { id: a }, b: { id: b }, sets: sets ? sets.split(' ').map((x) => x.split('-').map(Number)) : [], tournament, bestOf: 3, level: lv === 'a' ? 'atp' : 'challenger' }));
  } catch {
    rows = [];
  }
  return rows;
}

// Días a pedir en vivo: desde dos antes del último partido del snapshot (o MAX_LIVE_DAYS atrás, si es más reciente)
// hasta hoy, en hora de Bogotá.
export function liveDays(snap, now = Date.now()) {
  const from = Math.max((Date.parse(snap.at(-1)?.date) || 0) - 2 * DAY, now - MAX_LIVE_DAYS * DAY);
  const days = new Set();
  for (let t = from; t < now; t += DAY) days.add(bogota(t));
  return [...days.add(bogota(now))];
}

// Historia para el Elo: el snapshot más los días que le faltan, en vivo (un día que falla se salta: el Elo pierde esos
// partidos pero los de hoy se cotizan igual).
export async function getChallengerHistory(now = Date.now()) {
  const snap = challengerSnapshot();
  const live = (await mapLimit(liveDays(snap, now), 6, (d) => getDay(d).catch(() => []))).flat();
  return finished(uniqueById([...snap, ...live]));
}
