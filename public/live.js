// En vivo: con lo que lleva un jugador (o el marcador) y cuánto falta, proyecta el final y avisa cuando el ritmo se sale
// de lo normal. Funciones puras: las usan la vista En vivo, el servidor (lib/espn.mjs → normLive) y los tests.
import { propOver, americanToDecimal } from './betmath.js';
import { statOf } from './stats.js';

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// Fracción jugada del tiempo reglamentario (0..1). period/clock como los da ESPN: en fútbol clock son los segundos
// jugados; en NBA/WNBA, los que quedan del periodo.
const PERIODS = { basketball: [4, 720], wnba: [4, 600] };
// Segundos del reloj de ESPN: el summary solo trae displayClock ("12:34", "45.2", "67'" en fútbol).
export function clockSecs(display) {
  const s = String(display ?? '').trim(), m = /^(\d+):(\d\d)/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+'/.test(s)) return parseInt(s, 10) * 60;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
export function progress(sport, league, { period, clock } = {}) {
  if (sport === 'soccer') return clamp01(clock / 5400);
  const [n, len] = PERIODS[league] ?? PERIODS[sport] ?? PERIODS.basketball;
  return clamp01(((period - 1) * len + (len - clock)) / (n * len));
}

// Cuántos partidos vale el promedio previo frente al ritmo de hoy. Marcador 8: scripts/live-backtest.mjs (NBA 2025-26)
// da de 2 a 8 empatados. Jugador 5: scripts/live-props-backtest.mjs (puntos, rebotes y asistencias de la NBA 2025-26, con
// playerShare) le gana a 1 por 9 errores estándar; de 3 a 20 empatan. shortcut: medido solo en la NBA.
const PRIOR = { player: 5, total: 8 };

// Lo que falta: el ritmo mezcla lo esperado antes del partido (mean) con lo que lleva (current) en la fracción jugada.
// La varianza de lo que falta conserva la dispersión del jugador (varianza / media).
export function remaining({ current, progress: f, mean, variance, prior = PRIOR.player }) {
  const rate = (mean * prior + current) / (prior + f);
  const rem = Math.max(0, (1 - f) * rate);
  return { mean: rem, variance: (mean > 0 ? variance / mean : 1) * rem, projected: current + rem };
}

// P(termina por encima de line) con lo que lleva y lo que le falta.
export function liveOver(kind, current, rem, line) {
  const need = line - current;
  if (need < 0) return 1;
  if (!(rem.mean > 0)) return 0;
  return propOver(kind, rem.mean, rem.variance, need);
}

// Qué tan raro es lo que lleva frente a lo esperado a esta altura, en desvíos (+ va por encima).
export const paceZ = ({ current, progress: f, mean, variance }) => (current - f * mean) / Math.sqrt(Math.max(variance * f, 1));

// 0 = sin señal, 1 temprana, 2 moderada, 3 fuerte. El contexto del partido sube o baja un nivel.
export const LEVELS = ['', 'temprana', 'moderada', 'fuerte'];
export function strength(z, support = 0) {
  const a = Math.abs(z);
  const base = a >= 2 ? 3 : a >= 1.5 ? 2 : a >= 1 ? 1 : 0;
  return base && Math.min(3, Math.max(1, base + support));
}

// Contexto que empuja la estadística de un jugador: s = +1 apoya el lado, −1 lo contradice. null si no aplica.
export function scriptFor(sport, stat, side, { margin, progress: f, fouls = 0 }) {
  const dir = side === 'Over' ? 1 : -1;
  if (sport === 'basketball') {
    if (fouls >= 4) return { s: -dir, text: `Tiene ${fouls} faltas: puede sentarse para no quedar fuera.` };
    if (f >= 0.6 && Math.abs(margin) >= 18) return { s: -dir, text: 'Partido muy definido: los titulares suelen descansar al final.' };
  }
  return null;
}

const NO_PACE = /_long$|^(dd|td)$/; // la más larga y el doble-doble no se acumulan con el tiempo
const MIN_F = 0.1, MAX_F = 0.95; // al inicio el ritmo es ruido; al final ya no hay líneas

// f = fracción del reloj (lo que se muestra); w = fracción de la producción esperada a esta altura (curva de anotación).
function signal({ id, kind, current, f, w = f, mean, variance, line, script, prior }) {
  const base = { current, progress: w, mean, variance, prior };
  const z = paceZ(base);
  const side = z >= 0 ? 'Over' : 'Under';
  const sc = script?.(side) ?? null;
  const level = strength(z, sc?.s ?? 0);
  if (!level) return null;
  const rem = remaining(base);
  return { id, kind, side, current, progress: f, expected: w * mean, mean, line, z, level, rem, projected: rem.projected, pOver: liveOver(kind, current, rem, line), script: sc, aligned: [1 + (sc?.s > 0), 1 + !!sc] };
}

// Señales de props de un partido en vivo. props = Prop[] de /api/props (Over y Under de cada línea); live = normLive.
export function propSignals(props, live, sport) {
  const f = live.progress;
  if (f < MIN_F || f > MAX_F) return [];
  const players = new Map(live.players.map((p) => [p.id, p]));
  const out = [];
  for (const pr of props) {
    const pl = players.get(pr.athleteId);
    if (pr.side !== 'Over' || !pl || NO_PACE.test(pr.stat) || !(pr.mean > 0)) continue;
    const current = statOf(sport, pr.stat, pl.stats);
    if (current == null) continue;
    const [team, opp] = pl.teamId === live.home.id ? [live.home, live.away] : [live.away, live.home];
    const margin = (team.score ?? 0) - (opp.score ?? 0);
    const sig = signal({ id: pr.id, kind: pr.kind, current, f, w: playerShare(sport, f), mean: pr.mean, variance: pr.variance, line: pr.line,
      script: (side) => scriptFor(sport, pr.stat, side, { margin, progress: f, fouls: pl.stats.pf ?? 0 }) });
    if (sig) out.push({ ...sig, player: pr.player, athleteId: pr.athleteId, team: team.abbr, stat: pr.stat });
  }
  // Una por jugador, la más fuerte: las combinadas (pase + tierra) repetían la misma señal.
  const best = new Map();
  for (const s of out) {
    const b = best.get(s.athleteId);
    if (!b || s.level > b.level || (s.level === b.level && Math.abs(s.z) > Math.abs(b.z))) best.set(s.athleteId, s);
  }
  return [...best.values()];
}

// Total del partido contra la línea previa de Oddsy (mercado 'ou'). Desvíos como SIGMA_T de lib/ratings.mjs (el test
// lo compara); en conteos, varianza = dispersión × media (fútbol ~ Poisson). Por liga antes que
// por deporte: la WNBA (16.4, reajustado con la WNBA 2025 en caché) anota menos que la NBA.
export const TOTAL = { basketball: { kind: 'normal', sd: 19.2 }, wnba: { kind: 'normal', sd: 16.4 }, soccer: { kind: 'count', disp: 1 } };
export function totalSignal(live, line, sport) {
  const t = TOTAL[live.league] ?? TOTAL[sport], f = live.progress;
  if (!t || !(line > 0) || f < MIN_F || f > MAX_F) return null;
  const variance = t.kind === 'normal' ? t.sd ** 2 : t.disp * line;
  return signal({ id: `${live.id}|total`, kind: t.kind, current: (live.home.score ?? 0) + (live.away.score ?? 0), f, w: scoringShare(sport, f), mean: line, variance, line, prior: PRIOR.total });
}

// Línea del total principal: el fútbol trae seis 'ou' (0.5 a 5.5); vale la más pareja, como picksOf en lib/markets.mjs.
const evenness = (m) => Math.abs(m.selections[0].p - 0.5);
export const mainTotal = (markets) => (markets ?? []).filter((m) => m.key === 'ou')
  .reduce((a, m) => (a && evenness(a) <= evenness(m) ? a : m), null)?.selections[0].line ?? null;

// Cuota decimal (1.91 o 1,91) o americana (-110, +150). iOS escribe el menos como U+2212.
export function parseOdds(v) {
  const x = Number(String(v ?? '').trim().replace('−', '-').replace(',', '.'));
  return Math.abs(x) >= 100 ? americanToDecimal(x) : x > 1 ? x : null;
}

// Parte del total que se anota, en promedio, al terminar el 1.º, 2.º y 3.er cuarto, de la temporada anterior a la del
// backtest. NBA 2024-25 (1231 partidos): el 4.º rinde ~24 %; en 2025-26 mejora el log-loss por 0.0016 ± 0.0004
// (pareado). shortcut: la WNBA usa la de la NBA sin medir.
const CURVE = { basketball: [0.25, 0.5, 0.753] };
export function scoringShare(sport, f, curves = CURVE) {
  const c = curves[sport];
  if (!c) return f;
  const pts = [0, ...c, 1], i = Math.min(3, Math.floor(f * 4));
  return pts[i] + (pts[i + 1] - pts[i]) * (f * 4 - i);
}

// Lo mismo para un jugador (puntos, rebotes, asistencias): los de la rotación juegan más al principio de cada mitad y
// descansan en el 4.º, que les rinde ~22 %. NBA 2025-26 (scripts/live-props-backtest.mjs, 41 121 filas): medida en una
// mitad de la temporada y probada en la otra, baja el log-loss por 0.0010 ± 0.0005 (pareado). shortcut: sin jugadas de
// 2024-25 en caché, la curva es de la misma temporada del backtest.
const PLAYER_CURVE = { basketball: [0.268, 0.519, 0.779] };
export const playerShare = (sport, f) => scoringShare(sport, f, PLAYER_CURVE);

// ---------- pausas: momento para apostar ----------
// Orden: lo específico antes que "timeout" o "end". Duraciones típicas en segundos (estimación, no reloj oficial).
const STOPS = [
  [/official timeout|tv timeout/i, 'tv', 'Pausa comercial', 150],
  [/timeout/i, 'timeout', 'Tiempo muerto', 90],
  [/review|challenge/i, 'review', 'Revisión de jugada', 90],
  [/injury/i, 'injury', 'Atención a un lesionado', 120],
  [/halftime|end (of )?(the )?half/i, 'half', 'Medio tiempo', 900],
  [/end (of )?(the )?(period|quarter|regulation)/i, 'period', 'Fin del periodo', 120],
];
export function stopOf(text) {
  const hit = STOPS.find(([rx]) => rx.test(String(text ?? '')));
  return hit ? { kind: hit[1], label: hit[2] } : null;
}
// Segundos que faltarían para que siga el juego; null sin hora de inicio de la pausa. at = hora real de la jugada.
export function windowLeft(stop, now = Date.now()) {
  const at = Date.parse(stop?.at ?? '');
  const dur = STOPS.find((s) => s[1] === stop?.kind)?.[3];
  return Number.isFinite(at) && dur ? Math.max(0, Math.round(dur - (now - at) / 1000)) : null;
}
// ¿La pausa sigue en el partido real? ESPN publica las jugadas ~6 min tarde (medido el 2026-10-18), así que
// un tiempo muerto ya terminó cuando llega; el medio tiempo suele seguir. Sin hora: solo el medio tiempo.
export function isActive(stop, now = Date.now()) {
  const left = windowLeft(stop, now);
  return left == null ? stop?.kind === 'half' : left > 0;
}
