// Seguimiento de apuestas de NBA: rutas /api/track/* (dispositivo, lectura del ticket, apuestas y el tick). Las
// dependencias se inyectan (base de datos, push, Gemini, ESPN) para probarlas sin red; trackFromEnv arma las reales.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { httpError, getGames, getRoster, mapLimit } from './espn.mjs';
import { getProps } from './props.mjs';
import { readTicket as geminiRead, matchLegs, labelOf, parseNum, TRACKED } from './ticket.mjs';
import { createDb } from './db.mjs';
import { createPush, isPushEndpoint } from './push.mjs';
import { parseOdds } from '../public/live.js';

// shortcut: Google no publica el límite diario gratis de gemini-3.8-flash (solo se ve en AI Studio por proyecto); 200
// es un tope prudente. Poner TRACK_READS_PER_DAY con el 90 % del RPD que muestre AI Studio.
export const DEFAULT_READS_PER_DAY = 200;
const MAX_IMAGE = 2 * 1024 * 1024, MAX_TEXT = 4000, MAX_SELS = 20, PRIOR_MS = 20_000;
const MARKETS = ['ml', 'spread', 'total', 'prop'];
const VOID = /POSTPONED|SUSPENDED|CANCEL/;
const SEGUIR = '/#/nba/seguir';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const bad = (msg) => httpError(400, msg);
// Lo que llegue antes: la promesa o null a los ms. El timer no deja vivo el proceso.
function within(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((r) => { t = setTimeout(r, ms, null); t.unref?.(); })]).finally(() => clearTimeout(t));
}

