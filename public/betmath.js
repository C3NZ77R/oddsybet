// Matemática de apuestas compartida por el navegador y los tests. Todas las cuotas en formato decimal.
// Convención: los datos inválidos devuelven null en vez de lanzar.

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// ---------- Cuotas ----------

export const decimalToAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

export const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

export const expectedValue = (prob, odds) => prob * odds - 1;

export const parlayOdds = (oddsList) => oddsList.reduce((p, o) => p * o, 1);

// ---------- Acierto, splits e insights ----------

const fin = (values) => (values ?? []).filter(Number.isFinite);
const isUnder = (side) => String(side).toLowerCase() === 'under';
const beats = (v, line, side) => (isUnder(side) ? v < line : v > line);

// pct excluye los push; null si no hay partidos decididos.
export function hitRate(values, line, side = 'Over') {
  const xs = fin(values);
  const hits = xs.filter((v) => beats(v, line, side)).length, pushes = xs.filter((v) => v === line).length;
  return { hits, pushes, n: xs.length, pct: xs.length > pushes ? hits / (xs.length - pushes) : null };
}

// Aciertos seguidos desde el más reciente (values[0]); un push corta la racha.
export function streak(values, line, side = 'Over') {
  let n = 0;
  for (const v of fin(values)) {
    if (!beats(v, line, side)) break;
    n++;
  }
  return n;
}

export function summarize(values) {
  const xs = fin(values).sort((a, b) => a - b), n = xs.length;
  if (!n) return { n, avg: null, median: null, min: null, max: null };
  return { n, avg: sum(xs) / n, median: n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2, min: xs[0], max: xs[n - 1] };
}

const DAY = 864e5;

// games: GameLog.games (del más reciente al más antiguo). Primero filtra y luego aplica la ventana,
// así "L10 de local" = los últimos 10 partidos de local. window: l5 | l10 | l20 | lN | h2h (con oppId) |
// season | prev | YYYY | all. daysRest: número exacto o '3+'. withAthlete/withoutAthlete: GameLog del
// compañero, o lista/Set de eventId en los que jugó.
export function splitGames(games, { window = 'all', oppId, location = 'all', minMinutes, maxMinutes, daysRest, withAthlete, withoutAthlete, result = 'all', maxMargin } = {}) {
  const list = games ?? [];
  const ids = (x) => x && new Set([...(x.games ?? x)].map((g) => String(typeof g === 'object' ? g.eventId : g)));
  const withSet = ids(withAthlete), withoutSet = ids(withoutAthlete);
  const rest = new Map(list.map((g, i) => [g, list[i + 1] ? Math.round((Date.parse(g.date) - Date.parse(list[i + 1].date)) / DAY) - 1 : null]));
  const restOk = (r) => daysRest == null || daysRest === '' || (Number.isFinite(r) && (String(daysRest).endsWith('+') ? r >= parseInt(daysRest, 10) : r === Number(daysRest)));
  const out = list.filter((g) =>
    (location === 'all' || g.home === (location === 'home')) &&
    (minMinutes == null || (g.minutes != null && g.minutes >= minMinutes)) &&
    (maxMinutes == null || (g.minutes != null && g.minutes <= maxMinutes)) &&
    restOk(rest.get(g)) &&
    (!withSet || withSet.has(String(g.eventId))) &&
    (!withoutSet || !withoutSet.has(String(g.eventId))) &&
    (result === 'all' || g.result === result) &&
    (maxMargin == null || (g.margin != null && Math.abs(g.margin) <= maxMargin)));
  const w = String(window).toLowerCase();
  const season = Math.max(...list.map((g) => g.season).filter(Number.isFinite));
  const lastN = /^l(\d+)$/.exec(w);
  if (lastN) return out.slice(0, +lastN[1]);
  if (w === 'h2h') return oppId == null ? [] : out.filter((g) => String(g.opp?.id) === String(oppId));
  if (w === 'season') return out.filter((g) => g.season === season);
  if (w === 'prev') return out.filter((g) => g.season === season - 1);
  if (/^\d{4}$/.test(w)) return out.filter((g) => g.season === +w);
  return out;
}

const num = (x) => String(Math.round(x * 10) / 10);
const LOC = { all: '', home: ' de local', away: ' de visitante' };

