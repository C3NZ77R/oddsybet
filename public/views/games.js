// Partidos: lista por fecha (#/{liga}/games) y detalle (#/{liga}/games/{id}). Tenis (ATP): jugadores con bandera y rank,
// sin tendencias ni récords de equipo; el detalle lleva ?date= para encontrar el partido.
// Cuotas: solo las del modelo Oddsy (/api/markets): probabilidad, cuota justa y cuota Oddsy. Apuestas del público: sin fuente gratuita.
import * as bm from '../betmath.js';
import { leagueById } from '../leagues.js';
import { statForMarket } from '../stats.js';
import { ui as baseUi, dataOf, propKey, ymd } from '../ui.js';
import { mainTotal } from '../live.js';

const DAYS = 15; // hoy + 14
const TENNIS_DAYS = 3; // ESPN solo publica el cuadro de los próximos días
const SURF = { hard: 'Dura', clay: 'Arcilla', grass: 'Hierba' };
const REFRESH_MS = 60_000;
const REC_ORDER = ['overall', 'home', 'road', 'vsconf', 'vsdiv'];
const REC_LABEL = { overall: 'Total', home: 'Local', road: 'Visita', vsconf: 'Conferencia', vsdiv: 'División' };
const NO_PUBLISH = 'Todavía no mostramos cuotas en esta liga: Oddsy aún no predice mejor que usar los resultados de la temporada pasada';

let ui = baseUi; // ctx.ui de la vista montada (solo hay una a la vez)
const esc = (s) => ui.esc(s ?? '');

// ---------- utilidades puras (exportadas para pruebas) ----------
const signed = (x) => (x == null ? '' : x > 0 ? `+${x}` : x === 0 ? 'PK' : String(x));
const lineTxt = (m, s) => (m.key.startsWith('ou') ? s.line : signed(s.line)); // totales sin signo
// Mercado principal de la tarjeta: 1X2 en fútbol, ganador en el resto.
export const mainMarket = (markets) => markets?.find((m) => m.key === '1x2') ?? markets?.find((m) => m.key === 'ml') ?? null;
export const accText = (acc) => (acc?.brier != null
  ? `Qué tan bien predice Oddsy: Brier ${acc.brier.toFixed(3)} en ${acc.n} partidos ya jugados. Mientras más bajo, mejor; adivinar con los resultados de la temporada pasada da ${acc.baseline?.brier?.toFixed(3) ?? '—'}.`
  : 'Qué tan bien predice Oddsy: todavía no lo hemos medido en esta liga.');

// Qué se apuesta en cada mercado (claves de lib/markets.mjs), en palabras simples. n = primera selección, t = su línea.
const ORD = { 3: 'tercer', 4: 'cuarto', 5: 'quinto' };
const count = (what, t) => `Se cuentan ${what}.${t % 1 ? ` Más ${t} gana si hay ${Math.ceil(t)} o más; Menos ${t}, ${t < 1 ? 'si no hay ninguno' : `si hay ${Math.floor(t)} o menos`}.` : ''}`;
const shift = (n, t, unit) => `A ${n} se le ${t < 0 ? 'restan' : 'suman'} ${Math.abs(t)} ${unit} al final. Ganas si tu elección queda arriba después de ese ajuste.`;
const QUARTER = ' Si la línea es entera y quedan iguales, te devuelven la apuesta. Si termina en .25 o .75, la apuesta se reparte entre las dos líneas vecinas.';
const HOW = {
  ml: () => 'Eliges quién gana el partido. El marcador no importa.',
  '1x2': () => 'Eliges si gana el local, si empatan o si gana el visitante.',
  dc: () => 'Cubres dos de los tres resultados con una sola apuesta.',
  dnb: () => 'Eliges quién gana. Si empatan, te devuelven la apuesta.',
  ou: (n, t, m) => count(`los ${/Total de (\S+)/.exec(m.label)?.[1] ?? 'puntos'} de los dos equipos`, t),
  ou_home: (n, t) => count('solo los goles del local', t),
  ou_away: (n, t) => count('solo los goles del visitante', t),
  aou: () => `Se cuentan los goles de los dos equipos.${QUARTER}`,
  btts: () => 'Sí gana si los dos equipos marcan al menos un gol.',
  cs: () => 'Aciertas solo si el marcador final es exactamente ese.',
  ah: (n, t) => shift(n, t, 'goles') + QUARTER,
  spread: (n, t) => shift(n, t, 'puntos'),
  rl: (n, t) => shift(n, t, 'carreras'),
  sets: () => 'Aciertas solo si el marcador en sets es exactamente ese.',
  ou_sets: (n, t) => `Más ${t} gana si se juega un ${ORD[Math.ceil(t)] ?? `${Math.ceil(t)}.º`} set; Menos ${t}, si el partido se acaba antes.`,
  ou_games: (n, t) => count('todos los games del partido', t),
  games_hcp: (n, t) => shift(n, t, 'games'),
  win_set: () => 'Sí gana si se lleva por lo menos un set, aunque pierda el partido.',
  first_set: () => 'Solo cuenta el primer set. Lo que pase después no importa.',
  ou_set1: (n, t) => `${count('solo los games del primer set', t)} Si el set se define en tiebreak (7-6), son 13.`,
};

