#!/usr/bin/env node
// Lector de Betano sin LLM: abre cada liga en un Brave real (Betano responde 403 a los servidores), lee las cuotas
// con el mismo código del marcador (read, public/betano.js) y las manda a Oddsy.
//   node scripts/betano-reader.mjs [--dry] [--out lectura.json] [--only nba,epl] [--limit 8]
// Entorno: TRACK_TICK_SECRET (obligatorio sin --dry), ODDSY_URL, BRAVE_BIN.
// Solo lee, sin sesión. Ante un reto de Cloudflare, un 403 o un 429 se detiene y sale con código 2: no se insiste.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { read, gamesOf } from '../public/betano.js';

const CDP = 'http://127.0.0.1:9333';
const ORIGIN = 'https://www.betano.co';
export const PROFILE = `${homedir()}/.config/oddsy-betano`; // perfil aparte: nunca el Brave del usuario
const PAUSE = [2000, 4000]; // ms entre peticiones a Betano

// Liga de Oddsy (public/leagues.js) → rutas de la liga en betano.co (vistas el 2026-11-16). Para sumar una liga,
// ábrela en betano.co y copia aquí la ruta de la barra de direcciones. El tenis va por torneo y cambia cada semana:
// en vez de rutas fijas, { index, match } toma del índice del deporte las ligas cuya ruta cumple match.
export const ROUTES = {
  epl: ['/sport/futbol/inglaterra/premier-league/1/'],
  laliga: ['/sport/futbol/espana/laliga/5/'],
  ucl: ['/sport/futbol/champions-league/champions-league/432g/'],
  libertadores: ['/sport/futbol/copa-libertadores/copa-libertadores/436g/'],
  colombia: ['/sport/futbol/colombia/categoria-primera-a/16940/'],
  nba: ['/sport/baloncesto/ee-uu/nba/441g/'],
  wnba: ['/sport/baloncesto/ee-uu/wnba/440g/'],
  // shortcut: solo se ha visto la semana de las Finals (/sport/tenis/atp-finals/atp-finals/199527/); si en una
  // semana normal --only atp dice "sin torneos", mirar la ruta real de un torneo y ajustar match.
  atp: { index: '/sport/tenis/', match: /^\/sport\/tenis\/atp[^/]*\/(?!.*dobles)[^/]+\/\d+g?\/$/ },
  challenger: { index: '/sport/tenis/', match: /^\/sport\/tenis\/challenger\/(?!.*dobles)[^/]+\/\d+g?\/$/ },
};

export class Blocked extends Error {}

// Lo que Betano o Cloudflare ponen cuando no quieren al lector → motivo, o null si la página es normal.
export function blockedBy({ status, title = '', challenge = false } = {}) {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  if (challenge || /just a moment|un momento|attention required|access denied/i.test(title)) return 'reto de Cloudflare';
  return null;
}

