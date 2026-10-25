// Backtest del modelo en la última temporada completa de cada liga: Brier y log-loss de la p del ganador (fútbol:
// 1X2 de 3 resultados) contra la referencia de las frecuencias de la temporada anterior. La temporada se parte por
// fecha: en la primera mitad se calibra el modelo normal (k, σ y σ_T) y en la segunda se mide; n, brier, logloss y
// baseline son de esa segunda mitad y calibration trae la primera. Escribe docs/accuracy.json mezclando con lo que ya
// tenía. Uso: node --env-file-if-exists=.env scripts/backtest.mjs [liga…] (sin ligas: todas menos las universitarias;
// el k, σ y σ_T que imprime valen para copiar a lib/ratings.mjs solo si corrieron todas las ligas del deporte).
// Cada JSON de ESPN que responde bien queda en .cache/espn/: una corrida cortada reanuda sin volver a pedirlo
// (temporadas ya jugadas; borrar la carpeta para refrescar la vigente).
// atp: sin red; los partidos salen de data/atp-elo.json (desde 2018) y data/atp-history.json (24 meses).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES, leagueById } from '../public/leagues.js';
import { getPastSeason, thinSeason, uniqueById } from '../lib/espn.mjs';
import { ratingsFromResults, expected, SPORT_MODEL, SIGMA, SIGMA_T, MU_SHRINK } from '../lib/ratings.mjs';
import { marketsFor } from '../lib/markets.mjs';
import { finished, matchProb, eloStep, eloSnapshot } from '../lib/tennis.mjs';

export const LAG = 6 * 3_600_000;
const DAY = 86_400_000;
export const SIGMAS = Array.from({ length: 33 }, (_, i) => 8 + i / 2);
const GRID = { basketball: SIGMAS }; // football conserva el σ de la literatura
const EPS = 1e-12; // log(0) sería Infinity, que JSON guarda como null
const OUT = new URL('../docs/accuracy.json', import.meta.url);
const CACHE = fileURLToPath(new URL('../.cache/espn/', import.meta.url));