// ---------- piezas de UI ----------
const timeOf = (iso) => new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
const isLive = (g) => g.status?.state === 'in' || (g.status?.state === 'pre' && Date.parse(g.start) <= Date.now());
const selName = (g, s) => (s.name === 'Local' ? g.home.abbr || g.home.name : s.name === 'Visitante' ? g.away.abbr || g.away.name : s.name);
const selLabel = (g, m, s) => `${selName(g, s)}${s.line != null ? ` ${lineTxt(m, s)}` : ''}`;

// Botón de selección: nombre, línea, probabilidad, justa y Oddsy. picks = índice → pick del boleto.
function selBtn(g, m, s, ctx, compact = false) {
  const name = selLabel(g, m, s);
  const short = (t) => t.abbr || t.name;
  const matchup = ctx.tennis ? `${short(g.home)} vs ${short(g.away)}` : `${short(g.away)} @ ${short(g.home)}`;
  const pick = { id: `oddsy:${ctx.league}:${g.id}:${m.key}:${m.label}:${s.name}`, label: `${name} (${m.label}) · ${matchup}`, price: s.oddsy, book: 'oddsy', league: ctx.league, gameId: g.id };
  ctx.picks.push(pick);
  return `<button type="button" class="gm-sel${compact ? ' gm-sel-sm' : ''}" data-pick="${ctx.picks.length - 1}" aria-pressed="${ctx.store.hasPick(pick.id)}" aria-label="${esc(`${name}: probabilidad ${ui.fmtPct(s.p)}, justa ${ui.fmtOdds(s.fair)}, Oddsy ${ui.fmtOdds(s.oddsy)}. Agregar a Mis picks`)}">${compact ? `<b>${esc(ui.fmtOdds(s.oddsy))}</b></button>` : `
    <b>${esc(name)}</b><small>${esc(ui.fmtPct(s.p))}</small><span>Justa ${esc(ui.fmtOdds(s.fair))} · Oddsy <b>${esc(ui.fmtOdds(s.oddsy))}</b></span></button>`}`;
}
// Clic en una selección: alterna el pick en el boleto.
function onPickClick(e, ctx) {
  const pick = ctx.picks[e.target.closest('[data-pick]')?.dataset.pick];
  if (!pick) return false;
  ctx.store.hasPick(pick.id) ? ctx.store.removePick(pick.id) : ctx.store.addPick(pick);
  return true;
}
// El boleto puede cambiar desde el panel: se refleja en los botones sin redibujar.
const syncPicks = (root, ctx) => ctx.store.on('picks', (list) => {
  const ids = new Set(list.map((p) => p.id));
  for (const b of root.querySelectorAll('[data-pick]')) b.setAttribute('aria-pressed', String(ids.has(ctx.picks[b.dataset.pick]?.id)));
});

// Barra de tendencia: un segmento por partido (más reciente a la derecha).
function trend(values, good, bad, what) {
  const v = (values ?? []).filter((x) => x != null);
  if (!v.length) return '<span class="gm-trend gm-na">—</span>';
  const k = v.filter((x) => x === good).length;
  const label = `${what}: ${k} de ${v.length}`;
  return `<span class="gm-trend" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="gm-segs">${[...v].reverse().map((x) => `<i class="${x === good ? 'w' : x === bad ? 'l' : 'p'}"></i>`).join('')}</span><small>${k}/${v.length}</small></span>`;
}
const lastResults = (past, key) => (past ?? []).map((p) => p[key]);

function statusHtml(g) {
  const st = g.status?.state;
  if (st === 'in') return `<span class="gm-live">En vivo</span> <span>${esc(g.status.detail)}</span>`;
  if (st === 'post') return `<span>${esc(g.status.detail || 'Final')}</span>`;
  return `<span>${esc(timeOf(g.start))}</span>`;
}

function teamRow(g, side, tennis) {
  const t = g[side];
  const score = g.status?.state !== 'pre' && t.score != null ? `<b class="gm-score">${esc(t.score)}</b>` : '';
  return `<div class="gm-team">${ui.teamLogo(t)}<span class="gm-tname"><span class="gm-tl"><b>${esc(t.abbr || t.name)}</b> <small>${esc(t.name)}</small></span>
      <span class="gm-tl">${t.record ? `<small class="gm-rec">${esc(t.record)}</small>` : ''}${tennis ? '' : `<span class="gm-tr" data-trend="${side}"><span class="gm-trend gm-na" aria-hidden="true">…</span></span>`}</span></span>${score}</div>`;
}

