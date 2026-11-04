// Registro de picks de Mejores apuestas: congela cada pick antes de su partido, lo cierra con el resultado de ESPN,
// reconstruye el pasado para aprender (relleno) y arma el registro público. Lo dispara pg_cron de Supabase: POST
// /api/picklog/tick cada 15 min y /api/picklog/learn a diario. Las dependencias se inyectan para probar sin red;
// picklogFromEnv arma las reales. Spec: docs/superpowers/specs/2026-11-03-registro-picks-design.md
import { createHash, timingSafeEqual } from 'node:crypto';
import { LEAGUES, leagueById } from '../public/leagues.js';
import { getGames } from './espn.mjs';
import { getToday } from './tennis.mjs';
import { getPicks, getTennisGames } from './markets.mjs';
import { learnModel, currentModel, LEARN } from './learn.mjs';
import { dbFromEnv } from './db.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const FREEZE_MS = 3 * HOUR; // se congela desde 3 h antes del inicio; la última foto antes del inicio gana
export const SETTLE_AFTER_MS = 2 * HOUR;
export const VOID_AFTER_MS = 3 * DAY;
export const BACKFILL_DAYS = 120;
export const BACKFILL_STEPS = 8; // días por tick: el relleno no puede ir en ráfagas (ESPN responde 403 a las ráfagas)
export const BUDGET_MS = 40_000; // del tick, contra los 60 s de Vercel
const PICKS_TIMEOUT_MS = 50_000;

