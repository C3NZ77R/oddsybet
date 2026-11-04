// Servidor de Oddsy Bet: sirve public/ y hace de proxy a ESPN (partidos, game logs, lesiones, plantillas; sin clave).
// Las cuotas son propias (lib/markets.mjs y lib/props.mjs). Caché en memoria por URL en lib/espn.mjs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES, leagueById } from './public/leagues.js';
import * as espn from './lib/espn.mjs';
import { getProps } from './lib/props.mjs';
import { getMarkets, getPicks, getAccuracy, getTennisGames, atpElo } from './lib/markets.mjs';
import { getRankings, getPlayer } from './lib/tennis.mjs';
import { trackFromEnv } from './lib/track-routes.mjs';
import { currentModel } from './lib/learn.mjs';
import { picklogFromEnv, sameSecret } from './lib/picklog.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// ---------- validación de parámetros ----------
const RX = {
  // Fecha real: 20261399 cumple \d{8} y ESPN respondería 502.
  date: { test: (v) => /^(19|20)\d{6}$/.test(v) && new Date(Date.UTC(v.slice(0, 4), v.slice(4, 6) - 1, v.slice(6))).toISOString().slice(0, 10).replaceAll('-', '') === v },
  id: /^\d{1,12}$/,
  ids: /^\d{1,12}(,\d{1,12}){0,39}$/,
  season: /^(19|20)\d\d$/,
  q: /^[\p{L}\p{M}0-9 .'’-]{2,40}$/u,
};
const bad = (msg) => espn.httpError(400, msg);
function param(url, name, rx, required = false) {
  const v = url.searchParams.get(name)?.trim(); // antes de validar: q=%20%20 llegaba a ESPN como query=
  if (v == null || v === '') {
    if (required) throw bad(`Falta el parámetro ${name}`);
    return null;
  }
  if (!rx.test(v)) throw bad(`Parámetro inválido: ${name}`);
  return v;
}
function leagueParam(url) {
  const lg = leagueById(url.searchParams.get('league') ?? '');
  if (!lg) throw bad(`Liga inválida. Opciones: ${LEAGUES.map((l) => l.id).join(', ')}`);
  return lg.id;
}
const isTennis = (id) => leagueById(id).sport === 'tennis';
// Rutas de equipos y jugadores de ESPN: no existen para tenis.
function teamLeague(url) {
  const id = leagueParam(url);
  if (isTennis(id)) throw bad('Ruta no disponible para tenis');
  return id;
}

const ROUTES = {
  '/api/leagues': async () => ({ source: 'espn', data: LEAGUES }),
  '/api/markets': async (url) => getMarkets(leagueParam(url), { game: param(url, 'game', RX.id), date: param(url, 'date', RX.date) }),
  '/api/picks': async (url) => {
    const league = leagueParam(url), date = param(url, 'date', RX.date);
    return getPicks(league, { date, model: await currentModel() }); // con lo que aprendió el registro de picks
  },
  '/api/accuracy': async () => ({ source: 'oddsy', data: getAccuracy() }),
  // Registro de picks de la liga (lib/picklog.mjs); sin Supabase, data null y la vista no lo muestra.
  '/api/record': async (url) => {
    const league = leagueParam(url);
    return { source: 'oddsy', data: picklog() ? await picklog().record(league) : null };
  },
  '/api/games': async (url) => {
    const lg = leagueParam(url);
    const date = param(url, 'date', RX.date);
    return { source: 'espn', data: await (isTennis(lg) ? getTennisGames(date) : espn.getGames(lg, date)) };
  },
  '/api/game': async (url) => ({ source: 'espn', data: await espn.getGame(teamLeague(url), param(url, 'id', RX.id, true)) }),
  '/api/live': async (url) => ({ source: 'espn', data: await espn.getLive(teamLeague(url)) }),
  '/api/plays': async (url) => ({ source: 'espn', data: await espn.getPlays(teamLeague(url), param(url, 'id', RX.id, true)) }),
  '/api/gamelog': async (url) => ({
    source: 'espn',
    data: await espn.getGamelog(teamLeague(url), param(url, 'athlete', RX.id, true), param(url, 'season', RX.season)),
  }),
  // Varios game logs en una petición: insights y props pedían ~50 por separado. Un jugador que falla queda en null.
  '/api/gamelogs': async (url) => {
    const league = teamLeague(url);
    const ids = [...new Set(param(url, 'ids', RX.ids, true).split(','))];
    const logs = await espn.mapLimit(ids, 2, (id) => espn.getGamelog(league, id).catch(() => null));
    return { source: 'espn', data: Object.fromEntries(ids.map((id, i) => [id, logs[i]])) };
  },
  '/api/roster': async (url) => ({ source: 'espn', data: await espn.getRoster(teamLeague(url), param(url, 'team', RX.id, true)) }),
  '/api/injuries': async (url) => ({ source: 'espn', data: await espn.getInjuries(teamLeague(url)) }),
  '/api/search': async (url) => ({ source: 'espn', data: await espn.searchAthletes(teamLeague(url), param(url, 'q', RX.q, true)) }),
  '/api/props': async (url) => {
    const lg = leagueParam(url);
    const game = param(url, 'game', RX.id);
    return isTennis(lg) ? { source: 'oddsy', data: [] } : getProps(lg, game); // sin modelo de props de tenis
  },
  '/api/tennis/rankings': async () => {
    const [rows, { ratings }] = await Promise.all([getRankings(), atpElo()]);
    return { source: 'espn', data: rows.map((r) => ({ ...r, elo: ratings.get(r.player.id)?.all ?? null })) };
  },
  '/api/tennis/player': async (url) => {
    const id = param(url, 'id', RX.id, true);
    const [p, rows, { ratings }] = await Promise.all([getPlayer(id), getRankings(), atpElo()]);
    if (!p.player) throw espn.httpError(404, 'Jugador no encontrado');
    return { source: 'espn', data: { ...p, points: rows.find((r) => r.player.id === id)?.points ?? null, elo: ratings.get(id) ?? null } };
  },
};

// Caché compartida en la CDN de Vercel (la memoria de cada instancia no se comparte): los ratings piden un calendario por equipo.
const EDGE_S = { '/api/live': 10, '/api/plays': 10, '/api/games': 15, '/api/game': 15, '/api/markets': 1800, '/api/picks': 1800, '/api/record': 300, '/api/props': 1800, '/api/accuracy': 86400, '/api/tennis/rankings': 3600, '/api/tennis/player': 1800 };
const json = (res, status, body, edge = 0) => res.writeHead(status, {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': edge ? `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 4}` : 'no-store',
}).end(JSON.stringify(body));

// Seguimiento de apuestas: rutas con POST y cuerpo JSON, siempre no-store. Sin variables de entorno → 503.
let track;
const MAX_BODY = 3 * 1024 * 1024;
export async function readBody(req) {
  if (req.method !== 'POST') return null;
  if (req.body !== undefined) { // Vercel ya lo parseó (y su getter lanza si el JSON es inválido)
    try {
      const b = req.body;
      return typeof b === 'string' || Buffer.isBuffer(b) ? JSON.parse(String(b) || 'null') : b;
    } catch {
      throw espn.httpError(400, 'JSON inválido');
    }
  }
  if (!String(req.headers?.['content-type'] ?? '').includes('application/json')) throw espn.httpError(415, 'Manda el cuerpo en JSON');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw espn.httpError(413, 'El archivo es muy pesado');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw espn.httpError(400, 'JSON inválido');
  }
}
async function trackRoute(req, res, url) {
  track ??= trackFromEnv() ?? false;
  if (!track) throw espn.httpError(503, 'El seguimiento de apuestas no está configurado');
  const r = await track.handle({ method: req.method, path: url.pathname.slice('/api/track/'.length), query: url.searchParams, headers: req.headers ?? {}, body: await readBody(req) });
  if (r.status === 204) res.writeHead(204, { 'cache-control': 'no-store' }).end();
  else json(res, r.status, r.body);
}