// Mercado principal del partido (o el motivo por el que no hay).
function mainHtml(g, mk, ctx) {
  if (!mk) return ui.loading(1);
  if (mk.error) return `<p class="gm-src">No pudimos cargar las cuotas de Oddsy (${esc(mk.error.message ?? mk.error)}).</p>`;
  if (mk.accuracy?.publish === false) return `<p class="gm-src">${NO_PUBLISH}.</p>`;
  const m = mainMarket(mk.by.get(String(g.id)));
  if (!m) return '<p class="gm-src">Oddsy no tiene cuotas para este partido.</p>';
  const a = mk.accuracy;
  const chip = a?.brier != null ? `<span class="gm-acc-chip" title="${esc(accText(a))}">Brier ${a.brier.toFixed(3)} vs ${a.baseline?.brier?.toFixed(3) ?? '—'} · ${esc(a.n)} partidos</span>` : '';
  return `<div class="gm-mkh">${esc(m.label)}${chip}</div><div class="gm-sels">${m.selections.map((s) => selBtn(g, m, s, ctx)).join('')}</div>`;
}

function cardHtml(g, league, extra) {
  const tennis = extra.ctx.tennis;
  const sides = tennis ? ['home', 'away'] : ['away', 'home']; // en tenis home = jugador A, arriba
  const query = tennis && extra.date ? `?date=${encodeURIComponent(extra.date)}` : '';
  return `<article class="gm-card" data-id="${esc(g.id)}">
    <div class="gm-top"><span class="gm-status" data-status>${statusHtml(g)}</span>${g.tournament ? `<span class="gm-event">${esc([g.tournament, g.round].filter(Boolean).join(' · '))}</span>` : ''}</div>
    <div class="gm-teams">${sides.map((side) => teamRow(g, side, tennis)).join('')}</div>
    <div data-main>${mainHtml(g, extra.mk, extra.ctx)}</div>
    <div class="gm-foot">
      <details class="gm-public" data-public="${esc(g.id)}"${extra.open ? ' open' : ''}><summary>Apuestas del público</summary>
        <p>No lo mostramos: no hay una fuente gratuita que diga cuánta gente ni cuánto dinero va a cada lado.</p></details>
      <a class="gm-more" href="#/${esc(league)}/games/${encodeURIComponent(g.id)}${query}">Detalles del partido →</a>
    </div>
  </article>`;
}

// Pestañas accesibles propias (id único por grupo).
function tabsHtml(id, label, items) {
  return `<div role="tablist" class="gm-tabs" aria-label="${esc(label)}">${items.map((t, i) => `<button type="button" role="tab" id="${id}-t-${t.id}" aria-controls="${id}-p-${t.id}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>
    ${items.map((t, i) => `<div role="tabpanel" class="gm-panel" id="${id}-p-${t.id}" aria-labelledby="${id}-t-${t.id}" data-tab="${t.id}"${i ? ' hidden' : ''}>${t.html}</div>`).join('')}`;
}
function onTabClick(root, e, onOpen) {
  const t = e.target.closest('[role="tab"]');
  if (!t || !root.contains(t)) return false;
  for (const b of t.parentElement.children) {
    const sel = b === t;
    b.setAttribute('aria-selected', String(sel));
    const p = root.querySelector(`#${CSS.escape(b.getAttribute('aria-controls'))}`);
    if (p) p.hidden = !sel;
    if (sel && p) onOpen?.(p);
  }
  return true;
}