export function createTrack({ db, push, readTicket, nba, limits, vapidPublicKey, tickSecret, runTick, now = Date.now, priorMs = PRIOR_MS }) {
  async function auth(headers) {
    const id = headers['x-device-id'], secret = headers['x-device-secret'];
    const dev = id && secret ? await db.getDevice(id) : null;
    if (!dev || !sameText(dev.secretHash, sha(String(secret)))) throw httpError(401, 'Activa los avisos otra vez');
    await db.touchDevice(dev.id);
    return dev;
  }

  async function device({ headers, body }) {
    const sub = body?.subscription;
    if (!isPushEndpoint(sub?.endpoint) || typeof sub?.keys?.p256dh !== 'string' || typeof sub?.keys?.auth !== 'string') throw bad('La suscripción de avisos no es válida');
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    if (headers['x-device-id']) {
      const dev = await auth(headers);
      await db.touchDevice(dev.id, { subscription });
      return { deviceId: dev.id };
    }
    // El aviso de prueba tiene que llegar: así no se fabrican dispositivos para gastar lecturas.
    const sent = await push.send(subscription, { title: 'Avisos activados', body: 'Te avisaremos de tus apuestas de NBA.', tag: 'oddsy-avisos', url: SEGUIR });
    if (!sent.ok) throw bad('No pude mandarte el aviso de prueba: revisa el permiso de notificaciones');
    const secret = randomBytes(32).toString('base64url');
    const platform = ['ios', 'android'].includes(body.platform) ? body.platform : 'otro';
    const { id } = await db.createDevice({ secretHash: sha(secret), subscription, platform });
    return { deviceId: id, secret };
  }

  // No guarda nada ni registra el contenido del ticket.
  async function read({ headers, body }) {
    const dev = await auth(headers);
    const image = typeof body?.image === 'string' && body.image ? body.image : null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!image && !text) throw bad('Manda una foto o el texto del ticket');
    if (image && Buffer.from(image, 'base64').length > MAX_IMAGE) throw httpError(413, 'La foto es muy pesada');
    if (!image && text.length > MAX_TEXT) throw httpError(413, 'El texto es muy largo');
    const ip = String(headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'sin-ip';
    const day = new Date(now()).toISOString().slice(0, 10);
    if (!(await db.bumpReads(day, ['global', `device:${dev.id}`, `ip:${ip}`], [limits.global, limits.device, limits.ip]))) {
      throw httpError(429, 'Llegaste al límite de lecturas de hoy: llena la apuesta a mano.');
    }
    const raw = await readTicket(image ? { image } : { text });
    const games = await nba.games();
    const teams = [...new Set(games.filter((g) => g.status.state !== 'post').flatMap((g) => [g.home.id, g.away.id]))];
    const lists = await mapLimit(teams, 6, (id) => nba.roster(id).catch(() => []));
    const rosters = new Map(teams.map((id, i) => [id, lists[i]]));
    return { book: typeof raw.book === 'string' ? raw.book.slice(0, 40) : null, odds: parseOdds(parseNum(raw.odds)), selections: matchLegs(raw.legs, games, rosters) };
  }

  // Cada selección se revalida contra ESPN: el navegador pudo editar cualquier campo.
  async function selectionOf(s, games, props) {
    if (s?.status === 'no_seguida') {
      const label = String(s.label ?? '').trim().slice(0, 200);
      if (!label) throw bad('Falta el texto de una selección');
      return { market: MARKETS.includes(s.market) ? s.market : 'other', label, status: 'no_seguida' };
    }
    const market = s?.market;
    if (!MARKETS.includes(market) || (market === 'prop' && !TRACKED.includes(s.stat))) throw bad('Mercado que Oddsy no sigue');
    const g = games.find((x) => x.id === String(s.gameId));
    if (!g) throw bad('No encontré el partido');
    if (VOID.test(g.status.name ?? '')) throw bad('El partido se aplazó o se suspendió');
    if (g.status.state === 'post') throw bad('El partido ya terminó');
    const ou = market === 'total' || market === 'prop';
    if (!(ou ? ['Over', 'Under'] : ['home', 'away']).includes(s.side)) throw bad('El lado de la selección no es válido');
    const line = market === 'ml' ? null : typeof s.line === 'number' ? s.line : parseNum(s.line);
    if (market !== 'ml' && !(Number.isFinite(line) && Math.abs(line) <= 400)) throw bad('La línea tiene que ser un número');
    const odds = s.odds == null || s.odds === '' ? null : parseOdds(s.odds);
    let athlete = null, prior = null;
    if (market === 'prop') {
      const pool = (await Promise.all([nba.roster(g.home.id), nba.roster(g.away.id)])).flat();
      athlete = pool.find((a) => a.id === String(s.athleteId));
      if (!athlete) throw bad('No encontré al jugador');
      if (!props.has(g.id)) props.set(g.id, within(Promise.resolve().then(() => nba.props(g.id)), priorMs).catch(() => null));
      const p = (await props.get(g.id))?.find((x) => x.athleteId === athlete.id && x.stat === s.stat);
      prior = p ? { mean: p.mean, variance: p.variance, kind: p.kind } : null;
    }
    const sel = { gameId: g.id, gameStart: g.start, market, stat: market === 'prop' ? s.stat : null, athleteId: athlete?.id ?? null,
      athleteName: athlete?.name ?? null, side: s.side, line, odds, prior, status: 'pendiente' };
    return { ...sel, label: labelOf(sel, g, sel.athleteName) };
  }

  async function createBet({ headers, body }) {
    const dev = await auth(headers);
    const list = body?.selections;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SELS) throw bad(`La apuesta necesita entre 1 y ${MAX_SELS} selecciones`);
    const games = await nba.games(), props = new Map();
    const selections = [];
    for (const s of list) selections.push(await selectionOf(s, games, props));
    if (!selections.some((s) => s.status !== 'no_seguida')) throw bad('Ninguna selección se puede seguir');
    const book = typeof body.book === 'string' && body.book.trim() ? body.book.trim().slice(0, 40) : null;
    const odds = body.odds == null || body.odds === '' ? null : parseOdds(body.odds);
    return db.createBet(dev.id, { book, odds }, selections);
  }

  const ROUTES = {
    'GET vapid': async () => ({ publicKey: vapidPublicKey }),
    'POST device': device,
    'POST read': read,
    'POST bets': createBet,
    'GET bets': async ({ headers }) => ({ bets: await db.listBets((await auth(headers)).id) }),
    'DELETE bets': async ({ headers, query }) => {
      const dev = await auth(headers);
      if (!(await db.deleteBet(dev.id, query.get('id') ?? ''))) throw httpError(404, 'No encontré esa apuesta');
      return null;
    },
    'POST tick': async ({ headers }) => {
      if (!tickSecret || !sameText(headers['x-tick-secret'] ?? '', tickSecret)) throw httpError(401, 'No autorizado');
      return runTick();
    },
  };
  const PATHS = new Set(Object.keys(ROUTES).map((k) => k.split(' ')[1]));

  return {
    // → { status, body }; body null = 204. Los errores salen como { error } en español.
    async handle(req) {
      try {
        const route = ROUTES[`${req.method} ${req.path}`];
        if (!route) throw PATHS.has(req.path) ? httpError(405, 'Método no permitido') : httpError(404, 'No encontrado');
        const body = await route({ ...req, headers: req.headers ?? {}, query: req.query ?? new URLSearchParams() });
        return body === null ? { status: 204, body: null } : { status: 200, body };
      } catch (err) {
        if (!err.status) console.error(`/api/track/${req.path} →`, err.message); // nunca el cuerpo: puede traer el ticket
        return { status: err.status || 502, body: { error: err.status ? err.message : 'Error del seguimiento de apuestas' } };
      }
    },
  };
}

const NEED = ['GEMINI_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TRACK_TICK_SECRET'];
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

// Partidos de NBA de ayer, hoy y mañana (UTC): de noche en Colombia ya es mañana en UTC.
async function nbaGames() {
  const lists = await Promise.all([-1, 0, 1].map((k) => getGames('nba', ymd(Date.now() + k * 864e5))));
  return [...new Map(lists.flat().map((g) => [g.id, g])).values()];
}

export function trackFromEnv(env = process.env) {
  if (NEED.some((k) => !env[k])) return null;
  const reads = Number(env.TRACK_READS_PER_DAY);
  return createTrack({
    db: createDb({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY }),
    push: createPush({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }),
    readTicket: (input) => geminiRead(input, { key: env.GEMINI_API_KEY }),
    nba: { games: nbaGames, roster: (id) => getRoster('nba', id), props: async (gameId) => (await getProps('nba', gameId)).data },
    limits: { device: 20, ip: 40, global: Number.isInteger(reads) && reads > 0 ? reads : DEFAULT_READS_PER_DAY },
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    tickSecret: env.TRACK_TICK_SECRET,
    runTick: async () => { throw httpError(501, 'El tick todavía no está listo'); }, // Task 8 lo conecta
  });
}