// Registro de picks: el tick (cada 15 min) y el aprendizaje (diario) los dispara pg_cron con el secreto del seguimiento.
let picklogMemo;
const picklog = () => (picklogMemo ??= picklogFromEnv() ?? false);
async function picklogRoute(req, res, url) {
  if (req.method !== 'POST') throw espn.httpError(405, 'Método no permitido');
  if (!picklog()) throw espn.httpError(503, 'El registro de picks no está configurado');
  if (!sameSecret(req.headers?.['x-tick-secret'], picklog().secret)) throw espn.httpError(401, 'Secreto inválido');
  const job = url.pathname.slice('/api/picklog/'.length);
  if (job !== 'tick' && job !== 'learn') throw espn.httpError(404, 'No encontrado');
  json(res, 200, await picklog()[job]());
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/track/')) return await trackRoute(req, res, url);
    if (url.pathname.startsWith('/api/picklog/')) return await picklogRoute(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw espn.httpError(405, 'Método no permitido');
      const route = ROUTES[url.pathname];
      if (!route) throw espn.httpError(404, 'No encontrado');
      json(res, 200, await route(url), EDGE_S[url.pathname] ?? 300);
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) throw Object.assign(new Error('Prohibido'), { status: 403 });
    const content = await readFile(file).catch(() => {
      throw Object.assign(new Error('No encontrado'), { status: 404 });
    });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(content);
  } catch (err) {
    const status = err.status || (err instanceof URIError ? 400 : 502);
    json(res, status, { error: err.status ? err.message : status === 400 ? 'Ruta inválida' : 'Error al consultar los datos' });
    if (status >= 500) console.error(`${url.pathname} → ${status}:`, err.status ? err.message : err); // sin la query: solo ruta y mensaje
  }
}

// En Vercel solo se importa el handler (api/[...path].mjs); en local se levanta el servidor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`Oddsy Bet en http://localhost:${PORT} — partidos y estadísticas: ESPN · cuotas y props: modelo propio`);
});