// ---------- lista ----------
async function renderList(root, ctx, lg, state) {
  const { api } = ctx;
  const tennis = lg.sport === 'tennis';
  root.innerHTML = `<header class="gm-header"><h1>Partidos · ${esc(lg.title)}</h1>${tennis ? '<a class="gm-more" href="#/tennis-rankings">Ranking ATP →</a>' : ''}<span class="gm-badges" data-badges></span></header>
    <nav class="gm-dates" aria-label="Fechas" data-dates></nav>
    <div class="gm-list" data-list>${ui.loading()}</div>
    <p class="gm-src" data-note hidden></p>`;

  const today = new Date();
  const days = Array.from({ length: tennis ? TENNIS_DAYS : DAYS }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  const res = await Promise.allSettled(days.map((d) => api.games(lg.id, ymd(d)).then(dataOf)));
  if (state.dead) return;
  const byDate = new Map();
  res.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.length) byDate.set(ymd(days[i]), r.value);
  });
  if (!byDate.size) {
    const err = res.find((r) => r.status === 'rejected');
    root.querySelector('[data-list]').innerHTML = err && res.every((r) => r.status === 'rejected')
      ? ui.errorBox(err.reason)
      : ui.empty(`No hay partidos de ${lg.title} programados entre hoy y los próximos ${days.length - 1} días.`);
    return;
  }

  root.querySelector('[data-badges]').innerHTML = ui.sourceBadge('espn') + ui.sourceBadge('oddsy');
  const pc = { league: lg.id, store: ctx.store, picks: [], tennis };
  state.cleanups.push(syncPicks(root, pc));
  // Cuotas del modelo por fecha: se piden al elegir el día y quedan en caché.
  const marketsOf = (date) => {
    if (!state.markets.has(date)) {
      state.markets.set(date, api.markets(lg.id, null, date)
        .then((r) => ({ accuracy: r.accuracy, by: new Map((r.data ?? []).map((x) => [String(x.gameId), x.markets])) }))
        .catch((error) => {
          state.markets.delete(date); // se reintenta al volver a dibujar
          return { error };
        }));
    }
    return state.markets.get(date);
  };

  const dates = [...byDate.keys()];
  const wanted = ctx.query?.get('date');
  state.date = byDate.has(wanted) ? wanted : dates[0];
  const label = (k) => {
    const d = days.find((x) => ymd(x) === k);
    const i = days.indexOf(d);
    if (i < 2) return i ? 'Mañana' : 'Hoy';
    const s = d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
    return s[0].toUpperCase() + s.slice(1);
  };
  const drawDates = () => {
    root.querySelector('[data-dates]').innerHTML = dates.map((k) => `<button type="button" data-date="${k}" aria-pressed="${k === state.date}">${esc(label(k))} <small>${byDate.get(k).length}</small></button>`).join('');
  };

  const io = tennis ? null : 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); loadTrend(en.target); }
  }, { rootMargin: '200px' }) : null;
  state.cleanups.push(() => io?.disconnect());

  // Tendencia de cada lado desde GameDetail.lastFive (se pide solo para las tarjetas visibles).
  const loadTrend = async (card) => {
    const id = card.dataset.id;
    if (!state.details.has(id)) state.details.set(id, api.game(lg.id, id).then(dataOf).catch(() => null));
    const d = await state.details.get(id);
    if (state.dead || !card.isConnected) return;
    for (const side of ['away', 'home']) {
      const slot = card.querySelector(`[data-trend="${side}"]`);
      if (slot) slot.innerHTML = trend(lastResults(d?.lastFive?.[side], 'result'), 'W', 'L', 'Partidos ganados');
    }
  };

  const drawList = () => {
    const games = [...byDate.get(state.date)].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const list = root.querySelector('[data-list]');
    const date = state.date;
    io?.disconnect();
    pc.picks = [];
    list.innerHTML = games.map((g) => cardHtml(g, lg.id, { mk: null, ctx: pc, open: state.open.has(g.id), date })).join('');
    if (!tennis) for (const card of list.querySelectorAll('.gm-card')) io ? io.observe(card) : loadTrend(card);
    const note = root.querySelector('[data-note]');
    marketsOf(date).then((mk) => {
      if (state.dead || date !== state.date) return;
      for (const g of games) {
        const slot = list.querySelector(`.gm-card[data-id="${CSS.escape(String(g.id))}"] [data-main]`);
        if (slot) slot.innerHTML = mainHtml(g, mk, pc);
      }
      note.textContent = mk.error || mk.accuracy?.publish === false ? '' : accText(mk.accuracy);
      note.hidden = !note.textContent;
    });
  };

  drawDates();
  drawList();

  root.addEventListener('click', (e) => {
    if (onPickClick(e, pc)) return;
    const b = e.target.closest('[data-date]');
    if (!b) return;
    state.date = b.dataset.date;
    try {
      history.replaceState(null, '', `#/${lg.id}/games?date=${state.date}`);
    } catch { /* sin history: no pasa nada */ }
    drawDates();
    drawList();
  });
  root.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('[data-public]');
    if (d) d.open ? state.open.add(d.dataset.public) : state.open.delete(d.dataset.public);
  }, true);

  // Marcadores en vivo: cada 60 s si el día elegido tiene partidos en juego.
  state.timer = setInterval(async () => {
    if (document.hidden) return; // pestaña oculta: no se gasta red
    if (!byDate.get(state.date)?.some(isLive)) return;
    try {
      const fresh = dataOf(await api.get('/api/games', { league: lg.id, date: state.date }, { fresh: true }));
      if (state.dead || !fresh?.length) return;
      byDate.set(state.date, fresh);
      drawList();
    } catch { /* se reintenta en el siguiente ciclo */ }
  }, REFRESH_MS);
}

// ---------- detalle ----------
function headerHtml(d) {
  const team = (side) => {
    const t = d[side];
    return `<div class="gm-hteam gm-${side}">${ui.teamLogo(t, { size: 40 })}<div><b>${esc(t.name)}</b><small>${side === 'home' ? 'Local' : 'Visita'}${t.record ? ` · ${esc(t.record)}` : ''}</small></div>
      ${d.status?.state !== 'pre' && t.score != null ? `<span class="gm-hscore">${esc(t.score)}</span>` : ''}</div>`;
  };
  const p = d.predictor;
  const pred = p && p.homeWinPct != null && p.awayWinPct != null
    ? `<div class="gm-pred"><span>${esc(d.away.abbr)} ${esc(ui.fmtPct(p.awayWinPct, 0))}</span>
        <span class="gm-predbar" role="img" aria-label="${esc(`Probabilidad de ganar según ESPN: ${d.away.abbr} ${ui.fmtPct(p.awayWinPct, 0)}, ${d.home.abbr} ${ui.fmtPct(p.homeWinPct, 0)}`)}"><i style="width:${(p.awayWinPct * 100).toFixed(1)}%"></i></span>
        <span>${esc(ui.fmtPct(p.homeWinPct, 0))} ${esc(d.home.abbr)}</span><small>Probabilidad de ganar según ESPN</small></div>`
    : '';
  const when = d.status?.state === 'pre' ? esc(ui.when(d.start)) : statusHtml(d);
  return `<div class="gm-hrow">${team('away')}<span class="gm-at">@</span>${team('home')}</div>
    <p class="gm-hstatus">${when}</p>${pred}`;
}