// Insights de un jugador para la línea del prop, en ambos lados: racha seguida, k de los últimos n
// (total, local, visita) y promedio vs. línea. statDef: { key, name, from? } de stats.js.
export function insightsFor({ athlete, gamelog, prop, statDef } = {}) {
  const line = Number(prop?.line);
  const games = gamelog?.games ?? [];
  if (prop?.line == null || !Number.isFinite(line) || !games.length) return [];
  const key = statDef?.key ?? prop?.stat;
  const valueOf = (g) => {
    try {
      return statDef?.from ? statDef.from(g.stats ?? {}) : g.stats?.[key];
    } catch {
      return null;
    }
  };
  const who = athlete?.name ?? gamelog?.athlete?.name ?? prop?.player ?? 'El jugador';
  const stat = String(statDef?.name ?? statDef?.label ?? key ?? '').toLowerCase();
  const out = [];
  for (const location of ['all', 'home', 'away']) {
    const vals = fin(splitGames(games, { location }).map(valueOf));
    for (const side of ['Over', 'Under']) {
      const verb = side === 'Over' ? 'superó' : 'quedó por debajo de';
      const base = { side, line, location, stat: key };
      const s = streak(vals, line, side);
      if (s >= 4) {
        const avg = summarize(vals.slice(0, s)).avg;
        out.push({ ...base, type: 'streak', k: s, n: s, pct: 1, avg, text: `${who} ${verb} ${num(line)} ${stat} en ${s} partidos seguidos${LOC[location]} (promedio ${num(avg)})` });
        continue;
      }
      const top = [10, 20, 5]
        .filter((n) => vals.length >= n)
        .map((n) => ({ n, ...hitRate(vals.slice(0, n), line, side) }))
        .filter((r) => r.pct >= 0.7)
        .sort((a, b) => b.pct - a.pct || b.n - a.n)[0];
      if (top) {
        const avg = summarize(vals.slice(0, top.n)).avg;
        out.push({ ...base, type: 'kofn', k: top.hits, n: top.n, pct: top.pct, avg, text: `${who} ${verb} ${num(line)} ${stat} en ${top.hits} de sus últimos ${top.n} partidos${LOC[location]} (promedio ${num(avg)})` });
      }
    }
    // Promedio de los últimos 10 al menos un 20% lejos de la línea.
    const l10 = vals.slice(0, 10), avg = summarize(l10).avg;
    if (location === 'all' && l10.length >= 5 && line > 0 && Math.abs(avg - line) / line >= 0.2) {
      const side = avg > line ? 'Over' : 'Under', hr = hitRate(l10, line, side);
      out.push({ side, line, location, stat: key, type: 'avg', k: hr.hits, n: l10.length, pct: hr.pct, avg, text: `${who} promedia ${num(avg)} ${stat} en sus últimos ${l10.length} partidos, ${avg > line ? 'por encima' : 'por debajo'} de la línea de ${num(line)}` });
    }
  }
  const rank = { streak: 2, kofn: 1, avg: 0 };
  return out.sort((a, b) => rank[b.type] - rank[a.type] || b.pct - a.pct || b.n - a.n);
}

const parseRec = (s) => {
  const m = /^(\d+)-(\d+)(?:-(\d+))?/.exec(String(s ?? '').trim());
  return m && { w: +m[1], l: +m[2], t: +(m[3] ?? 0) };
};
const recText = ({ w, l, t }) => `${w}-${l}${t ? `-${t}` : ''}`;
const recContext = (rec) => {
  const s = `${rec.key ?? ''} ${rec.label ?? ''}`.toLowerCase();
  if (/underdog|\bdog|no fav/.test(s)) return 'como no favorito';
  if (/fav/.test(s)) return 'como favorito';
  if (/home|local|casa/.test(s)) return 'de local';
  if (/road|away|visit/.test(s)) return 'de visitante';
  return /overall|total|general|^ats\b/.test(s) ? 'en la temporada' : null;
};

