// Seguimiento de apuestas de NBA: evalúa cada selección contra el partido en vivo y decide qué avisar. Funciones puras
// (sin red ni base de datos): las usa el tick del servidor y los tests. Reglas: docs/superpowers/specs/2026-10-31-seguir-apuestas-nba-design.md.
import { remaining, liveOver, playerShare, scoringShare, TOTAL, PRIOR } from '../public/live.js';
import { statOf, STATS } from '../public/stats.js';

/**
 * @typedef {{ id: string, betId: string, gameId: string, gameStart: string, market: 'ml'|'spread'|'total'|'prop',
 *   stat: string|null, athleteId: string|null, athleteName: string|null, side: 'Over'|'Under'|'home'|'away',
 *   line: number|null, odds: number|null, label: string, prior: { mean: number, variance: number, kind: string }|null,
 *   status: string, current: number|null, state: object }} Selection
 * @typedef {{ kind: 'near'|'won'|'lost'|'risk'|'danger'|'quarter'|'swing'|'void'|'push', text: string }} Alert
 */

const SPORT = 'basketball';
export const near = (line) => Math.max(1, Math.ceil(0.15 * line));
export const SWING_MS = 180_000;
const DONE = new Set(['cumplida', 'fallada', 'anulada', 'devuelta', 'no_seguida']);
const VOID = /POSTPONED|SUSPENDED|CANCEL/;

export function quartersDone(g) {
  if (g.status.state === 'post') return 4;
  if (!(g.period > 0)) return 0;
  return Math.min(4, g.period - 1 + (g.clock === 0 ? 1 : 0));
}

// ---------- textos ----------
const ORD = ['1.º', '2.º', '3.er', '4.º'];
const pct = (p) => `${Math.round(p * 100)} %`;
function left({ period, clock }) {
  if (clock == null || !(period > 0)) return '';
  const s = Math.floor(clock), when = period <= 4 ? `del ${ORD[period - 1]}` : 'de la prórroga';
  return ` · quedan ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} ${when}`;
}
const statName = (key) => STATS[SPORT].find((d) => d.key === key)?.name.toLowerCase() ?? key;
const teamsOf = (sel, g) => (sel.side === 'away' ? [g.away, g.home] : [g.home, g.away]);

// Doble-doble cerca: una de pts/reb/ast en 10+ y otra en 8+; triple-doble: dos en 10+ y la tercera en 8+.
function multiNear(stat, stats = {}) {
  const c = ['pts', 'reb', 'ast'].map((k) => stats[k] ?? 0).sort((a, b) => b - a);
  return stat === 'dd' ? c[0] >= 10 && c[1] >= 8 : c[1] >= 10 && c[2] >= 8;
}

// P(Más) en vivo de un prop con su media previa; null sin prior o en Sí/No (la media binaria no se acumula).
function propOverP(sel, g, current) {
  const p = sel.prior;
  if (!p || p.kind === 'binary') return null;
  const rem = remaining({ current, progress: playerShare(SPORT, g.progress), mean: p.mean, variance: p.variance, prior: PRIOR.player });
  return liveOver(p.kind, current, rem, sel.line);
}

/**
 * Pura: no muta sel. now = ms (solo para el límite de cambios de ventaja).
 * @returns {{ status: string, current: number|null, state: object, alerts: Alert[] }}
 */
export function evaluateSelection(sel, game, now) {
  const state = { ...sel.state }, alerts = [];
  const ctx = { state, post: game.status.state === 'post', say: (kind, text) => alerts.push({ kind, text }),
    done: (status, current) => ({ status, current, state, alerts }) };
  if (DONE.has(sel.status)) return ctx.done(sel.status, sel.current);
  if (VOID.test(game.status.name ?? '')) {
    ctx.say('void', `${sel.label}: anulada, el partido se aplazó o se suspendió`);
    return ctx.done('anulada', sel.current);
  }
  if (game.status.state === 'pre') {
    if (sel.market !== 'prop') state.q ??= 0; // base de los resúmenes por cuarto
    return ctx.done('pendiente', null);
  }
  return (sel.market === 'ml' || sel.market === 'spread' ? evalSide : evalOverUnder)(sel, game, now, ctx);
}