// Todos los mercados del modelo para el partido + récords ATS de ESPN.
function linesHtml(d, mk, ctx) {
  const lf = d.lastFive ?? {};
  const tr = (key, good, bad, what) => `<p class="gm-trends"><span>${esc(d.away.abbr)} ${trend(lastResults(lf.away, key), good, bad, `${d.away.abbr} ${what}`)}</span><span>${esc(d.home.abbr)} ${trend(lastResults(lf.home, key), good, bad, `${d.home.abbr} ${what}`)}</span><small>últimos ${Math.max(lf.away?.length ?? 0, lf.home?.length ?? 0) || 5}</small></p>`;
  const ats = `<section class="gm-mk"><h3>Récord contra el hándicap</h3>${d.ats ? recTable(d, d.ats) : ui.empty('ESPN no publica el récord contra el hándicap de este partido.')}</section>`;
  if (mk.error) return ui.errorBox(mk.error) + ats;
  if (mk.accuracy?.publish === false) return `<p class="gm-note">${NO_PUBLISH}.</p>${ats}`;
  if (!mk.data?.markets?.length) return ui.empty('Oddsy no tiene cuotas para este partido.') + ats;
  const trends = { ml: tr('result', 'W', 'L', 'ganó'), '1x2': tr('result', 'W', 'L', 'ganó'), spread: tr('ats', 'W', 'L', 'cubrió el hándicap'), ou: tr('ou', 'O', 'U', 'pasó el total') };
  return marketTables(d, mk, ctx, trends) + ats;
}

// Mercados del modelo como desplegables: el título muestra la opción más probable, dentro va qué se apuesta,
// una barra por probabilidad y la cuota. trends = HTML de tendencia por clave de mercado (solo en el primero de cada tipo).
export function marketTables(d, mk, ctx, trends = {}) {
  const head = '<thead><tr><th scope="col">Opción</th><th scope="col">Probabilidad</th><th scope="col">Justa</th><th scope="col">Oddsy</th></tr></thead>';
  const row = (m, s, top) => `<tr${s === top ? ' class="gm-top1"' : ''}><th scope="row">${esc(selName(d, s))}${s.line != null ? ` <span class="gm-line">${esc(lineTxt(m, s))}</span>` : ''}${s === top ? ' <small class="gm-tag">Más probable</small>' : ''}</th>
    <td><span class="gm-pc"><span class="gm-pbar" aria-hidden="true"><i style="width:${(s.p * 100).toFixed(1)}%"></i></span>${esc(ui.fmtPct(s.p))}</span></td><td>${esc(ui.fmtOdds(s.fair))}</td><td>${selBtn(d, m, s, ctx, true)}</td></tr>`;
  const seen = new Set(), main = mainTotal(mk.data.markets);
  return `<p class="gm-src">${ui.sourceBadge('oddsy')} Abre un mercado para ver todas las opciones. Toca una cuota Oddsy para agregarla a Mis picks.</p>
    <details class="gm-how"><summary>¿Cómo leer estas cuotas?</summary><dl>
      <dt>Probabilidad</dt><dd>Qué tan probable es, según Oddsy.</dd>
      <dt>Justa</dt><dd>La cuota sin margen: 1 dividido por la probabilidad.</dd>
      <dt>Oddsy</dt><dd>La cuota justa con un margen del 5%.</dd></dl></details>`
    + mk.data.markets.map((m, i) => {
      // La tendencia del total va en la línea principal (fútbol tiene 0.5 a 5.5), no en la primera.
      const t = !seen.has(m.key) && (m.key !== 'ou' || m.selections[0].line === main) && trends[m.key];
      if (t) seen.add(m.key);
      const top = m.selections.reduce((a, b) => (b.p > a.p ? b : a));
      const first = m.selections[0];
      const how = HOW[m.key]?.(selName(d, first), first.line, m);
      return `<details class="gm-mk gm-acc"${i ? '' : ' open'}><summary><h3>${esc(m.label)}</h3><span class="gm-fav" title="Opción más probable">${esc(selLabel(d, m, top))} · ${esc(ui.fmtPct(top.p))}</span></summary>
        ${how ? `<p class="gm-hint">${esc(how)}</p>` : ''}<div class="scroll"><table class="gm-mt">${head}<tbody>${m.selections.map((s) => row(m, s, top)).join('')}</tbody></table></div>${t || ''}</details>`;
    }).join('')
    + `<p class="gm-src">${esc(accText(mk.accuracy))}</p>`;
}

