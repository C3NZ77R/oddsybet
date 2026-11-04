// Capa de datos de ESPN (JSON público, sin clave): normalizadores puros (testeados con fixtures en test/fixtures/)
// y envoltorios de fetch con caché en memoria por URL. Todo lo que llega de ESPN es dato no confiable: solo se
// copian campos conocidos, como texto o número; la UI los escapa al pintarlos.
import { leagueById } from '../public/leagues.js';
import { STATS, statOf } from '../public/stats.js';
import { progress, stopOf, clockSecs } from '../public/live.js';
import { normPlays } from './plays.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
export const TTL = { live: 15_000, board: 5 * 60_000, slow: 30 * 60_000, sched: 6 * 3_600_000 };
const TIMEOUT_MS = 8000;
const CACHE_MAX = 300; // los summary de ESPN pesan hasta ~600 KB: tope de memoria

// ---------- fetch con caché ----------
const cache = new Map(); // url -> { at, ttl, promise }

export const httpError = (status, message) => Object.assign(new Error(message), { status });

// ttl puede ser un número o una función del cuerpo (p. ej. 60 s si hay un partido en vivo).
export async function fetchJson(url, ttl = TTL.board) {
  const hit = cache.get(url);
  // Un TTL numérico también acota la edad de lo que se sirve: una entrada de 5 min no le sirve a quien pidió 15 s.
  if (hit && Date.now() - hit.at < (typeof ttl === 'number' && ttl > 0 ? Math.min(hit.ttl, ttl) : hit.ttl)) return hit.promise;
  const promise = (async () => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw httpError(504, err?.name === 'TimeoutError' ? `ESPN no respondió en ${TIMEOUT_MS / 1000} s` : 'No se pudo conectar con ESPN');
    }
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `ESPN respondió ${res.status}`);
    const body = await res.json().catch(() => {
      throw httpError(502, 'ESPN devolvió una respuesta que no es JSON');
    });
    return body;
  })();
  if (ttl === 0) return promise; // sin caché: quien llama guarda una versión reducida (calendarios de varios MB)
  const entry = { at: Date.now(), ttl: typeof ttl === 'number' ? ttl : TTL.board, promise };
  cache.delete(url); // el Map desaloja por orden de inserción: sin esto, la entrada recién renovada saldría primero
  cache.set(url, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  promise.then((v) => { if (typeof ttl === 'function') entry.ttl = ttl(v); }, () => cache.delete(url));
  return promise;
}

const soft = (p) => p.catch(() => null); // datos complementarios: si fallan, la sección queda vacía

// ---------- utilidades puras ----------
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/^[ou+]/i, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? null : String(v));
const iso = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const shortName = (a) => a.shortName || (a.firstName && a.lastName ? `${a.firstName[0]}. ${a.lastName}` : a.displayName || a.fullName || null);
const idFromLinks = (a) => {
  for (const l of a?.links ?? []) {
    const m = /\/id\/(\d+)/.exec(l?.href ?? '');
    if (m) return m[1];
  }
  return /\/players\/full\/(\d+)\./.exec(a?.headshot?.href ?? '')?.[1] ?? null;
};

export function normAthlete(a, team = null) {
  if (!a) return null;
  return {
    id: str(a.id ?? idFromLinks(a)),
    name: a.displayName || a.fullName || null,
    short: shortName(a),
    pos: a.position?.abbreviation ?? null,
    jersey: str(a.jersey ?? null),
    headshot: a.headshot?.href ?? null,
    teamId: str(team?.id ?? a.team?.id ?? null),
    teamAbbr: team?.abbreviation ?? team?.abbr ?? a.team?.abbreviation ?? null,
  };
}

// ---------- partidos ----------
const recordOf = (c) => {
  const list = c.records ?? c.record ?? [];
  const r = Array.isArray(list) ? list.find((x) => x?.type === 'total' || x?.name === 'overall') ?? list[0] : null;
  return r?.summary ?? null;
};

export function normTeam(c, state) {
  const t = c?.team ?? {};
  const score = state === 'pre' ? null : num(typeof c?.score === 'object' ? c.score?.value ?? c.score?.displayValue : c?.score);
  return {
    id: str(t.id ?? c?.id),
    abbr: t.abbreviation ?? null,
    name: t.displayName ?? t.name ?? null,
    logo: t.logo ?? t.logos?.[0]?.href ?? null,
    record: recordOf(c ?? {}),
    score,
    color: /^[0-9a-f]{6}$/i.test(t.color ?? '') ? `#${t.color}` : null,
  };
}