// La petición a Oddsy con lo leído de una liga.
export function ingestRequest(events, env = process.env) {
  if (!env.TRACK_TICK_SECRET) throw new Error('Falta TRACK_TICK_SECRET');
  return [`${env.ODDSY_URL ?? 'https://oddsybet.vercel.app'}/api/betano/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tick-secret': env.TRACK_TICK_SECRET },
    body: JSON.stringify({ events }),
  }];
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const pause = (ms) => wait(ms ?? PAUSE[0] + Math.random() * (PAUSE[1] - PAUSE[0]));

// Estado de la página recién navegada, visto desde dentro.
const STATE = `({ status: performance.getEntriesByType('navigation')[0]?.responseStatus, title: document.title, ready: document.readyState === 'complete',
  challenge: !!document.querySelector('#challenge-form, #challenge-running, [name="cf-turnstile-response"]'),
  links: document.querySelectorAll('a[href*="/cuotas-de-partido/"]').length })`;
// Las rutas /sport/… que nombra la API de la página abierta (el índice de un deporte lista sus ligas).
const INDEX = `fetch('/api' + location.pathname + '?bt=1').then(async (r) => {
  if (!r.ok) return { status: r.status };
  const urls = new Set();
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (typeof o.url === 'string' && o.url.startsWith('/sport/')) urls.add(o.url); for (const v of Object.values(o)) walk(v); };
  walk(await r.json());
  return { urls: [...urls] };
})`;

// Recorre las ligas: navega, espera los enlaces de partidos, lee y entrega cada liga a send(id, events).
// page = { goto(url), evaluate(expresión) }. Devuelve { liga: events }. Lanza Blocked si Betano corta.
export async function readAll(page, { leagues = Object.keys(ROUTES), limit = 8, send = async () => {}, log = console.error, sleep = pause, tries = 30 } = {}) {
  const stop = (st, path) => { const why = blockedBy(st ?? {}); if (why) throw new Blocked(`${why} en ${path}`); };
  // Navega y espera (hasta ~30 s: la lista de partidos la pinta el JavaScript de la página) a que done(estado).
  const open = async (path, done) => {
    await page.goto(ORIGIN + path);
    let st;
    for (let i = 0; i < tries; i++) {
      await sleep(1000);
      st = await page.evaluate(STATE).catch(() => null); // a media navegación el contexto se pierde
      stop(st, path);
      if (st && done(st)) break;
    }
    return st;
  };
  const found = new Map(); // índice → rutas, para no pedirlo dos veces (ATP y Challenger comparten el del tenis)
  const pathsOf = async (route) => {
    if (Array.isArray(route)) return route;
    if (!found.has(route.index)) {
      await open(route.index, (st) => st.ready);
      const r = await page.evaluate(INDEX);
      stop(r, route.index);
      found.set(route.index, r?.urls ?? []);
      await sleep();
    }
    return found.get(route.index).filter((u) => route.match.test(u));
  };
  const out = {};
  for (const id of leagues) {
    const events = [], paths = await pathsOf(ROUTES[id]);
    if (!paths.length) log(`${id}: sin torneos en el índice`);
    for (const path of paths) {
      const st = await open(path, (s) => s.links);
      if (!st?.links) { log(`${id}: sin partidos en ${path}`); continue; }
      const r = await page.evaluate(`(${read})(${JSON.stringify({ pause: PAUSE, max: limit })}).then((found) => ({ found }), (e) => ({ error: String(e?.message ?? e) }))`);
      if (r?.error) throw /^HTTP 4/.test(r.error) ? new Blocked(`${r.error} en ${path}`) : new Error(`${id}: ${r.error}`);
      events.push(...(r?.found ?? []));
      await sleep();
    }
    out[id] = events;
    const fields = gamesOf(events).reduce((n, g) => n + Object.values(g).filter((v) => Array.isArray(v) && v.length).length - 1, 0); // sin teams
    log(`${id}: ${events.length} partidos, ${fields} mercados de partido, ${events.reduce((n, e) => n + e[2].length, 0)} de jugadores`);
    if (events.length) await send(id, events);
  }
  return out;
}

const up = () => fetch(`${CDP}/json/version`).then((r) => r.ok, () => false);

// Si nadie escucha en el puerto, lanza Brave con el perfil del lector. Devuelve el proceso lanzado (o null).
async function ensureBrave() {
  if (await up()) return null;
  const child = spawn(process.env.BRAVE_BIN ?? 'brave-browser', [`--user-data-dir=${PROFILE}`, '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  // brave-browser es un script que lanza el binario: se mata el grupo entero (detached), no solo el script.
  child.kill = () => { try { process.kill(-child.pid); } catch { /* ya no está */ } };
  for (let i = 0; i < 120; i++) { await wait(500); if (await up()) return child; } // en frío tardó más de 20 s (2026-11-16)
  child.kill();
  throw new Error('Brave no abrió el puerto 9333');
}

// Una pestaña de Brave por CDP con el WebSocket nativo de Node.
export async function connect() {
  const tabs = await fetch(`${CDP}/json/list`).then((r) => r.json());
  const tab = tabs.find((t) => t.type === 'page') ?? await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('No pude conectar con Brave por CDP')); });
  const waiting = new Map();
  let n = 0;
  ws.onmessage = ({ data }) => {
    const d = JSON.parse(data), w = waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    d.error ? w[1](new Error(d.error.message)) : w[0](d.result);
  };
  const call = (method, params = {}) => new Promise((ok, no) => { waiting.set(++n, [ok, no]); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    goto: (url) => call('Page.navigate', { url }),
    async evaluate(expression) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
  const dry = argv.includes('--dry'), out = flag('--out');
  const leagues = flag('--only')?.split(',') ?? Object.keys(ROUTES);
  const unknown = leagues.filter((id) => !ROUTES[id]);
  if (unknown.length) throw new Error(`Liga sin ruta de Betano: ${unknown.join(', ')}`);
  if (!dry) ingestRequest([]); // falla ya si falta el secreto, antes de tocar Betano
  const brave = await ensureBrave();
  const page = await connect();
  try {
    const send = dry ? undefined : async (id, events) => {
      const r = await fetch(...ingestRequest(events));
      if (!r.ok) throw new Error(`Oddsy respondió ${r.status} al recibir ${id}`);
    };
    const all = await readAll(page, { leagues, limit: Number(flag('--limit')) || 8, send });
    if (out) await writeFile(out, JSON.stringify(all));
  } finally {
    page.close();
    brave?.kill(); // solo el Brave que lanzó este proceso
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(e instanceof Blocked ? 2 : 1);
  });
}