// Día en Colombia (UTC−5, sin horario de verano): 'YYYY-MM-DD' y 'YYYYMMDD' (el parámetro dates de ESPN).
export const dayOf = (ms) => new Date(ms - 5 * HOUR).toISOString().slice(0, 10);
const ymd = (ms) => dayOf(ms).replaceAll('-', '');
const msOf = (date) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T12:00:00-05:00`);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ---------- calificar ----------
const VOID_NAME = /POSTPONED|CANCELED|CANCELLED|SUSPENDED|ABANDONED|FORFEIT/;
const EXTRA_TIME = /FINAL_AET|FINAL_PEN/; // fútbol: los mercados son a 90 minutos y el scoreboard trae el marcador final
const TOTALS = { ou: 1, ou_sets: 1, ou_games: 1, ou_set1: 1 };
const sum = (xs) => xs.reduce((s, v) => s + v, 0);

// Margen desde el lado 0 (Local/A/Más/Sí) o el propio: > 0 ganó por eso, < 0 perdió, 0 devolvió. null: no se califica.
function marginOf({ sport, market, side, line }, r) {
  const total = (t) => (side ? line - t : t - line);
  const diff = (d) => (side ? -d : d);
  if (sport === 'tennis') {
    const s1 = r.sets[0], a = r.sets.filter((s) => s[0] > s[1]).length, b = r.sets.length - a;
    const ga = sum(r.sets.map((s) => s[0])), gb = sum(r.sets.map((s) => s[1]));
    return { ml: diff(a - b), first_set: diff(s1[0] - s1[1]), games_hcp: diff(ga - gb) + line, ou_sets: total(r.sets.length),
      ou_games: total(ga + gb), ou_set1: total(s1[0] + s1[1]) }[market] ?? null;
  }
  const d = r.home - r.away;
  if (market in TOTALS) return total(r.home + r.away);
  const both = r.home > 0 && r.away > 0;
  return {
    '1x2': [d, d === 0 ? 1 : -Math.abs(d), -d][side],
    dc: [d + 0.5, Math.abs(d) - 0.5, -d + 0.5][side],
    dnb: diff(d),
    btts: side ? (both ? -Math.min(r.home, r.away) : 1) : (both ? 1 : -[r.home, r.away].filter((v) => v === 0).length),
    ml: diff(d),
    spread: diff(d) + line,
  }[market] ?? null;
}

function voidOf(sport, r) {
  if (sport === 'tennis') return r.retired ? 'Retiro o walkover: anulada' : !r.winner || !r.sets?.length ? 'ESPN no dio el resultado' : null;
  if (VOID_NAME.test(r.name ?? '')) return 'Partido aplazado o cancelado';
  if (sport === 'soccer' && EXTRA_TIME.test(r.name ?? '')) return 'Fue a prórroga: los mercados son a 90 minutos';
  return Number.isFinite(r.home) && Number.isFinite(r.away) ? null : 'ESPN no dio el resultado';
}

// r: { home, away, name } (goles o puntos y status.name de ESPN) o { sets, winner, retired } en tenis.
export function gradePick(pick, r) {
  const why = voidOf(pick.sport, r);
  if (why) return { status: 'nula', margin: null, reason: why };
  const margin = marginOf({ ...pick, line: pick.line == null ? null : Number(pick.line) }, r);
  if (!Number.isFinite(margin)) return { status: 'nula', margin: null, reason: 'Mercado sin calificación' };
  if (margin === 0) return { status: 'nula', margin, reason: 'Devuelta: quedó justo en la línea' };
  return { status: margin > 0 ? 'ganada' : 'perdida', margin, reason: null };
}

export const scoreOf = (r) => (r.sets ? r.sets.map((s) => `${s[0]}-${s[1]}`).join(' ') : `${r.home}-${r.away}`);

const SET_MARKETS = new Set(['ml', 'ou_sets']); // en tenis se miden en sets; los demás en games
// Una frase por pick perdido: por poco o lejos, y las señales raras que tenía.
export function reasonOf({ sport, market, x }, margin) {
  const miss = Math.ceil(Math.abs(margin)); // goles, puntos, sets o games que faltaron para ganarlo
  const [near, one, many] = sport === 'soccer' ? [1, 'gol', 'goles'] : sport === 'basketball' ? [5, 'punto', 'puntos']
    : SET_MARKETS.has(market) ? [1, 'set', 'sets'] : [2, 'game', 'games'];
  const parts = [miss <= near ? `Se perdió por poco (por ${miss} ${miss === 1 ? one : many})` : 'Resultado lejos de lo esperado'];
  if ((x?.few ?? 0) >= 0.5) parts.push('inicio de temporada: pocos partidos para medir');
  if ((x?.abs ?? 0) >= 0.4) parts.push('bajas importantes');
  return parts.join('; ');
}

const graded = (row, r, now) => {
  const g = gradePick(row, r);
  return { ...row, status: g.status, margin: g.margin, score: scoreOf(r), reason: g.status === 'perdida' ? reasonOf(row, g.margin) : g.reason,
    settledAt: new Date(now).toISOString() };
};

// ---------- filas ----------
// Todas con las mismas claves (PostgREST lo exige en un insert de varias filas).
const rowOf = (lg, date, game, x, p, source) => ({
  id: `${lg.id}:${game.id}:${p.market}`, source, league: lg.id, sport: lg.sport, gameId: game.id, espnDate: date, gameStart: game.start,
  home: game.home?.name ?? null, away: game.away?.name ?? null, market: p.market, label: p.label, name: p.name, side: p.side,
  line: p.line ?? null, pRaw: p.raw ?? p.p, p: p.p, minOdds: p.minOdds, x: x ?? {}, featured: Boolean(p.featured),
});
const gradable = (p) => Number.isInteger(p.side) && p.side >= 0; // una respuesta vieja de la CDN, sin side, no se guarda

// ---------- el tick ----------
// Congelar: ligas y fechas con partidos en pre que empiezan en menos de 3 h. Cada una pide sus picks aparte y en paralelo.
async function freeze(deps, now) {
  const dates = [...new Set([ymd(now), ymd(now + DAY)])];
  const boards = await Promise.all(LEAGUES.flatMap((lg) => dates.map(async (date) => ({ lg, date, games: await deps.games(lg, date).catch(() => []) }))));
  const due = boards.map((b) => ({ ...b, games: b.games.filter((g) => g.status?.state === 'pre' && Date.parse(g.start) > now && Date.parse(g.start) - now <= FREEZE_MS) }))
    .filter((b) => b.games.length);
  const counts = await Promise.all(due.map(async ({ lg, date, games }) => {
    try {
      const { data } = await deps.picks(lg, date);
      let n = 0;
      for (const g of games) {
        const item = data?.find((d) => d.gameId === g.id);
        if (!item) continue;
        const rows = item.picks.filter(gradable).map((p) => rowOf(lg, date, g, item.x, p, 'live'));
        await deps.db.upsertPicks(rows);
        await deps.db.dropMissing(lg.id, g.id, rows.map((r) => r.id));
        n += rows.length;
      }
      return n;
    } catch (err) {
      console.error('picklog: no se congeló', lg.id, date, err.message);
      return 0;
    }
  }));
  return sum(counts);
}

// Cerrar: pendientes que empezaron hace más de 2 h, un scoreboard por liga y fecha de ESPN.
async function settle(deps, now, left) {
  const groups = new Map();
  for (const row of await deps.db.pendingPicks(new Date(now - SETTLE_AFTER_MS).toISOString())) {
    const key = `${row.league}|${row.espnDate}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(row);
  }
  let n = 0;
  for (const rows of groups.values()) {
    if (!left()) break;
    const lg = leagueById(rows[0].league);
    const results = lg ? await deps.results(lg, rows[0].espnDate).catch(() => new Map()) : new Map();
    const done = rows.map((row) => (results.has(row.gameId) ? graded(row, results.get(row.gameId), now)
      : now - Date.parse(row.gameStart) > VOID_AFTER_MS ? { ...row, status: 'nula', margin: null, score: null, reason: 'ESPN no dio el resultado', settledAt: new Date(now).toISOString() }
        : null)).filter(Boolean);
    if (done.length) await deps.db.upsertPicks(done);
    n += done.length;
  }
  return n;
}