// comp = competitions[0] (scoreboard) o header.competitions[0] (summary). Sin las cuotas de casas de ESPN (Ruling 11).
function gameFrom(id, comp, status, league) {
  const state = status?.type?.state ?? 'pre';
  const side = (ha) => comp?.competitors?.find((c) => c.homeAway === ha);
  return {
    id: str(id),
    league,
    start: iso(comp?.date),
    status: { state, detail: status?.type?.shortDetail ?? status?.type?.detail ?? null, name: str(status?.type?.name) }, // name: 'STATUS_POSTPONED', etc.
    home: normTeam(side('home'), state),
    away: normTeam(side('away'), state),
    neutral: comp?.neutralSite === true, // sede neutral: el modelo no da ventaja local
  };
}

export const normEvent = (ev, league) => gameFrom(ev.id, ev.competitions?.[0], ev.status ?? ev.competitions?.[0]?.status, league);

export const normScoreboard = (json, league) => (json?.events ?? []).map((e) => normEvent(e, league));

// ---------- detalle del partido ----------
const REC_LABELS = { overall: 'General', home: 'Local', road: 'Visita', vsdiv: 'División', vsconf: 'Conferencia', lasttengames: 'Últimos 10' };
const REC_KEYS = { total: 'overall', homerecord: 'home', awayrecord: 'road' };
const recItem = (r) => {
  const t = String(r.type || r.name || '').toLowerCase();
  const key = REC_KEYS[t] ?? t;
  return r.summary ? { key, label: REC_LABELS[key] ?? r.displayName ?? r.name ?? key, summary: String(r.summary) } : null;
};
export const normRecords = (json) => (Array.isArray(json) ? json : json?.items ?? []).map(recItem).filter(Boolean);

// summary.againstTheSpread[i].records (casi siempre vacío hoy; formato genérico por si ESPN lo vuelve a llenar).
const normAtsSummary = (records) => (records ?? []).map((r) => (r?.summary ? { key: String(r.type || r.id || r.name || 'ats'), label: r.displayName || r.description || 'ATS', summary: String(r.summary) } : null)).filter(Boolean);

// Estadísticas de equipo (core API) seleccionadas por deporte: [categoría|null, nombre, etiqueta, nombre del ranking?, por partido?]
const TEAM_STATS = {
  basketball: [
    [null, 'avgPoints', 'Puntos por partido', 'points'], [null, 'fieldGoalPct', 'FG%'], [null, 'twoPointFieldGoalPct', '2P%'],
    [null, 'threePointFieldGoalPct', '3P%'], [null, 'freeThrowPct', 'TL%'], [null, 'effectiveFGPct', 'eFG%'], [null, 'trueShootingPct', 'TS%'],
    [null, 'avgRebounds', 'Rebotes por partido'], [null, 'avgOffensiveRebounds', 'Rebotes ofensivos', 'offensiveRebounds'],
    [null, 'avgAssists', 'Asistencias por partido', 'assists'], [null, 'avgSteals', 'Robos por partido', 'steals'],
    [null, 'avgBlocks', 'Tapones por partido', 'blocks'], [null, 'avgTurnovers', 'Pérdidas por partido', 'turnovers'],
    [null, 'assistTurnoverRatio', 'AST/TO'], [null, 'paceFactor', 'Ritmo'], [null, 'pointsInPaint', 'Puntos en la pintura', null, true],
    [null, 'fastBreakPoints', 'Puntos de contraataque', null, true],
  ],
  soccer: [
    [null, 'avgGoals', 'Goles por partido'], [null, 'avgGoalsConceded', 'Goles recibidos por partido'], [null, 'possessionPct', 'Posesión %'],
    [null, 'totalShots', 'Tiros por partido', null, true], [null, 'shotsOnTarget', 'Tiros a puerta por partido', null, true],
    [null, 'passPct', '% de pases'], [null, 'wonCorners', 'Córners por partido', null, true], [null, 'avgExpectedGoals', 'xG por partido'],
    [null, 'cleanSheet', 'Vallas invictas'], [null, 'yellowCards', 'Tarjetas amarillas'],
  ],
};

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 3 : 1));
export function normTeamStats(json, sport) {
  const cats = json?.splits?.categories ?? [];
  const find = (cat, name) => (cat ? cats.filter((c) => c.name === cat) : cats).flatMap((c) => c.stats ?? []).find((s) => s.name === name);
  const games = ['gamesPlayed', 'teamGamesPlayed', 'appearances', 'games'].map((n) => find(null, n)?.value).find((v) => v > 0);
  return (TEAM_STATS[sport] ?? []).flatMap(([cat, name, label, rankName, perGame]) => {
    const s = find(cat, name);
    if (!s || !Number.isFinite(s.value)) return [];
    const value = perGame ? (games ? s.value / games : null) : s.value;
    if (value == null) return [];
    const rank = s.rank ?? (rankName ? find(cat, rankName)?.rank : null) ?? null;
    return [{ key: cat ? `${cat}.${name}` : name, label, value, display: perGame ? fmt(value) : s.displayValue ?? fmt(value), rank }];
  });
}
// Respaldo: estadísticas de equipo que trae el propio summary (sin ranking).
export function normBoxTeamStats(list) {
  return (list ?? []).flatMap((s) => (Array.isArray(s.stats) ? s.stats.map((x) => ({ ...x, name: `${s.name}.${x.name}` })) : [s]))
    .map((s) => ({ key: s.name, label: s.label || s.displayName || s.abbreviation || s.name, value: num(s.value ?? s.displayValue), display: s.displayValue ?? null, rank: s.rank ?? null }))
    .filter((s) => s.key && s.display != null);
}