// Insights de equipo desde GameDetail: ATS de la temporada (total, local, visita, favorito, no favorito),
// récord como favorito/no favorito, ATS, over/under y ganados/perdidos en los últimos 5.
export function teamInsights(game) {
  const out = [];
  for (const team of ['home', 'away']) {
    const t = game?.[team];
    if (!t) continue;
    const name = t.name ?? t.abbr ?? (team === 'home' ? 'El local' : 'El visitante');
    const base = { team, teamId: t.id ?? null };
    for (const rec of game.ats?.[team] ?? []) {
      const ctx = recContext(rec), r = parseRec(rec.summary);
      if (!ctx || !r || r.w + r.l < 3) continue;
      const pct = r.w / (r.w + r.l);
      out.push({ ...base, type: 'ats', market: 'spread', k: r.w, n: r.w + r.l, pct, text: `${name} va ${recText(r)} (${Math.round(pct * 100)}%) contra el hándicap ${ctx}` });
    }
    for (const rec of game.records?.[team] ?? []) {
      const ctx = recContext(rec), r = parseRec(rec.summary);
      if ((ctx !== 'como favorito' && ctx !== 'como no favorito') || !r || r.w + r.l < 3) continue;
      const pct = r.w / (r.w + r.l);
      out.push({ ...base, type: ctx === 'como favorito' ? 'favorite' : 'underdog', market: 'moneyline', k: r.w, n: r.w + r.l, pct, text: `${name} va ${recText(r)} (${Math.round(pct * 100)}%) ${ctx} esta temporada` });
    }
    const last = game.lastFive?.[team] ?? [];
    const count = (xs, f, v) => xs.filter((g) => g[f] === v).length;
    const ats = last.filter((g) => ['W', 'L', 'P'].includes(g.ats));
    if (ats.length >= 3) {
      const r = { w: count(ats, 'ats', 'W'), l: count(ats, 'ats', 'L'), t: count(ats, 'ats', 'P') };
      if (r.w + r.l) out.push({ ...base, type: 'ats-last', market: 'spread', k: r.w, n: r.w + r.l, pct: r.w / (r.w + r.l), text: `${name} va ${recText(r)} contra el hándicap en sus últimos ${ats.length} partidos` });
    }
    const ou = last.filter((g) => ['O', 'U', 'P'].includes(g.ou));
    if (ou.length >= 3) {
      const o = count(ou, 'ou', 'O'), u = count(ou, 'ou', 'U');
      const [k, side] = o >= u ? [o, 'Over'] : [u, 'Under'];
      if (k / ou.length >= 0.6) out.push({ ...base, type: 'ou', market: 'total', side, k, n: ou.length, pct: k / ou.length, text: `Los partidos de ${name} terminaron ${side === 'Over' ? 'por encima' : 'por debajo'} del total en ${k} de los últimos ${ou.length}` });
    }
    const su = last.filter((g) => g.result === 'W' || g.result === 'L');
    const w = count(su, 'result', 'W'), l = su.length - w;
    if (su.length >= 3 && Math.max(w, l) / su.length >= 0.8) {
      out.push({ ...base, type: 'form', market: 'moneyline', k: w, n: su.length, pct: w / su.length, text: `${name} ${w >= l ? `ganó ${w}` : `perdió ${l}`} de sus últimos ${su.length} partidos` });
    }
  }
  return out;
}

// ---------- Distribuciones ----------

