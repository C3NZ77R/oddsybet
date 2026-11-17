// La línea de Pinnacle (la casa más afilada) por The Odds API, para los partidos que ESPN no trae con línea de DraftKings
// (jornadas de más adelante, ligas que ESPN no cubre). Mismo formato que lineOf de lib/book.mjs: insumo del modelo,
// nunca se muestra. Plan gratis: 500 créditos al mes y cada mercado cuesta 1 por llamada, así que una llamada por liga
// cada 12 h en memoria y se frena sola cuando quedan pocos.
import { fair } from './book.mjs';

const SPORT_KEY = { nba: 'basketball_nba', laliga: 'soccer_spain_la_liga', epl: 'soccer_epl', ucl: 'soccer_uefa_champs_league', libertadores: 'soccer_conmebol_copa_libertadores' };
const TTL = 12 * 3_600_000, FAIL_TTL = 10 * 60_000, MIN_CREDITS = 50, MAX_GAP = 6 * 3_600_000;
const memo = new Map(); // liga -> { at, ttl, promise de eventos }

const words = (s) => new Set(String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
// Misma palabra de 3+ letras en los dos nombres ("LA Clippers" / "Los Angeles Clippers" → clippers).
const same = (a, b) => { const w = words(b); return [...words(a)].some((x) => w.has(x)); };
// shortcut: una palabra en común basta; si una liga tiene dos equipos con el mismo apodo, exigir más (y la hora ya los separa).

// Línea de un evento de The Odds API → { ml, spread: { line /*local*/, p }, total: { line, p /*Más*/ } } sin margen, o null.
// Las líneas de cuarto (3.25) se saltan: lib/book.mjs las trataría como la media línea y sesgaría la cuota.
export function pinnacleLine(ev) {
  const book = ev?.bookmakers?.find((b) => b.key === 'pinnacle');
  if (!book) return null;
  const outs = (k) => book.markets?.find((m) => m.key === k)?.outcomes ?? [];
  const get = (k, name) => outs(k).find((o) => o.name === name);
  const half = (x) => Number.isFinite(x) && (x * 4) % 2 === 0;
  const [h, d, a] = [get('h2h', ev.home_team), get('h2h', 'Draw'), get('h2h', ev.away_team)];
  const ml = fair([h?.price, ...(d ? [d.price] : []), a?.price]);
  const [sh, sa, over, under] = [get('spreads', ev.home_team), get('spreads', ev.away_team), get('totals', 'Over'), get('totals', 'Under')];
  const sp = half(sh?.point) ? fair([sh.price, sa?.price]) : null;
  const tp = half(over?.point) ? fair([over.price, under?.price]) : null;
  const out = { ...(ml && { ml }), ...(sp && { spread: { line: sh.point, p: sp[0] } }), ...(tp && { total: { line: over.point, p: tp[0] } }) };
  return Object.keys(out).length ? out : null;
}

function eventsOf(league, { key, fetch, now }) {
  const hit = memo.get(league);
  if (hit && now() - hit.at < hit.ttl) return hit.promise;
  const markets = SPORT_KEY[league].startsWith('basketball') ? 'h2h,spreads,totals' : 'h2h,totals';
  const url = `https://api.the-odds-api.com/v4/sports/${SPORT_KEY[league]}/odds/?apiKey=${key}&bookmakers=pinnacle&markets=${markets}&oddsFormat=decimal`;
  const entry = { at: now(), ttl: TTL };
  entry.promise = fetch(url, { signal: AbortSignal.timeout(8000) }).then(async (res) => {
    if (!res.ok) throw new Error(`The Odds API ${res.status}`);
    // Con pocos créditos se espera un día entre llamadas: mejor sin línea que sin créditos para el resto del mes.
    if (Number(res.headers.get('x-requests-remaining')) < MIN_CREDITS) entry.ttl = 24 * 3_600_000;
    return res.json();
  }).catch(() => Object.assign(entry, { ttl: FAIL_TTL }) && []);
  memo.set(league, entry);
  return entry.promise;
}

// Líneas de Pinnacle por id de partido de ESPN, { close }: solo los partidos que se piden. Sin clave o sin liga, vacío.
export async function pinnacleLines(league, games, { key = process.env.ODDS_API_KEY ?? process.env.COFLAS_ODDS_API_KEY, fetch = globalThis.fetch, now = Date.now } = {}) {
  const out = new Map();
  if (!key || !SPORT_KEY[league] || !games?.length) return out;
  const events = await eventsOf(league, { key, fetch, now });
  for (const g of games) {
    const t = Date.parse(g.start);
    const ev = events.find((e) => Math.abs(Date.parse(e.commence_time) - t) <= MAX_GAP && same(e.home_team, g.home?.name) && same(e.away_team, g.away?.name));
    const line = ev && pinnacleLine(ev);
    if (line) out.set(g.id, { close: line, open: null });
  }
  return out;
}
export const _reset = () => memo.clear();