// Props y total: Más/Menos contra la línea de la persona.
function evalOverUnder(sel, g, now, { state, post, say, done }) {
  const prop = sel.market === 'prop';
  const pl = prop ? g.players.find((p) => p.id === sel.athleteId) : null;
  if (prop && post && !(pl?.stats.min > 0)) {
    say('void', `${sel.label}: anulada, no jugó`);
    return done('anulada', null);
  }
  const c = prop ? statOf(SPORT, sel.stat, pl?.stats) ?? 0 : (g.home.score ?? 0) + (g.away.score ?? 0);
  const L = sel.line, over = sel.side === 'Over', had = post ? 'terminó con' : 'lleva';
  if (c > L) {
    say(over ? 'won' : 'lost', over ? `¡Cumplida! ${sel.label} · ${had} ${c}` : `${sel.label}: se pasó, ${had} ${c}`);
    return done(over ? 'cumplida' : 'fallada', c);
  }
  if (post) {
    if (c === L) say('push', `${sel.label}: devuelta, quedó exacto en ${c}`);
    else say(over ? 'lost' : 'won', over ? `${sel.label}: terminó con ${c}, necesitaba ${Math.floor(L) + 1}` : `¡Cumplida! ${sel.label} · terminó con ${c}`);
    return done(c === L ? 'devuelta' : over ? 'fallada' : 'cumplida', c);
  }
  if (!prop) {
    const q = Math.min(3, quartersDone(g));
    state.q ??= q; // apuesta registrada con el partido en juego: el primer tick es la base, no un cuarto que acaba de cerrar
    if (q >= 1 && q > state.q) {
      const t = TOTAL.basketball;
      const rem = remaining({ current: c, progress: scoringShare(SPORT, g.progress), mean: L, variance: t.sd ** 2, prior: PRIOR.total });
      const p = liveOver(t.kind, c, rem, L);
      say('quarter', `${g.away.name} vs ${g.home.name} · fin del ${ORD[q - 1]} cuarto: van ${c}. A este ritmo terminan en ~${Math.round(rem.projected)}: tu ${sel.label} tiene ${pct(over ? p : 1 - p)}`);
      state.q = q;
    }
    return done('en_juego', c);
  }
  const need = Math.floor(L) + 1 - c;
  const close = L === 0.5 && /^(dd|td)$/.test(sel.stat) ? multiNear(sel.stat, pl?.stats) : need <= near(L);
  const unit = /^(dd|td)$/.test(sel.stat) ? '' : ` ${statName(sel.stat)}`;
  if (over) {
    if (close && !state.near) {
      const p = propOverP(sel, g, c);
      const how = unit ? `lleva ${c}, le faltan ${need}` : `va con ${pl.stats.pts ?? 0} pts, ${pl.stats.reb ?? 0} reb y ${pl.stats.ast ?? 0} ast`;
      say('near', `${sel.label}: ${how}${left(g)}${p == null ? '' : ` · ${pct(p)} de cumplir`}`);
      state.near = true;
    }
    const pf = pl?.stats.pf ?? 0;
    if (!state.riskFoul && (pf >= 5 || (pf >= 4 && g.period < 4))) {
      say('risk', `${sel.label}: tiene ${pf} faltas, puede sentarse`);
      state.riskFoul = true;
    }
    const [mine, opp] = pl?.teamId === g.away.id ? [g.away, g.home] : [g.home, g.away];
    if (!state.riskGame && pl && Math.abs((mine.score ?? 0) - (opp.score ?? 0)) >= 18 && g.progress >= 0.6) {
      say('risk', `${sel.label}: partido muy definido (${mine.score}-${opp.score}), los titulares suelen descansar al final`);
      state.riskGame = true;
    }
  } else if (close && !state.danger) {
    const p = propOverP(sel, g, c);
    say('danger', `${sel.label}: lleva ${c}${unit ? `, se pasa con ${need} más` : ''}${left(g)}${p == null ? '' : ` · ${pct(1 - p)} de cumplir`}`);
    state.danger = true;
  }
  return done('en_juego', c);
}

// Ganador y hándicap: resumen por cuarto y, desde el 4.º, aviso cuando cambia de ganando/cubriendo a lo contrario.
function evalSide(sel, g, now, { state, post, say, done }) {
  const [mine, opp] = teamsOf(sel, g);
  const m = (mine.score ?? 0) - (opp.score ?? 0), spread = sel.market === 'spread';
  const v = m + (spread ? sel.line : 0), score = `${mine.score ?? 0}-${opp.score ?? 0}`;
  if (post) {
    if (v > 0) say('won', `¡Cumplida! ${sel.label} · ${score}`);
    else if (v < 0) say('lost', `${sel.label}: ${spread ? 'no cubrió' : 'perdió'}, ${score}`);
    else say('push', `${sel.label}: devuelta, quedó justo en la línea (${score})`);
    return done(v > 0 ? 'cumplida' : v < 0 ? 'fallada' : 'devuelta', m);
  }
  const lead = Math.sign(v);
  const how = spread ? (lead > 0 ? 'cubre' : lead < 0 ? 'no cubre' : 'justo en la línea') : (lead > 0 ? 'va ganando' : lead < 0 ? 'va perdiendo' : 'van empatados');
  const wp = !spread && g.winProb != null ? ` · ${pct(sel.side === 'home' ? g.winProb : 1 - g.winProb)} de ganar según ESPN` : '';
  const q = Math.min(3, quartersDone(g));
  state.q ??= q;
  if (q >= 1 && q > state.q) {
    say('quarter', `${sel.label} · fin del ${ORD[q - 1]} cuarto: ${score}, ${how}${wp}`);
    state.q = q;
    if (lead) state.lead = lead;
  } else if (g.period >= 4 && lead) {
    if (state.lead == null) state.lead = lead; // registrada ya en el 4.º: la primera lectura es la base
    else if (lead !== state.lead && !(now - (state.swingAt ?? -Infinity) < SWING_MS)) {
      say('swing', `${sel.label}: ahora ${how}, ${score}${left(g)}${wp}`);
      state.lead = lead;
      state.swingAt = now;
    }
  }
  return done('en_juego', m);
}