// Φ(x) con el algoritmo de Hart (West 2005), error ~1e-15.
export function normCdf(x) {
  const ax = Math.abs(x);
  let c = 0;
  if (ax <= 37) {
    const e = Math.exp(-ax * ax / 2);
    if (ax < 7.07106781186547) {
      let n = 3.52624965998911e-2 * ax + 0.700383064443688;
      n = n * ax + 6.37396220353165; n = n * ax + 33.912866078383; n = n * ax + 112.079291497871;
      n = n * ax + 221.213596169931; n = n * ax + 220.206867912376;
      let d = 8.83883476483184e-2 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207; d = d * ax + 86.7807322029461; d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831; d = d * ax + 793.826512519948; d = d * ax + 440.413735824752;
      c = (e * n) / d;
    } else {
      c = e / (ax + 1 / (ax + 2 / (ax + 3 / (ax + 4 / (ax + 0.65))))) / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

// En espacio logarítmico: sin desbordes por factoriales grandes.
const lnFactorial = (n) => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};

export function poissonPmf(k, lambda) {
  if (!Number.isInteger(k) || k < 0 || !(lambda >= 0)) return 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - lnFactorial(k));
}

// ---------- Precios del modelo Oddsy (lib/pricing.mjs los reexporta; el navegador cotiza líneas personalizadas) ----------
export const MARGIN = 0.05;
// Por encima, la cuota Oddsy topa en 1.01 y deja de cobrar el margen: esas selecciones no se publican.
export const MAX_P = 1 / (1.01 * (1 + MARGIN));
const clampOdds = (o) => Math.min(101, Math.max(1.01, o));
// La Oddsy se trunca a 2 decimales: redondeando hacia arriba, p·cuota pasaba de 1/(1 + MARGIN).
export const price = (p) => ({ p, fair: Math.round(clampOdds(1 / p) * 100) / 100, oddsy: Math.floor(clampOdds(1 / (p * (1 + MARGIN))) * 100 + 1e-9) / 100 }); // + 1e-9: 1.13 llega como 112.999…

// Binomial negativa por recurrencia; sin sobredispersión cae a Poisson.
export function negBinPmf(k, mean, variance) {
  if (!(variance > mean)) return poissonPmf(k, mean);
  const r = (mean * mean) / (variance - mean);
  const q = variance > 0 ? mean / (r + mean) : 0;
  let pk = Math.pow(1 - q, r);
  for (let i = 1; i <= k; i++) pk *= ((i - 1 + r) / i) * q;
  return pk;
}

// P(X > line); con línea entera usa P(X >= line + 0.5) (sin push).
export function normalOver(mu, sigma, line) {
  const cut = Number.isInteger(line) ? line + 0.5 : line;
  return 1 - normCdf((cut - mu) / sigma);
}

// P(más de line) de un prop (lib/props.mjs): normal o binomial negativa con la media y la varianza del jugador. En una
// línea entera el push se descuenta (la apuesta se devuelve); acotada a [0.01, 0.99].
export function propOver(kind, mean, variance, line) {
  if (kind === 'binary') return Math.min(0.99, Math.max(0.01, line < 1 ? mean : 0)); // 0/1 por partido (doble-doble): la media es P(Más 0.5)
  let over, under;
  if (kind === 'normal') {
    const sd = Math.max(Math.sqrt(variance), 1);
    over = normalOver(mean, sd, line);
    under = Number.isInteger(line) ? normCdf((line - 0.5 - mean) / sd) : 1 - over;
  } else {
    const cdf = (k) => Array.from({ length: Math.floor(k) + 1 }, (_, i) => negBinPmf(i, mean, variance)).reduce((t, x) => t + x, 0);
    over = 1 - cdf(line);
    under = Number.isInteger(line) ? (line > 0 ? cdf(line - 1) : 0) : 1 - over;
  }
  return Math.min(0.99, Math.max(0.01, over / (over + under)));
}

export const MIN_GAMES = 8;
export const NORMAL = new Set(['pts', 'pra', 'pr', 'pa']); // volúmenes altos: normal; el resto, binomial negativa

// La línea .5 donde Más queda más cerca del 50 %, como la pone Betano (una línea por jugador, 2026-11-04). Con la mediana
// + 0.5, un jugador de 1 robo quedaba en 1.5 con el Menos al 75 %, y Betano lo tiene en 0.5.
export function bookLine(kind, mean, variance) {
  const off = (l) => Math.abs(propOver(kind, mean, variance, l) - 0.5);
  let line = 0.5;
  while (propOver(kind, mean, variance, line + 1) >= 0.5) line += 1;
  return off(line + 1) < off(line) ? line + 1 : line;
}

// values: del más reciente al más viejo. null con menos de MIN_GAMES partidos. kind 'binary': la media es P(Más 0.5).
export function propLine(values, kind = 'count') {
  if (values.length < MIN_GAMES) return null;
  const avg = (xs) => sum(xs) / xs.length;
  const m = 0.5 * avg(values.slice(0, 10)) + 0.3 * avg(values) + 0.2 * avg(values.slice(0, 5));
  const variance = values.reduce((s, x) => s + (x - avg(values)) ** 2, 0) / (values.length - 1);
  const line = kind === 'binary' ? 0.5 : bookLine(kind, m, variance);
  return { line, mean: m, variance, pOver: propOver(kind, m, variance, line) };
}