function normLastFive(list) {
  return (list?.events ?? []).map((e) => {
    const home = e.atVs === 'vs' || (e.homeTeamId != null && String(e.homeTeamId) === String(list.team?.id));
    const ts = num(home ? e.homeTeamScore : e.awayTeamScore), os = num(home ? e.awayTeamScore : e.homeTeamScore);
    return {
      eventId: str(e.id), date: iso(e.gameDate), opp: { id: str(e.opponent?.id), abbr: e.opponent?.abbreviation ?? null, logo: e.opponent?.logo ?? null },
      home, score: ts != null && os != null ? `${ts}-${os}` : e.score ?? null, result: e.gameResult === 'D' ? 'T' : e.gameResult ?? null,
    };
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

const normInjury = (i, team) => {
  const d = i.details ?? {};
  const spec = (v) => (v && v !== 'Not Specified' ? v : null);
  return {
    teamId: str(team?.id ?? i.athlete?.team?.id ?? null),
    teamAbbr: team?.abbreviation ?? i.athlete?.team?.abbreviation ?? null,
    athlete: normAthlete(i.athlete, team ?? i.athlete?.team),
    status: i.status ?? i.type?.description ?? null,
    detail: [spec(d.type), spec(d.side), spec(d.detail)].filter(Boolean).join(' · ') || i.shortComment || null,
    comment: i.shortComment ?? null,
    returnDate: d.returnDate ?? null,
    date: iso(i.date),
  };
};
// /injuries de la liga: [{ id, displayName, injuries: [...] }] o summary.injuries: [{ team, injuries: [...] }]
export const normInjuries = (list) => (list ?? []).flatMap((t) => (t.injuries ?? []).map((i) => normInjury(i, t.team ?? i.athlete?.team ?? { id: t.id })));

export function normRoster(json) {
  const team = json?.team ? { id: json.team.id, abbreviation: json.team.abbreviation } : null;
  const list = (json?.athletes ?? []).flatMap((g) => (Array.isArray(g.items) ? g.items : [g]));
  return list.map((a) => normAthlete(a, team)).filter((a) => a?.id);
}

function startersFrom(json) {
  const out = {};
  for (const p of json?.boxscore?.players ?? []) {
    const list = (p.statistics?.[0]?.athletes ?? []).filter((a) => a.starter).map((a) => normAthlete(a.athlete, p.team));
    if (list.length) out[String(p.team?.id)] = list;
  }
  for (const r of json?.rosters ?? []) {
    const list = (r.roster ?? []).filter((a) => a.starter).map((a) => normAthlete({ ...a.athlete, position: a.position ?? a.athlete?.position, jersey: a.jersey ?? a.athlete?.jersey }, r.team));
    if (list.length && r.team?.id) out[String(r.team.id)] = list;
  }
  return out;
}

const summaryRosters = (json) => Object.fromEntries((json?.rosters ?? []).filter((r) => r.team?.id).map((r) => [String(r.team.id), (r.roster ?? []).map((a) => normAthlete({ ...a.athlete, position: a.position ?? a.athlete?.position, jersey: a.jersey ?? a.athlete?.jersey }, r.team))]));

// summary + datos complementarios (cada uno opcional, ya pedido por el wrapper) → GameDetail.
// extra = { rosters: {home, away}, records: {home, away}, stats: {home, away} } con el JSON crudo de ESPN.
// ATS: solo summary.againstTheSpread (hoy casi siempre vacío → null). El endpoint core odds-records se descartó porque sus
// cifras no cuadran con los récords reales de los equipos.
export function normSummary(json, league, extra = {}) {
  const lg = leagueById(league);
  const comp = json?.header?.competitions?.[0];
  const game = gameFrom(json?.header?.id ?? comp?.id, comp, comp?.status, league);
  const ids = { home: game.home.id, away: game.away.id };
  const both = (fn) => ({ home: fn('home'), away: fn('away') });
  const byTeam = (list, getId) => both((s) => list?.find((x) => String(getId(x)) === ids[s]));
  const headerComp = byTeam(comp?.competitors, (c) => c.id ?? c.team?.id);

  const starters = startersFrom(json);
  const sumRosters = summaryRosters(json);
  const box = byTeam(json?.boxscore?.teams, (t) => t.team?.id);
  const ats = byTeam(json?.againstTheSpread, (t) => t.team?.id);
  const atsBoth = both((s) => normAtsSummary(ats[s]?.records));
  const pred = json?.predictor;
  const pct = (v) => (num(v) == null ? null : Math.round(num(v) * 10) / 1000);
  const recordsOf = (s) => {
    const core = normRecords(extra.records?.[s]);
    return core.length ? core : normRecords(headerComp[s]?.record);
  };
  const statsOf = (s) => {
    const core = normTeamStats(extra.stats?.[s], lg?.sport);
    return core.length ? core : normBoxTeamStats(box[s]?.statistics);
  };
  const rosterOf = (s) => {
    const r = extra.rosters?.[s] ? normRoster(extra.rosters[s]) : [];
    return r.length ? r : sumRosters[ids[s]] ?? [];
  };
  const l5 = byTeam(json?.lastFiveGames, (t) => t.team?.id);
  return {
    ...game,
    injuries: normInjuries(json?.injuries),
    rosters: both(rosterOf),
    starters: starters[ids.home] || starters[ids.away] ? { home: starters[ids.home] ?? [], away: starters[ids.away] ?? [] } : null,
    teamStats: both(statsOf),
    teamStatsSeason: num(/\/seasons\/(\d{4})/.exec(extra.stats?.home?.season?.$ref ?? extra.stats?.away?.season?.$ref ?? '')?.[1]), // puede ser la temporada anterior si la actual aún no tiene datos
    records: both(recordsOf),
    ats: atsBoth.home.length || atsBoth.away.length ? atsBoth : null,
    lastFive: both((s) => normLastFive(l5[s])),
    predictor: pred?.homeTeam && pct(pred.homeTeam.gameProjection) != null
      ? { homeWinPct: pct(pred.homeTeam.gameProjection), awayWinPct: pct(pred.awayTeam?.gameProjection) ?? Math.round((1 - pct(pred.homeTeam.gameProjection)) * 1000) / 1000 }
      : null,
    publicBetting: null, // no hay fuente gratuita del % de apuestas / dinero del público
  };
}

// ---------- game logs ----------
const NAME_MAP = {
  basketball: {
    minutes: 'min', points: 'pts', totalRebounds: 'reb', offensiveRebounds: 'oreb', defensiveRebounds: 'dreb', assists: 'ast', steals: 'stl',
    blocks: 'blk', turnovers: 'to', fouls: 'pf', fieldGoalsMade: 'fgm', fieldGoalsAttempted: 'fga', threePointFieldGoalsMade: '3pm',
    threePointFieldGoalsAttempted: '3pa', freeThrowsMade: 'ftm', freeThrowsAttempted: 'fta',
  },
  soccer: { totalGoals: 'goals', goalAssists: 'assists', totalShots: 'shots', shotsOnTarget: 'sot', foulsCommitted: 'fc', foulsSuffered: 'fs', offsides: 'off', yellowCards: 'yc', redCards: 'rc' },
};

const statValue = (key, raw) => {
  const s = String(raw ?? '').trim();
  if (key === 'min' && /^\d+:\d\d$/.test(s)) { const [m, sec] = s.split(':').map(Number); return Math.round((m + sec / 60) * 100) / 100; }
  return num(s);
};

const SKIP_SEASON = /preseason|pretemporada|all-star/i;

// Un game log de ESPN (una temporada) → partidos normalizados, del más reciente al más antiguo.
export function normGamelog(json, sport, season = num(json?.filters?.find((f) => f.name === 'season')?.value)) {
  const names = json?.names ?? [];
  const map = NAME_MAP[sport] ?? {};
  const out = [];
  for (const st of json?.seasonTypes ?? []) {
    if (SKIP_SEASON.test(st.displayName ?? '')) continue;
    for (const cat of st.categories ?? []) {
      for (const ev of cat.type === 'event' ? cat.events ?? [] : []) {
        const meta = json.events?.[ev.eventId];
        if (!meta || meta.team?.isAllStar) continue;
        const stats = {};
        names.forEach((n, i) => {
          const parts = n.split('-'), vals = String(ev.stats?.[i] ?? '').split('-');
          if (parts.length > 1 && vals.length === parts.length) parts.forEach((p, j) => { if (map[p]) { const v = statValue(map[p], vals[j]); if (v != null) stats[map[p]] = v; } });
          else if (map[n]) { const v = statValue(map[n], ev.stats?.[i]); if (v != null) stats[map[n]] = v; }
        });
        for (const d of STATS[sport] ?? []) if (d.from) { const v = statOf(sport, d.key, stats); if (v != null) stats[d.key] = v; }
        const teamId = str(meta.team?.id);
        const home = meta.homeTeamId != null && teamId ? String(meta.homeTeamId) === teamId : meta.atVs === 'vs';
        const teamScore = num(home ? meta.homeTeamScore : meta.awayTeamScore), oppScore = num(home ? meta.awayTeamScore : meta.homeTeamScore);
        out.push({
          eventId: str(ev.eventId), date: iso(meta.gameDate), season, opp: { id: str(meta.opponent?.id), abbr: meta.opponent?.abbreviation ?? null },
          home, result: meta.gameResult === 'D' ? 'T' : ['W', 'L', 'T'].includes(meta.gameResult) ? meta.gameResult : null,
          margin: teamScore != null && oppScore != null ? teamScore - oppScore : null, teamScore, oppScore,
          minutes: stats.min ?? null, stats,
        });
      }
    }
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export function buildGameLog(athlete, sport, gameLists) {
  const seen = new Set();
  const games = gameLists.flat().filter((g) => g.eventId && !seen.has(g.eventId) && seen.add(g.eventId))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const defs = (STATS[sport] ?? []).filter((d) => games.some((g) => statOf(sport, d.key, g.stats) != null));
  return { athlete, statKeys: defs.map((d) => d.key), labels: Object.fromEntries(defs.map((d) => [d.key, d.label])), games };
}

// ---------- en vivo ----------
// El boxscore usa los mismos nombres que el game log ("fieldGoalsMade-fieldGoalsAttempted").
const boxMap = (sport) => (sport === 'basketball' ? { ...NAME_MAP.basketball, rebounds: 'reb' } : NAME_MAP[sport] ?? {});
export function boxPlayers(json, sport) {
  const out = new Map();
  for (const t of json?.boxscore?.players ?? []) {
    for (const cat of t.statistics ?? []) {
      const map = boxMap(sport), keys = cat.keys ?? [];
      for (const a of cat.athletes ?? []) {
        const id = str(a.athlete?.id);
        if (!id) continue;
        if (!out.has(id)) out.set(id, { id, name: str(a.athlete.displayName), teamId: str(t.team?.id), stats: {} });
        const stats = out.get(id).stats;
        keys.forEach((k, i) => {
          const parts = k.split(/[-/]/), vals = parts.length > 1 ? String(a.stats?.[i] ?? '').split(/[-/]/) : [a.stats?.[i]];
          if (vals.length === parts.length) parts.forEach((p, j) => { const v = map[p] ? statValue(map[p], vals[j]) : null; if (v != null) stats[map[p]] ??= v; });
        });
      }
    }
  }
  for (const p of out.values()) for (const d of STATS[sport] ?? []) if (d.from) { const v = statOf(sport, d.key, p.stats); if (v != null) p.stats[d.key] = v; }
  return [...out.values()];
}

// Summary de un partido en juego → LiveGame = Game & { period, clock, progress, stop: { kind, label, at }|null, winProb, lastPlay, lastPlayAt, players }.
// clock: segundos que quedan en el periodo.
export function normLive(json, league) {
  const lg = leagueById(league);
  const comp = json?.header?.competitions?.[0];
  const st = comp?.status ?? {};
  const plays = json?.plays ?? [];
  const last = plays.at(-1);
  const stop = stopOf(st.type?.name?.replace(/^STATUS_/, '').replace(/_/g, ' ')) ?? stopOf(last?.type?.text);
  const period = num(st.period), clock = num(st.clock) ?? clockSecs(st.displayClock);
  return {
    ...gameFrom(json?.header?.id ?? comp?.id, comp, st, league),
    period,
    clock,
    progress: progress(lg.sport, lg.id, { period, clock }),
    stop: stop && { ...stop, at: iso(last?.wallclock) },
    winProb: num(json?.winprobability?.at(-1)?.homeWinPercentage),
    lastPlay: str(last?.text)?.slice(0, 200) ?? null,
    lastPlayAt: iso(last?.wallclock), // hora real de la jugada: ESPN la publica minutos después
    players: boxPlayers(json, lg.sport),
  };
}

export const normAthleteProfile = (json) => normAthlete(json?.athlete, json?.athlete?.team);

export function normSearch(json, espnLeague) {
  return (json?.items ?? []).filter((i) => i.type === 'player' && (!espnLeague || !i.league || i.league === espnLeague))
    .map((i) => normAthlete(i, i.teamRelationships?.find((t) => t.type === 'team')?.core ?? null)).filter((a) => a?.id);
}

// ---------- fetch wrappers ----------
const L = (league) => {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  return lg;
};
const base = (lg) => `${SITE}/${lg.sport}/${lg.espn}`;
const liveTtl = (isLive) => (body) => (isLive(body) ? TTL.live : TTL.board);

export async function getGames(league, date) {
  const lg = L(league);
  const url = new URL(`${base(lg)}/scoreboard`);
  if (date) url.searchParams.set('dates', date);
  url.searchParams.set('limit', '300');
  // También en vivo si ya pasó la hora de inicio de un 'pre': si no, el partido que arranca tarda 5 min en aparecer.
  const json = await fetchJson(url.href, liveTtl((b) => b?.events?.some((e) => e.status?.type?.state === 'in' || (e.status?.type?.state === 'pre' && Date.parse(e.date) <= Date.now()))));
  return normScoreboard(json, lg.id);
}

const coreTeam = (lg, year, type, teamId, what) => `${CORE}/${lg.sport}/leagues/${lg.espn}/seasons/${year}/types/${type}/teams/${teamId}/${what}`;

async function summaryOf(lg, id, ttl = liveTtl((b) => b?.header?.competitions?.[0]?.status?.type?.state === 'in')) {
  const json = await fetchJson(`${base(lg)}/summary?event=${id}`, ttl);
  if (!json?.header?.competitions?.[0]) throw httpError(404, 'Partido no encontrado en ESPN');
  return json;
}

// Solo el Game del summary (ids, inicio, estado, equipos, sede): sin las plantillas, récords y estadísticas de getGame.
export async function getEvent(league, id) {
  const lg = L(league);
  const json = await summaryOf(lg, id);
  const comp = json.header.competitions[0];
  return gameFrom(json.header.id ?? comp.id, comp, comp.status, lg.id);
}

export async function getGame(league, id) {
  const lg = L(league);
  const json = await summaryOf(lg, id);
  const comp = json.header.competitions[0];
  const year = num(json.header.season?.year) ?? new Date().getUTCFullYear();
  const type = lg.sport === 'soccer' ? 1 : 2; // temporada regular
  const teamId = (ha) => comp.competitors?.find((c) => c.homeAway === ha)?.id ?? comp.competitors?.find((c) => c.homeAway === ha)?.team?.id;
  const stats = (tid) => fetchJson(coreTeam(lg, year, type, tid, 'statistics'), TTL.slow).catch(() => fetchJson(coreTeam(lg, year - 1, type, tid, 'statistics'), TTL.slow));
  const sides = ['home', 'away'];
  const ids = sides.map(teamId);
  const [rosters, records, teamStats] = await Promise.all([
    Promise.all(ids.map((t) => (t ? soft(fetchJson(`${base(lg)}/teams/${t}/roster`, TTL.slow)) : null))),
    Promise.all(ids.map((t) => (t ? soft(fetchJson(coreTeam(lg, year, type, t, 'record'), TTL.slow)) : null))),
    Promise.all(ids.map((t) => (t ? soft(stats(t)) : null))),
  ]);
  const pair = (arr) => ({ home: arr[0], away: arr[1] });
  return normSummary(json, lg.id, { rosters: pair(rosters), records: pair(records), stats: pair(teamStats) });
}

// Partidos en juego de hoy con su summary fresco (TTL.live): marcador, avance, pausa, prob. de ganar y boxscore.
export async function getLive(league) {
  const lg = L(league);
  const live = (await getGames(lg.id)).filter((g) => g.status?.state === 'in');
  const sums = await Promise.all(live.map((g) => soft(fetchJson(`${base(lg)}/summary?event=${g.id}`, TTL.live)))); // si uno falla, los demás siguen
  return sums.filter(Boolean).map((j) => normLive(j, lg.id));
}

// Un partido con su summary fresco (TTL.live) en cualquier estado: el seguimiento de apuestas también necesita ver cuándo termina o se aplaza.
export async function getLiveGame(league, id) {
  const lg = L(league);
  return normLive(await summaryOf(lg, id, TTL.live), lg.id);
}

// El partido (LiveGame sin boxscore) y sus jugadas con posición, para la vista Estadio en vivo. summaryOf deja el TTL por defecto: 15 s en juego.
export async function getPlays(league, id) {
  const lg = L(league);
  const json = await summaryOf(lg, id);
  const { players, ...game } = normLive(json, lg.id);
  return { game, plays: normPlays(json, lg.sport, lg.id) };
}

const athleteUrl = (lg, id) => `${WEB}/sports/${lg.sport}/${lg.espn}/athletes/${id}`;

// Sin season: temporada actual (la que ESPN da por defecto) + la anterior, combinadas. Con athlete (normAthlete de
// la plantilla) no se pide el perfil.
export async function getGamelog(league, athleteId, season, { athlete } = {}) {
  const lg = L(league);
  const profile = athlete ? null : soft(fetchJson(athleteUrl(lg, athleteId), TTL.slow));
  const first = await fetchJson(`${athleteUrl(lg, athleteId)}/gamelog${season ? `?season=${season}` : ''}`, TTL.slow);
  const current = num(first?.filters?.find((f) => f.name === 'season')?.value);
  const lists = [normGamelog(first, lg.sport)];
  if (!season && current) {
    const prev = await soft(fetchJson(`${athleteUrl(lg, athleteId)}/gamelog?season=${current - 1}`, TTL.slow));
    if (prev) lists.push(normGamelog(prev, lg.sport, current - 1));
  }
  const who = athlete ?? normAthleteProfile(await profile) ?? { id: String(athleteId), name: null, short: null, pos: null, jersey: null, headshot: null, teamId: null, teamAbbr: null };
  return buildGameLog(who, lg.sport, lists);
}

export async function getRoster(league, teamId) {
  const lg = L(league);
  return normRoster(await fetchJson(`${base(lg)}/teams/${teamId}/roster`, TTL.slow));
}

export async function getInjuries(league) {
  const lg = L(league);
  const json = await fetchJson(`${base(lg)}/injuries`, TTL.board).catch((err) => {
    if (err.status === 404) return { injuries: [] }; // ESPN no publica lesiones para algunas ligas (fútbol)
    throw err;
  });
  return normInjuries(json?.injuries);
}

export async function searchAthletes(league, q) {
  const lg = L(league);
  const url = new URL(`${WEB}/search`);
  url.search = new URLSearchParams({ query: q, type: 'player', limit: '20', sport: lg.sport, league: lg.espn });
  return normSearch(await fetchJson(url.href, TTL.slow), lg.espn);
}

// ---------- calendarios (ratings de equipos) ----------
// Solo partidos terminados con marcador numérico. El score llega como { value } o como texto.
// Aplazados y cancelados también llegan con state 'post' y 0-0, por eso se exige completed; la pretemporada no cuenta.
export function normSchedule(json, sport) {
  const out = [];
  for (const ev of json?.events ?? []) {
    const c = ev?.competitions?.[0];
    if (c?.status?.type?.completed !== true || ev?.seasonType?.type === 1) continue;
    const period = Number(c.status.period);
    if (sport === 'soccer' && period > 2) continue; // prórroga de copa: sus goles inflarían las medias de 90 minutos
    const side = (ha) => c.competitors?.find((x) => x.homeAway === ha);
    const [h, a] = [side('home'), side('away')];
    const score = (x) => num(x?.score?.value ?? (typeof x?.score === 'object' ? x.score?.displayValue : x?.score));
    const [hs, as] = [score(h), score(a)];
    const [hid, aid] = [str(h?.team?.id ?? h?.id), str(a?.team?.id ?? a?.id)];
    const date = iso(c.date ?? ev.date);
    if (hs == null || as == null || !hid || !aid || !date) continue;
    out.push({ id: str(ev.id ?? c.id), date, homeId: hid, awayId: aid, homeScore: hs, awayScore: as, neutral: c.neutralSite === true });
  }
  return out;
}

// Calendarios ya normalizados por URL con TTL de 6 h; el JSON crudo (1-3 MB por equipo) no pasa por la caché compartida.
// Las claves están acotadas por ligas × equipos × 3 consultas.
const schedMemo = new Map(); // url -> { at, promise<{ requested, results }> }

// ESPN: sin param, la temporada vigente (en playoffs, solo la postemporada); season=N, la que termina en N
// (NBA season=2026 → 2025-26); seasontype=2, la fase regular vigente.
function teamSchedule(lg, teamId, query = '') {
  const url = `${base(lg)}/teams/${teamId}/schedule${query ? `?${query}` : ''}`;
  const hit = schedMemo.get(url);
  if (hit && Date.now() - hit.at < TTL.sched) return hit.promise;
  const promise = fetchJson(url, 0).then((json) => ({ requested: json?.requestedSeason ?? null, results: normSchedule(json, lg.sport) }));
  schedMemo.set(url, { at: Date.now(), promise });
  promise.catch(() => schedMemo.delete(url));
  return promise;
}

export async function getTeamSchedule(league, teamId, query = '') {
  return (await teamSchedule(L(league), teamId, query)).results;
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
export const uniqueById = (rs) => [...new Map(rs.map((r) => [r.id, r])).values()];
const SCHED_LIMIT = 6; // calendarios en vuelo: ESPN corta con 403 las ráfagas
const MAX_FAILED = 0.1; // más calendarios caídos que esto falsearía las medias de liga: mejor un error
const validIds = (ids) => [...new Set(ids.map(str))].filter((id) => /^\d{1,12}$/.test(id ?? '')); // van a la URL
const leagueTeamIds = async (lg) =>
  (await fetchJson(`${base(lg)}/teams`, TTL.sched))?.sports?.[0]?.leagues?.[0]?.teams?.map((t) => t?.team?.id) ?? [];

// Ruling 6: con menos de 10 partidos por equipo (mediana), los ratings suman la temporada anterior. El backtest usa la misma regla.
export function thinSeason(results, teamIds) {
  const games = new Map(teamIds.map((id) => [id, 0]));
  for (const r of results) for (const t of [r.homeId, r.awayId]) if (games.has(t)) games.set(t, games.get(t) + 1);
  return median([...games.values()]) < 10;
}

// fn sobre cada item con a lo sumo limit a la vez (ESPN corta con 403 las ráfagas); resultados en orden.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Resultados de la temporada de la liga. teamIds acota qué calendarios se piden.
export async function getSeasonResults(league, { teamIds } = {}) {
  const lg = L(league);
  const ids = validIds(teamIds ?? (await leagueTeamIds(lg)));
  if (!ids.length) throw httpError(502, 'ESPN no devolvió equipos');
  const pull = async (query) => {
    const got = (await mapLimit(ids, SCHED_LIMIT, (id) => teamSchedule(lg, id, query).catch(() => null))).filter(Boolean);
    if (ids.length - got.length > ids.length * MAX_FAILED) throw httpError(502, 'ESPN no devolvió los calendarios de los equipos');
    return got;
  };
  let pulls = await pull('');
  if (pulls.some((p) => p.requested?.type === 3)) pulls = [...pulls, ...(await pull('seasontype=2'))];
  let results = uniqueById(pulls.flatMap((p) => p.results));
  const year = Number(pulls.find((p) => p.requested?.year)?.requested.year);
  // Fútbol siempre suma la temporada anterior: con dos torneos por año (Liga BetPlay) o a mitad de temporada, la
  // vigente sola deja ratings más ruidosos (backtest de col.1: más historia baja el Brier).
  if (year && (lg.sport === 'soccer' || thinSeason(results, ids))) {
    const prev = await pull(`season=${year - 1}`);
    results = uniqueById([...results, ...prev.flatMap((p) => p.results)]);
  }
  return results;
}

// Temporada ya jugada para el backtest: back = 1 es la anterior a la vigente de ESPN (la última completa), 2 la previa.
// Se piden los equipos actuales y, por rondas, los rivales nuevos que aparecen (descendidos, eliminados de copa):
// un equipo que no jugó esa temporada en la liga devuelve 0 partidos. Un calendario caído es un error, no un hueco.
export async function getPastSeason(league, back = 1) {
  const lg = L(league);
  if (!Number.isInteger(back) || back < 1) throw httpError(400, 'Temporada inválida');
  const ids = validIds(await leagueTeamIds(lg));
  let year = null;
  for (let k = 0; k < ids.length && !year; k++) year = Number((await teamSchedule(lg, ids[k])).requested?.year) || null;
  if (!year) throw httpError(502, 'ESPN no devolvió la temporada vigente');
  const season = year - back;
  const seen = new Set();
  const results = [];
  for (let batch = ids; batch.length;) {
    for (const id of batch) seen.add(id);
    const rs = (await Promise.all(batch.map((id) => teamSchedule(lg, id, `season=${season}`)))).flatMap((p) => p.results);
    results.push(...rs);
    batch = validIds(rs.flatMap((r) => [r.homeId, r.awayId])).filter((id) => !seen.has(id));
  }
  return { season, results: uniqueById(results).sort((a, b) => a.date.localeCompare(b.date)) }; // estable: orden de pedido
}