// ---------- la apuesta completa ----------
/** @typedef {{ id: string, deviceId: string, book: string|null, odds: number|null, status: string,
 *   notified: { start?: true, final?: true }, selections: Selection[] }} Bet */
export const ACTIVE = new Set(['pendiente', 'en_juego']);
const SETTLED = new Set(['cumplida', 'anulada', 'devuelta']);

// Cuota al ganar: la de la casa si cumplieron todas; con anuladas o devueltas, el producto de las demás si la persona
// escribió cada cuota.
function payout(bet, sels) {
  const hit = sels.filter((s) => s.status === 'cumplida');
  if (hit.length === sels.length) return bet.odds ? ` · cuota ${bet.odds.toFixed(2)}` : '';
  return hit.every((s) => s.odds > 1) ? ` · cuota ${hit.reduce((t, s) => t * s.odds, 1).toFixed(2)}` : ' · cuota ajustada por tu casa';
}

/**
 * Evalúa las selecciones activas cuyo partido está en games (Map gameId → LiveGame) y arma un solo push con todo lo
 * que pasó en este tick (tag = id de la apuesta: el aviso nuevo reemplaza al anterior en la bandeja).
 * @returns {{ status: string, notified: object, selections: Selection[], push: { title, body, tag, url }|null }}
 */
export function updateBet(bet, games, now) {
  const notified = { ...bet.notified };
  if (!ACTIVE.has(bet.status)) return { status: bet.status, notified, selections: bet.selections, push: null };
  const lines = [], lost = [];
  const selections = bet.selections.map((s) => {
    const g = games.get(s.gameId);
    if (!g || !ACTIVE.has(s.status)) return s;
    const r = evaluateSelection(s, g, now);
    (r.status === 'fallada' ? lost : lines).push(...r.alerts.map((a) => a.text));
    return { ...s, status: r.status, current: r.current, state: r.state };
  });
  const betGames = [...new Set(bet.selections.map((s) => s.gameId))].map((id) => games.get(id)).filter(Boolean);
  const started = betGames.find((g) => g.status.state === 'in');
  if (started && !notified.start) {
    lines.unshift(`Empezó ${started.away.name} vs ${started.home.name}: seguimos tu apuesta`);
    notified.start = true;
  }

  const m = selections.length, combo = m > 1, one = selections[0].label;
  const tracked = selections.filter((s) => s.status !== 'no_seguida'), n = selections.filter((s) => s.status === 'cumplida').length;
  const count = `${n} de ${m} cumplidas`;
  let status, title = combo ? `Combinada de ${m}` : one, body = combo && lines.length ? [...lines, count] : lines;
  if (selections.some((s) => s.status === 'fallada')) {
    status = 'perdida';
    title = combo ? 'Se cayó tu combinada' : one;
    body = combo && lost.length ? [...lost, 'Ya no te avisamos de las demás.'] : lost;
  } else if (tracked.every((s) => SETTLED.has(s.status))) {
    if (!n) {
      status = 'anulada';
      title = combo ? 'Tu combinada quedó anulada' : one;
      body = lines;
    } else if (tracked.length < m) {
      status = 'parcial';
      title = 'Cumpliste las de NBA';
      body = [...lines, `${count}; faltan las que no seguimos`];
    } else {
      status = 'ganada';
      title = combo ? '¡Ganaste la combinada!' : `¡Cumplida! ${one}`;
      const pay = payout(bet, tracked);
      body = combo ? [...lines, `${n === m ? `Las ${m} selecciones cumplidas` : count}${pay}`] : pay ? [...lines, pay.slice(3)] : lines;
    }
  } else status = betGames.some((g) => g.status.state !== 'pre') ? 'en_juego' : 'pendiente';
  if (!ACTIVE.has(status)) notified.final = true;
  return { status, notified, selections, push: body.length ? { title, body: body.join('\n'), tag: bet.id, url: '/#/nba/seguir' } : null };
}