// Detalle de un partido de tenis: jugadores (enlace a su ficha), torneo y todos los mercados del modelo.
async function renderTennisDetail(root, ctx, lg, id, state) {
  root.innerHTML = `<a class="gm-back" href="#/${esc(lg.id)}/games">← Partidos</a><div data-detail>${ui.loading()}</div>`;
  const date = ctx.query?.get('date');
  const mk = await ctx.api.markets(lg.id, id, /^\d{8}$/.test(date ?? '') ? date : null);
  if (state.dead) return;
  const g = mk.data.game;
  const pc = { league: lg.id, store: ctx.store, picks: [], tennis: true };
  state.cleanups.push(syncPicks(root, pc));
  const player = (t, cls) => `<div class="gm-hteam ${cls}">${ui.teamLogo(t, { size: 40 })}<div><a class="tn-player" href="#/tennis-player/${encodeURIComponent(t.id)}"><b>${esc(t.name)}</b></a>
      <small>${esc(t.record ? `Ranking ${t.record}` : 'Sin ranking')}</small></div>${g.status?.state !== 'pre' && t.score != null ? `<span class="gm-hscore">${esc(t.score)}</span>` : ''}</div>`;
  const where = [g.tournament, g.round, SURF[g.surface], g.bestOf && `al mejor de ${g.bestOf} sets`].filter(Boolean).join(' · ');
  const markets = mk.accuracy?.publish === false ? `<p class="gm-note">${NO_PUBLISH}.</p>`
    : mk.data.markets.length ? marketTables(g, mk, pc) : ui.empty('Oddsy no tiene cuotas para este partido.');
  root.querySelector('[data-detail]').innerHTML = `<header class="gm-head"><div class="gm-hrow">${player(g.home, 'gm-away')}<span class="gm-at">vs</span>${player(g.away, 'gm-home')}</div>
      <p class="gm-hstatus">${esc(where)}</p><p class="gm-hstatus">${g.status?.state === 'pre' ? esc(ui.when(g.start)) : statusHtml(g)}</p></header>
    <section class="gm-main" aria-label="Mercados">${markets}</section>`;
  root.addEventListener('click', (e) => onPickClick(e, pc));
}