// Rellenar: una liga entera hacia atrás (de ayer a 120 días antes del primer relleno) y después la siguiente, así cada
// tick reusa los calendarios de ESPN que ya bajó. Un día por paso, hasta BACKFILL_STEPS por tick. Solo para aprender.
const nextStep = (st) => (st.day > st.until ? { ...st, day: ymd(msOf(st.day) - DAY), fails: 0 } : { ...st, league: st.league + 1, day: st.from, fails: 0 });
async function backfill(deps, now, left) {
  let st = await deps.db.getState();
  if (!st?.from) st = { league: 0, day: ymd(now - DAY), from: ymd(now - DAY), until: ymd(now - BACKFILL_DAYS * DAY), fails: 0 };
  let n = 0;
  for (let step = 0; st.league < LEAGUES.length && step < BACKFILL_STEPS && left(); step++) {
    const lg = LEAGUES[st.league];
    try {
      const [{ data }, games, results] = await Promise.all([deps.pastPicks(lg, st.day), deps.games(lg, st.day), deps.results(lg, st.day)]);
      const rows = [];
      for (const item of data ?? []) {
        const g = games.find((x) => x.id === item.gameId);
        if (!g || !results.has(item.gameId)) continue;
        for (const p of item.picks.filter(gradable)) rows.push(graded(rowOf(lg, st.day, g, item.x, p, 'backfill'), results.get(item.gameId), now));
      }
      await deps.db.insertPicks(rows);
      n += rows.length;
      st = nextStep(st);
    } catch (err) {
      // ESPN o Supabase caídos: se reintenta en el próximo tick; a las 3 fallas seguidas ese paso se salta.
      console.error('picklog: relleno', lg.id, st.day, err.message);
      st = st.fails + 1 >= 3 ? nextStep(st) : { ...st, fails: st.fails + 1 };
      await deps.db.setState(st);
      break;
    }
    await deps.db.setState(st);
  }
  return n;
}

export async function runTick(deps, { now = Date.now(), budgetMs = BUDGET_MS } = {}) {
  const start = Date.now(), left = () => Date.now() - start < budgetMs;
  const frozen = await freeze(deps, now);
  const settled = await settle(deps, now, left);
  const backfilled = left() ? await backfill(deps, now, left) : 0;
  return { frozen, settled, backfilled, ms: Date.now() - start };
}

// ---------- aprender ----------
export async function runLearn({ db }, { now = Date.now() } = {}) {
  const since = new Date(now - LEARN.days * DAY).toISOString();
  const bySport = {};
  for (const sport of new Set(LEAGUES.map((l) => l.sport))) {
    const rows = await db.rowsSince({ since, sport, settled: true, select: 'league,market,p_raw,x,status,game_start' });
    bySport[sport] = rows.map((r) => ({ league: r.league, market: r.market, pRaw: Number(r.pRaw), x: r.x ?? {}, won: r.status === 'ganada', gameStart: r.gameStart }));
  }
  const model = learnModel(bySport, { now });
  await db.saveModel(model);
  return Object.fromEntries(Object.entries(model.sports).map(([s, m]) => [s, { status: m.status, n: m.n, llBase: m.llBase ?? null, llModel: m.llModel ?? null }]));
}

// ---------- registro público ----------
const tally = (rows) => {
  const won = rows.filter((r) => r.status === 'ganada').length, lost = rows.filter((r) => r.status === 'perdida').length;
  const closed = rows.filter((r) => r.status === 'ganada' || r.status === 'perdida');
  return { won, lost, voided: rows.filter((r) => r.status === 'nula').length,
    promised: closed.length ? r4(sum(closed.map((r) => Number(r.p))) / closed.length) : null, hit: closed.length ? r4(won / closed.length) : null };
};