// fetch educado con ESPN: caché en disco, a lo sumo inFlight peticiones a la vez con una pausa entre ellas y, ante
// 403/429, espera exponencial hasta tries intentos. Si se agotan queda bloqueado (blocked = status) y lo que no esté en
// disco falla sin pedir más. El signal de quien llama se ignora: su timeout correría mientras espera turno.
export function politeFetch(inner, { dir, inFlight = 2, delayMs = 300, tries = 4, backoffMs = 5_000, timeoutMs = 8_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let active = 0;
  let tmp = 0;
  const queue = [];
  const take = () => (active < inFlight ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const give = () => (queue.length ? queue.shift()() : active--);
  const json = (text) => new Response(text, { headers: { 'content-type': 'application/json' } });
  const self = async (url, init = {}) => {
    const file = join(dir, `${createHash('sha256').update(String(url)).digest('hex')}.json`);
    const hit = await readFile(file, 'utf8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (hit !== null) return json(hit);
    if (self.blocked) return new Response('{}', { status: self.blocked });
    await take();
    try {
      for (let k = 1; ; k++) {
        if (self.blocked) return new Response('{}', { status: self.blocked }); // otro en vuelo o en cola agotó los intentos
        const res = await inner(url, { headers: init.headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) {
          const text = await res.text();
          try {
            JSON.parse(text);
          } catch {
            return json(text); // no es JSON: fetchJson lo rechaza y no se guarda
          }
          const part = `${file}.${process.pid}.${++tmp}.tmp`; // escribir y renombrar: un corte no deja JSON a medias
          await writeFile(part, text);
          await rename(part, file);
          return json(text);
        }
        if (res.status !== 403 && res.status !== 429) return res;
        if (k === tries) {
          self.blocked = res.status;
          return res;
        }
        await res.body?.cancel(); // libera la conexión antes de esperar
        await sleep(backoffMs * 2 ** (k - 1));
      }
    } finally {
      await sleep(delayMs);
      give();
    }
  };
  self.blocked = null;
  return self;
}

// Los ratings de un partido usan lo que empezó al menos 6 h antes (ya terminó: sin fuga del resultado), con el
// corte bajado al día UTC para calcular los ratings una vez por jornada.
export const cutOf = (date) => Math.floor((Date.parse(date) - LAG) / DAY) * DAY;
const outcomeOf = (r) => (r.homeScore > r.awayScore ? 'H' : r.homeScore < r.awayScore ? 'A' : 'D');
const binary = (sport) => sport !== 'soccer'; // en los demás deportes el ganador no tiene empate: se ignoran
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// Igual que en vivo (getSeasonResults): la temporada evaluada hasta el corte, más la anterior (fútbol siempre; el resto
// solo mientras la vigente sea corta, thinSeason) y expected() con la sede.
export function predict(sport, prev, games) {
  const teams = [...new Set(games.flatMap((g) => [g.homeId, g.awayId]))];
  const out = [];
  let cut = null;
  let ratings;
  for (const g of [...games].sort((a, b) => a.date.localeCompare(b.date))) {
    const outcome = outcomeOf(g);
    if (binary(sport) && outcome === 'D') continue;
    const c = cutOf(g.date);
    if (c !== cut) {
      const done = games.filter((r) => Date.parse(r.date) < c);
      [cut, ratings] = [c, ratingsFromResults(sport === 'soccer' || thinSeason(done, teams) ? [...prev, ...done] : done, { sport, asOf: c })];
    }
    out.push({ id: g.id, outcome, homeScore: g.homeScore, awayScore: g.awayScore, margin: g.homeScore - g.awayScore, points: g.homeScore + g.awayScore,
      model: expected(sport, ratings, g.homeId, g.awayId, { neutral: g.neutral }) });
  }
  return out;
}

// ¿Ganó la selección con el marcador final? true, false o null (devolución); undefined = mercado sin liquidación directa
// (asiáticos de cuarto, marcador exacto), que queda fuera del registro de aciertos.
export function settle(key, s, { homeScore: h, awayScore: a }) {
  const m = h - a;
  const side = s.name === 'Visitante' ? -1 : 1;
  const over = (x) => (x === s.line ? null : (x > s.line) === (s.name === 'Más'));
  switch (key) {
    case '1x2': return s.name === 'Empate' ? m === 0 : side * m > 0;
    case 'ml': return side * m > 0;
    case 'dnb': return m === 0 ? null : side * m > 0;
    case 'dc': return { 'Local o empate': m >= 0, 'Local o visitante': m !== 0, 'Empate o visitante': m <= 0 }[s.name];
    case 'spread': case 'rl': return side * m + s.line === 0 ? null : side * m + s.line > 0;
    case 'ou': return over(h + a);
    case 'ou_home': return over(h);
    case 'ou_away': return over(a);
    case 'btts': return (h > 0 && a > 0) === (s.name === 'Sí');
    default: return undefined;
  }
}

// Registro de aciertos por mercado y tramo de probabilidad de 10 en 10: cuántas veces el modelo dijo ~p (said, promedio)
// y en qué fracción se cumplió (hit). Las devoluciones no cuentan.
export function hitBins(sport, preds) {
  const bins = {};
  for (const pr of preds) for (const mk of marketsFor(sport, pr.model)) for (const s of mk.selections) {
    const won = settle(mk.key, s, pr);
    if (won == null) continue;
    const b = ((bins[mk.key] ??= {})[Math.min(9, Math.floor(s.p * 10))] ??= { n: 0, said: 0, hit: 0 });
    b.n++;
    b.said += s.p;
    b.hit += won;
  }
  return Object.fromEntries(Object.entries(bins).map(([k, bs]) => [k, Object.entries(bs)
    .map(([i, b]) => ({ from: Number(i) * 10, n: b.n, said: r4(b.said / b.n), hit: r4(b.hit / b.n) }))]));
}

export const halves = (xs) => [xs.slice(0, Math.floor(xs.length / 2)), xs.slice(Math.floor(xs.length / 2))];

// p de cada resultado con los mismos mercados que ve el usuario.
function probs(sport, model) {
  const ms = marketsFor(sport, model);
  const p = (key, name) => ms.find((m) => m.key === key).selections.find((s) => s.name === name).p;
  return binary(sport) ? { H: p('ml', 'Local'), D: 0, A: p('ml', 'Visitante') } : { H: p('1x2', 'Local'), D: p('1x2', 'Empate'), A: p('1x2', 'Visitante') };
}

// Brier binario (p_local − o)² o de 3 clases (suma sobre H/D/A); log-loss = −ln p del resultado.
function metrics(sport, rows) {
  if (!rows.length) throw new Error('sin partidos terminados para medir');
  const ks = binary(sport) ? ['H'] : ['H', 'D', 'A'];
  let brier = 0;
  let logloss = 0;
  for (const { p, outcome } of rows) {
    for (const k of ks) brier += (p[k] - (k === outcome)) ** 2;
    logloss -= Math.log(Math.max(p[outcome], EPS));
  }
  return { n: rows.length, brier: brier / rows.length, logloss: logloss / rows.length };
}

export const score = (sport, preds) => metrics(sport, preds.map(({ model, outcome }) => ({ outcome, p: probs(sport, model) })));

// Referencia: siempre las frecuencias de la temporada anterior (binario: tasa de victorias local sin empates).
export function baseline(sport, prev, preds) {
  const os = prev.map(outcomeOf).filter((o) => !binary(sport) || o !== 'D');
  if (!os.length) throw new Error('sin temporada anterior para la referencia');
  const f = Object.fromEntries(['H', 'D', 'A'].map((k) => [k, os.filter((o) => o === k).length / os.length]));
  const { brier, logloss } = metrics(sport, preds.map(({ outcome }) => ({ outcome, p: f })));
  return { brier, logloss };
}

// Modelo normal con la calibración aplicada; kRel es relativo al MU_SHRINK con el que se predijo.
export const adjust = (preds, { kRel, sigma, sigmaT }) => preds.map((p) => ({ ...p, model: { ...p.model, mu: p.model.mu * kRel, sigma, sigmaT } }));

// Calibración del modelo normal sobre los partidos de calibración de todas las ligas del deporte (las constantes son
// por deporte). k: mínimos cuadrados del margen sobre mu sin intercepto (mu ya trae la localía); k < 1 = mu
// sobreconfiado. σ: el de menor log-loss de la grilla con k aplicado; debe quedar cerca de residualSd, el desvío
// real de margen − k·mu. σ_T: desvío real de los totales.
export function fitNormal(sport, preds) {
  const den = sum(preds, (p) => p.model.mu ** 2);
  const kRel = den > 0 ? sum(preds, (p) => p.margin * p.model.mu) / den : 1;
  const rms = (f) => Math.sqrt(sum(preds, (p) => f(p) ** 2) / preds.length);
  const sigmaT = rms((p) => p.points - p.model.total);
  const grid = GRID[sport] ?? [SIGMA[sport]];
  const loss = grid.map((sigma) => score(sport, adjust(preds, { kRel, sigma, sigmaT })).logloss);
  const sigma = grid[loss.indexOf(Math.min(...loss))]; // empate = el menor
  return { k: MU_SHRINK[sport] * kRel, kRel, sigma, residualSd: rms((p) => p.margin - kRel * p.model.mu), sigmaT };
}

// ---------- atp ----------
const ATP_SEASON = 2026;
const ATP = new URL('../data/atp-history.json', import.meta.url);

export { eloStep }; // el test comprueba que la pasada incremental deja lo mismo que eloFrom

// Una pasada cronológica: cada partido de la temporada se predice con el Elo de ese momento y después lo actualiza.
// El Elo de un jugador solo cambia con sus partidos, así que no hay fuga. Los retiros no se miden (eloFrom los ignora).
export function predictAtp(matches, season) {
  const elo = new Map();
  const out = [];
  for (const m of finished(matches)) {
    if (!m.retired && new Date(m.date).getUTCFullYear() === season) {
      out.push({ id: m.id, a: m.a.id, b: m.b.id, outcome: m.winner === 'a' ? 'H' : 'A', p: matchProb(elo, m.a.id, m.b.id, m.surface) });
    }
    eloStep(elo, m);
  }
  return out;
}

// p = P(gana A), igual al ml de marketsFor('tennis'): serveFromMatchProb la reproduce en matchDist.
export const scoreAtp = (preds) => metrics('tennis', preds.map(({ p, outcome }) => ({ outcome, p: { H: p, A: 1 - p } })));

// Referencia: la forma, sin fuga. q = (victorias + 1) / (partidos + 2) de cada jugador en las 52 semanas previas y
// P(gana A) = logística de c·(logit qa − logit qb), con c el de menor log-loss en la temporada anterior.
export function formBaseline(matches, season) {
  const ms = finished(matches).filter((m) => !m.retired);
  const recent = new Map(); // id -> [[t, ganó]]
  const rows = [];
  for (const m of ms) {
    const t = Date.parse(m.date), y = new Date(t).getUTCFullYear();
    const q = (id) => {
      const r = (recent.get(id) ?? []).filter(([d]) => t - d < 364 * DAY);
      recent.set(id, r);
      return (r.filter(([, w]) => w).length + 1) / (r.length + 2);
    };
    if (y === season || y === season - 1) rows.push({ y, x: Math.log(q(m.a.id) / (1 - q(m.a.id))) - Math.log(q(m.b.id) / (1 - q(m.b.id))), outcome: m.winner === 'a' ? 'H' : 'A' });
    for (const [id, w] of [[m.a.id, m.winner === 'a'], [m.b.id, m.winner === 'b']]) (recent.get(id) ?? recent.set(id, []).get(id)).push([t, w]);
  }
  const at = (c, rs) => metrics('tennis', rs.map(({ x, outcome }) => ({ outcome, p: { H: 1 / (1 + Math.exp(-c * x)), A: 1 - 1 / (1 + Math.exp(-c * x)) } })));
  const fit = rows.filter((r) => r.y === season - 1);
  const c = Array.from({ length: 31 }, (_, i) => i / 20).reduce((a, b) => (at(b, fit).logloss < at(a, fit).logloss ? b : a));
  return { c, ...at(c, rows.filter((r) => r.y === season)) };
}

const atpMatches = async () => [...eloSnapshot(), ...JSON.parse(await readFile(ATP, 'utf8')).matches];

async function atpEntry() {
  const matches = finished(uniqueById(await atpMatches()));
  const preds = predictAtp(matches, ATP_SEASON);
  const m = scoreAtp(preds);
  const b = formBaseline(matches, ATP_SEASON);
  const out = { season: ATP_SEASON, n: m.n, brier: r4(m.brier), logloss: r4(m.logloss), baseline: { brier: r4(b.brier), logloss: r4(b.logloss) } };
  return { ...out, publish: out.brier < out.baseline.brier,
    note: 'La referencia es la forma: victorias de cada jugador en las 52 semanas previas, convertidas en probabilidad con lo ajustado en la temporada anterior.' };
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r1 = (x) => Math.round(x * 10) / 10;

async function main(args) {
  const valid = LEAGUES.map((l) => l.id);
  const ids = args.length ? args : valid;
  const bad = ids.filter((id) => !valid.includes(id));
  if (bad.length) {
    console.error(`Sin backtest: ${bad.join(', ')}. Ligas válidas: ${valid.join(' ')}`);
    process.exitCode = 2;
    return;
  }
  await mkdir(CACHE, { recursive: true });
  const espn = politeFetch(globalThis.fetch, { dir: CACHE });
  globalThis.fetch = espn; // lib/espn.mjs pide con el fetch global
  const runs = [];
  for (const id of ids.filter((x) => x !== 'atp')) {
    try {
      const { sport } = leagueById(id);
      const [test, prev] = [await getPastSeason(id, 1), await getPastSeason(id, 2)];
      runs.push({ id, sport, season: test.season, prev: prev.results, preds: predict(sport, prev.results, test.results) });
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (espn.blocked) {
    console.error(`ESPN respondió ${espn.blocked} tras 4 intentos: se detuvo sin pedir más. Lo bajado quedó en .cache/espn/;`
      + ' volver a correr más tarde reanuda desde ahí.');
  }
  const fits = {};
  for (const sport of new Set(runs.map((r) => r.sport).filter((s) => SPORT_MODEL[s] === 'normal'))) {
    const f = fitNormal(sport, runs.filter((r) => r.sport === sport).flatMap((r) => halves(r.preds)[0]));
    fits[sport] = f;
    console.log(`${sport}: k ${r2(f.k)}, σ ${f.sigma} (desvío real ${r2(f.residualSd)}), σ_T ${r1(f.sigmaT)}`
      + ` → lib/ratings.mjs tiene k ${MU_SHRINK[sport]}, σ ${SIGMA[sport]}, σ_T ${SIGMA_T[sport]}`);
    const grid = GRID[sport];
    if (grid && (f.sigma === grid[0] || f.sigma === grid.at(-1) || Math.abs(f.sigma - f.residualSd) > 0.15 * f.residualSd)) {
      console.warn(`${sport}: σ en el borde de la grilla o lejos del desvío real: revisar el modelo de mu antes de publicar`);
    }
  }
  const fresh = {};
  for (const { id, sport, season, prev, preds } of runs) {
    const f = fits[sport];
    const [cal, hold] = halves(f ? adjust(preds, f) : preds);
    const half = (ps) => {
      const m = score(sport, ps);
      const b = baseline(sport, prev, ps);
      return { n: m.n, brier: r4(m.brier), logloss: r4(m.logloss), baseline: { brier: r4(b.brier), logloss: r4(b.logloss) } };
    };
    const out = half(hold);
    const publish = out.brier < out.baseline.brier;
    fresh[id] = { season, ...out, publish, calibration: half(cal),
      ...(f && { k: r2(f.k), sigma: f.sigma, residualSd: r2(f.residualSd), sigmaT: r1(f.sigmaT) }) };
    console.log(`${id} ${season}: ${out.n} partidos de prueba, Brier ${out.brier} (referencia ${out.baseline.brier}), log-loss`
      + ` ${out.logloss} (referencia ${out.baseline.logloss}) → ${publish ? 'se publica' : 'NO se publica'}`);
  }
  if (ids.includes('atp')) {
    try {
      const a = (fresh.atp = await atpEntry());
      console.log(`atp ${a.season}: ${a.n} partidos, Brier ${a.brier} (referencia ${a.baseline.brier}), log-loss ${a.logloss}`
        + ` (referencia ${a.baseline.logloss}) → ${a.publish ? 'se publica' : 'NO se publica'}`);
    } catch (err) {
      console.error(`atp: ${err.message}`);
      process.exitCode = 1;
    }
  }
  // Aciertos por deporte con las mitades de prueba de todas sus ligas (más casos por tramo que liga por liga).
  const bins = {};
  for (const sport of new Set(runs.map((r) => r.sport))) {
    const f = fits[sport];
    bins[sport] = hitBins(sport, runs.filter((r) => r.sport === sport).flatMap((r) => halves(f ? adjust(r.preds, f) : r.preds)[1]));
  }
  if (!Object.keys(fresh).length) return;
  let old = {};
  try {
    old = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await writeFile(OUT, `${JSON.stringify({ ...old, ...fresh, _bins: { ...old._bins, ...bins } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