function recTable(d, recs) {
  const keys = [...new Set([...(recs.away ?? []), ...(recs.home ?? [])].map((r) => r.key))]
    .sort((a, b) => (REC_ORDER.indexOf(a) + 1 || 99) - (REC_ORDER.indexOf(b) + 1 || 99));
  if (!keys.length) return ui.empty('Sin récords.');
  const get = (side, k) => recs[side]?.find((r) => r.key === k);
  return `<div class="scroll"><table class="gm-rt"><thead><tr><th scope="col"></th><th scope="col">${esc(d.away.abbr)}</th><th scope="col">${esc(d.home.abbr)}</th></tr></thead><tbody>
    ${keys.map((k) => `<tr><th scope="row">${esc(REC_LABEL[k] || get('away', k)?.label || get('home', k)?.label || k)}</th><td>${esc(get('away', k)?.summary ?? '—')}</td><td>${esc(get('home', k)?.summary ?? '—')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function propsHtml(props, league, gameId, sport, kind) {
  const pick = {
    player: (p) => p.player && String(p.market || '').startsWith('player_'),
    team: (p) => /team/.test(p.market || ''),
    game: (p) => !String(p.market || '').startsWith('player_') && !/team/.test(p.market || ''),
  }[kind];
  const list = props.filter(pick);
  if (!list.length) {
    return ui.empty({
      player: 'Oddsy no tiene props de jugador para este partido.',
      team: 'Oddsy todavía no calcula apuestas por equipo, como los puntos de un solo equipo.',
      game: 'Oddsy todavía no calcula otras apuestas del partido, como líneas alternativas o margen de victoria.',
    }[kind]);
  }
  const top = (p) => (p.books ?? []).reduce((b, x) => (x.price > (b?.price ?? 0) ? x : b), null);
  const statName = (p) => statForMarket(sport, p.market)?.name || p.stat || p.market;
  // Jugador → (estadística, línea) → lados.
  const groups = new Map();
  for (const p of list) {
    const who = p.player || 'Partido';
    if (!groups.has(who)) groups.set(who, { team: p.team, lines: new Map() });
    const lk = `${p.stat ?? p.market}|${p.line}`;
    const lines = groups.get(who).lines;
    if (!lines.has(lk)) lines.set(lk, { p, sides: {} });
    lines.get(lk).sides[p.side] = p;
  }
  const sideCell = (p) => {
    if (!p) return '<td class="gm-na">—</td>';
    const b = top(p);
    const label = `${p.side === 'Over' ? 'Más de' : p.side === 'Under' ? 'Menos de' : p.side} ${p.line}`;
    return `<td>${kind === 'player' ? `<a href="#/${esc(league)}/props/${propKey(p)}" aria-label="${esc(`${p.player}: ${label} ${statName(p)}, ver detalle`)}">` : ''}${esc(p.line)} ${b ? `<b>${esc(ui.fmtOdds(b.price))}</b>${ui.bookChip(b.title || b.key)}` : ''}${kind === 'player' ? '</a>' : ''}</td>`;
  };
  return [...groups].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([who, g]) => `<section class="gm-player"><h3>${esc(who)}${g.team ? ` <small>${esc(g.team)}</small>` : ''}</h3>
    <div class="scroll"><table><thead><tr><th scope="col">Estadística</th><th scope="col">Más de</th><th scope="col">Menos de</th></tr></thead><tbody>
    ${[...g.lines.values()].map(({ p, sides }) => `<tr><th scope="row">${esc(statName(p))}</th>${sideCell(sides.Over)}${sideCell(sides.Under)}</tr>`).join('')}
    </tbody></table></div></section>`).join('');
}

function matchupHtml(d) {
  const A = esc(d.away.abbr), H = esc(d.home.abbr);
  const rank = (s) => (s?.rank ? ` <small class="gm-rank">${esc(s.rank)}º</small>` : '');
  const ts = d.teamStats ?? {};
  const keys = [...new Set([...(ts.away ?? []), ...(ts.home ?? [])].map((s) => s.key))];
  const get = (side, k) => ts[side]?.find((s) => s.key === k);
  const stats = keys.length
    ? `<div class="scroll"><table class="gm-rt"><thead><tr><th scope="col">Estadística</th><th scope="col">${A}</th><th scope="col">${H}</th></tr></thead><tbody>
      ${keys.map((k) => `<tr><th scope="row">${esc(get('away', k)?.label || get('home', k)?.label || k)}</th><td>${esc(get('away', k)?.display ?? '—')}${rank(get('away', k))}</td><td>${esc(get('home', k)?.display ?? '—')}${rank(get('home', k))}</td></tr>`).join('')}
      </tbody></table></div><p class="gm-src">Promedios de la temporada según ESPN. El número pequeño es su puesto en la liga.</p>`
    : ui.empty('ESPN no publica estadísticas de equipo para este partido.');
  const last = (side) => {
    const list = d.lastFive?.[side] ?? [];
    if (!list.length) return ui.empty('Sin partidos recientes.');
    const res = { W: 'G', L: 'P', T: 'E', P: 'E' }; // ganó / perdió / empate o push
    const ouTxt = { O: 'Más', U: 'Menos', P: 'Igual' };
    return `<ul class="gm-last">${list.map((p) => `<li><span>${esc(new Date(p.date).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }))}</span>
      <span>${p.home ? 'vs' : '@'} ${esc(p.opp?.abbr ?? p.opp?.name ?? p.opp)}</span>
      <b class="gm-r${esc(p.result)}">${esc(res[p.result] ?? p.result ?? '')} ${esc(p.score ?? '')}</b>
      <span>${p.ats ? `Hándicap: ${esc(res[p.ats] ?? p.ats)}` : ''}</span><span>${p.ou ? `Total: ${esc(ouTxt[p.ou] ?? p.ou)}` : ''}</span></li>`).join('')}</ul>`;
  };
  return `<section class="gm-mk"><h3>Apuestas del público</h3><p class="gm-src">No lo mostramos: no hay una fuente gratuita que diga cuánta gente ni cuánto dinero va a cada lado.</p></section>
    <section class="gm-mk"><h3>Estadísticas: ${A} vs ${H}</h3>${stats}</section>
    <section class="gm-mk"><h3>Récords</h3>${recTable(d, d.records ?? {})}</section>
    <section class="gm-mk"><h3>Últimos partidos · ${A}</h3>${last('away')}</section>
    <section class="gm-mk"><h3>Últimos partidos · ${H}</h3>${last('home')}</section>`;
}

function lineupHtml(d) {
  const side = (s) => {
    const t = d[s];
    const starters = d.starters?.[s];
    const people = starters?.length ? starters : d.rosters?.[s] ?? [];
    const row = (a) => `<li>${ui.headshot(a)}<span><b>${esc(a.name)}</b> <small>${esc([a.pos, a.jersey != null && a.jersey !== '' ? `#${a.jersey}` : ''].filter(Boolean).join(' · '))}</small></span></li>`;
    const inj = (d.injuries ?? []).filter((i) => String(i.teamId) === String(t.id) || i.teamAbbr === t.abbr);
    const list = starters?.length
      ? `<h4>Titulares</h4><ul class="gm-people">${people.map(row).join('')}</ul>`
      : people.length
        ? `<details><summary>Plantilla (${people.length}) <small>· ESPN aún no publica titulares</small></summary><ul class="gm-people">${people.map(row).join('')}</ul></details>`
        : ui.empty('Sin alineación ni plantilla disponibles.');
    return `<section class="gm-mk"><h3>${ui.teamLogo(t)} ${esc(t.name)}</h3>${list}
      <h4>Lesiones</h4>${inj.length ? `<ul class="gm-inj">${inj.map((i) => `<li><span><b>${esc(i.athlete?.name)}</b> <small>${esc(i.athlete?.pos ?? '')}</small><br><small>${esc(i.detail ?? '')}${i.date ? ` · ${esc(ui.when(i.date))}` : ''}</small></span><span class="gm-st gm-st-${esc(String(i.status).toLowerCase().replace(/[^a-z]/g, ''))}">${esc(ui.INJURY[i.status] ?? i.status)}</span></li>`).join('')}</ul>` : '<p class="gm-src">Sin lesionados reportados.</p>'}</section>`;
  };
  return side('away') + side('home');
}