// rows: filas live de la liga (31 días); model: el último pick_model. Solo los picks del partido cuentan en el "7 de 10".
export function recordOf(rows, model, league, now = Date.now()) {
  const live = rows.filter((r) => r.source === 'live');
  const dayKey = (r) => dayOf(Date.parse(r.gameStart));
  const since = live.length ? dayOf(Math.min(...live.map((r) => Date.parse(r.gameStart)))) : null;
  const featured = live.filter((r) => r.featured);
  const today = dayOf(now), week = dayOf(now - 7 * DAY);
  const last = [...new Set(featured.filter((r) => r.status !== 'pendiente').map(dayKey))].filter((d) => d < today && d >= week).sort().at(-1) ?? null;
  const within = (rs, days) => rs.filter((r) => Date.parse(r.gameStart) >= now - days * DAY);
  const shown = within(live.filter((r) => Number(r.p) >= 0.5), 30);
  const byMarket = new Map();
  for (const r of shown) (byMarket.get(r.market) ?? byMarket.set(r.market, []).get(r.market)).push(r);
  const s = model?.sports?.[leagueById(league)?.sport];
  return {
    since,
    day: last && { date: last, yesterday: last === dayOf(now - DAY), picks: featured.filter((r) => dayKey(r) === last).sort((a, b) => a.gameStart.localeCompare(b.gameStart))
      .map((r) => ({ home: r.home, away: r.away, market: r.market, label: r.label, name: r.name, line: r.line, p: Number(r.p), status: r.status, score: r.score, reason: r.reason })) },
    windows: [7, 30].map((days) => ({ days, ...tally(within(featured, days)) })),
    all: { days: 30, ...tally(shown) },
    markets: [...byMarket].map(([market, rs]) => ({ market, ...tally(rs) })).map(({ market, won, lost, promised, hit }) => ({ market, n: won + lost, promised, hit }))
      .filter((m) => m.n).sort((a, b) => b.n - a.n),
    model: s ? { at: model.at, status: s.status, n: s.n, nTest: s.nTest, llBase: s.llBase ?? null, llModel: s.llModel ?? null } : null,
  };
}

export async function getRecord(db, league, { now = Date.now() } = {}) {
  const [rows, model] = await Promise.all([db.rowsSince({ since: new Date(now - 31 * DAY).toISOString(), league, source: 'live' }), db.latestModel().catch(() => null)]);
  return recordOf(rows, model, league, now);
}

// ---------- dependencias reales ----------
export const sameSecret = (a, b) => {
  const h = (s) => createHash('sha256').update(String(s ?? '')).digest();
  return Boolean(a && b) && timingSafeEqual(h(a), h(b));
};

// Resultados terminados de una liga y fecha de ESPN. Tenis: ese día y el siguiente (la lluvia corre partidos).
async function resultsOf(lg, date) {
  if (lg.sport === 'tennis') {
    const days = [date, ymd(msOf(date) + DAY)].map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);
    const ms = (await Promise.all(days.map((d) => getToday(d).catch(() => [])))).flat();
    return new Map(ms.filter((m) => m.state === 'post').map((m) => [m.id, { sets: m.sets, winner: m.winner, retired: m.retired }]));
  }
  const games = await getGames(lg.id, date);
  return new Map(games.filter((g) => g.status?.state === 'post').map((g) => [g.id, { home: g.home?.score, away: g.away?.score, name: g.status.name }]));
}

// Lo que sirve la CDN en producción (lo que ve la gente): los mismos parámetros en el mismo orden que la vista.
async function servedPicks(host, lg, date) {
  const res = await fetch(`https://${host}/api/picks?league=${lg.id}&date=${date}`, { signal: AbortSignal.timeout(PICKS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`/api/picks respondió ${res.status}`);
  return res.json();
}

export function picklogFromEnv(env = process.env) {
  const db = dbFromEnv(env);
  if (!db || !env.TRACK_TICK_SECRET) return null;
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  const deps = {
    db,
    games: (lg, date) => (lg.sport === 'tennis' ? getTennisGames(date) : getGames(lg.id, date)),
    results: resultsOf,
    picks: host ? (lg, date) => servedPicks(host, lg, date) : async (lg, date) => getPicks(lg.id, { date, model: await currentModel({ db }) }),
    pastPicks: (lg, date) => getPicks(lg.id, { date }),
  };
  return { secret: env.TRACK_TICK_SECRET, tick: () => runTick(deps), learn: () => runLearn(deps), record: (league) => getRecord(db, league) };
}