function insightsHtml(d) {
  let list = [];
  try {
    list = bm.teamInsights?.(d) ?? [];
  } catch { /* datos incompletos: sin insights */ }
  if (!list.length) return ui.empty('ESPN no tiene datos suficientes para sacar tendencias de este partido.');
  return `<ul class="gm-ins">${list.map((i) => `<li><p>${esc(i.text)}</p>${i.pct != null ? `<small>${esc(ui.fmtPct(i.pct, 0))}${i.n ? ` · ${esc(i.k)} de ${esc(i.n)}` : ''}</small>` : ''}</li>`).join('')}</ul>`;
}

async function renderDetail(root, ctx, lg, id, state) {
  const { api } = ctx;
  root.innerHTML = `<a class="gm-back" href="#/${esc(lg.id)}/games">← Partidos</a><div data-detail>${ui.loading()}</div>`;
  const [dRes, mRes] = await Promise.allSettled([api.game(lg.id, id).then(dataOf), api.markets(lg.id, id)]);
  if (state.dead) return;
  const box = root.querySelector('[data-detail]');
  if (dRes.status === 'rejected' || !dRes.value) {
    box.innerHTML = ui.errorBox(dRes.reason ?? new Error('Partido no encontrado'));
    return;
  }
  const d = dRes.value;
  const mk = mRes.status === 'fulfilled' ? mRes.value : { error: mRes.reason };
  const pc = { league: lg.id, store: ctx.store, picks: [] };
  state.cleanups.push(syncPicks(root, pc));
  const lazy = (kind) => `<div data-props="${kind}">${ui.loading()}</div>`;

  box.innerHTML = `<header class="gm-head" data-head>${headerHtml(d)}</header>
    <div class="gm-cols">
      <section class="gm-main" aria-label="Mercados">
        ${tabsHtml('gmm', 'Mercados', [
          { id: 'lines', label: 'Cuotas', html: linesHtml(d, mk, pc) },
          { id: 'player', label: 'Props de jugador', html: lazy('player') },
          { id: 'team', label: 'Props de equipo', html: lazy('team') },
          { id: 'game', label: 'Props del partido', html: lazy('game') },
        ])}
      </section>
      <aside class="gm-side" aria-label="Análisis del partido">
        ${tabsHtml('gms', 'Análisis', [
          { id: 'matchup', label: 'Enfrentamiento', html: matchupHtml(d) },
          { id: 'lineup', label: 'Alineaciones', html: lineupHtml(d) },
          { id: 'insights', label: 'Tendencias', html: insightsHtml(d) },
        ])}
      </aside>
    </div>`;

  // Props: se piden al abrir la pestaña (el modelo lee el historial de cada jugador).
  let propsP = null;
  const loadProps = async (panel) => {
    const slot = panel.querySelector('[data-props]');
    if (!slot || slot.dataset.done) return;
    slot.dataset.done = '1';
    propsP ??= api.props(lg.id, id);
    try {
      const r = await propsP;
      if (state.dead) return;
      slot.innerHTML = (r.source ? `<p class="gm-src">${ui.sourceBadge(r.source)}</p>` : '') + propsHtml(dataOf(r) ?? [], lg.id, id, lg.sport, slot.dataset.props);
    } catch (err) {
      if (!state.dead) slot.innerHTML = ui.errorBox(err);
      delete slot.dataset.done;
      propsP = null;
    }
  };
  root.addEventListener('click', (e) => onPickClick(e, pc) || onTabClick(root, e, loadProps));

  state.timer = setInterval(async () => {
    if (document.hidden) return;
    if (!isLive(d)) return;
    try {
      const fresh = dataOf(await api.get('/api/game', { league: lg.id, id }, { fresh: true }));
      if (state.dead || !fresh) return;
      Object.assign(d, { status: fresh.status, home: fresh.home, away: fresh.away });
      root.querySelector('[data-head]').innerHTML = headerHtml(d);
    } catch { /* se reintenta en el siguiente ciclo */ }
  }, REFRESH_MS);
}

export default {
  title: 'Partidos',
  async render(el, ctx) {
    ui = ctx.ui;
    const lg = typeof ctx.league === 'string' ? leagueById(ctx.league) : ctx.league;
    const state = { dead: false, timer: null, date: null, details: new Map(), markets: new Map(), open: new Set(), cleanups: [] };
    const cleanup = () => {
      state.dead = true;
      clearInterval(state.timer);
      for (const f of state.cleanups) f();
    };
    el.innerHTML = '<div class="gm"></div>';
    const root = el.firstElementChild;
    if (!lg) {
      root.innerHTML = ui.empty('Liga desconocida.');
      return cleanup;
    }
    const id = ctx.params?.id;
    try {
      await (!id ? renderList(root, ctx, lg, state) : lg.sport === 'tennis' ? renderTennisDetail(root, ctx, lg, id, state) : renderDetail(root, ctx, lg, id, state));
    } catch (err) {
      if (!state.dead) root.innerHTML = ui.errorBox(err);
    }
    return cleanup;
  },
};
