// Props: lista filtrable de props de jugador (como Outlier) y detalle de cada prop con historial real
// de ESPN, gráfico por partido, filtros de splits, matchup, lineup e insights.
import * as bm from '../betmath.js';
import * as S from '../stats.js';
import { leagueById } from '../leagues.js';
import * as ui from '../ui.js';
import * as B from '../betano.js';

const PAGE = 50;
const CONCURRENCY = 4;
const TTL = 10 * 60 * 1000;
const WINS = ['l5', 'l10', 'l20', 'h2h', 'season', 'prev'];
const SIDE = { Over: 'Más de', Under: 'Menos de' };
const MATCHUP = { favorable: 'Favorable', neutral: 'Neutral', desfavorable: 'Desfavorable' };
// Equipos por liga, para saber si un ranking defensivo está en el tercio alto o bajo.
const TEAMS = { nba: 30, wnba: 15, laliga: 20, epl: 20, ucl: 36, libertadores: 32, colombia: 20 };
// Palabra de las claves de ESPN (en inglés) con la que se busca "lo que permite" la defensa rival.
// shortcut: ESPN solo publica avgPointsAgainst (sin ranking) en el summary; el resto queda "—" hasta tener otra fuente.
const ALLOWED = { pts: 'points', reb: 'rebounds', ast: 'assists', '3pm': 'three', stl: 'steals', blk: 'blocks', to: 'turnovers', goals: 'goals', shots: 'shots', sot: 'shotsontarget' };

// --- utilidades ---
const str = (x) => (x == null ? '' : String(x)); // los helpers de texto de ui.js devuelven objetos Safe
const esc = ui.esc;
const { dataOf, propKey } = ui;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const fmtLine = (x) => (Number.isFinite(x) ? String(x) : '—');
const fmt1 = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : '—');
const pctTxt = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const defsOf = (sport) => S.STATS[sport] ?? [];
const defOf = (sport, stat, market) => defsOf(sport).find((d) => d.key === stat) ?? (market ? S.statForMarket(sport, market) : null);
const statName = (def, stat) => def?.name ?? def?.label ?? stat;
const propText = (side, line, def, stat) => `${SIDE[side] ?? side} ${fmtLine(line)} ${statName(def, stat)}`;
const who = (p) => (p.athleteId != null ? String(p.athleteId) : `n:${norm(p.player)}`);
const oddsy = (p) => p.books[0]; // única cuota: la del modelo Oddsy (con margen)
const MIN_GAMES = 8; // mismo mínimo que lib/props.mjs
const THIN = 'Tiene menos de 8 partidos: muy pocos para calcular una línea.';
const skel = '<span class="pp-skel" aria-label="Cargando"></span>';
const inSlip = (store, id) => store.get('picks').some((x) => x.id === id);
const valsOf = (games, sport, stat) => games.map((g) => S.statOf(sport, stat, g.stats)).filter(Number.isFinite);
const curSeason = (games) => Math.max(...games.map((g) => g.season).filter(Number.isFinite));
// La misma línea del servidor (bm.propLine); con menos de MIN_GAMES partidos, la mediana de los últimos 20 + 0.5.
// vals: del más reciente al más viejo.
export const medianLine = (vals, stat) => {
  const own = bm.propLine(vals, bm.NORMAL.has(stat) ? 'normal' : 'count')?.line;
  const med = bm.summarize(vals.slice(0, 20)).median;
  return own ?? (med == null ? 0.5 : Math.floor(med) + 0.5);
};

// Clave de propKey (ui.js). El router ya decodifica el segmento; se acepta también la clave sin decodificar.
export function parsePropKey(key) {
  for (const raw of [key, safeDecode(key)]) {
    try {
      const k = JSON.parse(raw);
      if (k && typeof k === 'object') return { athleteId: k.a ?? null, player: String(k.p ?? ''), stat: k.s ?? null, line: Number.isFinite(k.l) ? k.l : null, side: k.o === 'Under' ? 'Under' : 'Over', gameId: k.g ?? null };
    } catch { /* prueba la otra forma */ }
  }
  return null;
}
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Caché en memoria de game logs y detalles de partido, compartida por la lista y el detalle.
const cache = new Map(); // clave -> { at, p: promesa }
const done = new Map(); // clave -> valor resuelto (null si falló)
const fresh = (k) => cache.has(k) && Date.now() - cache.get(k).at < TTL;
function load(k, fn) {
  if (!fresh(k)) {
    const p = Promise.resolve().then(fn).then(dataOf).catch(() => (cache.set(k, { at: Date.now() - TTL + 30_000, p }), null)).then((v) => (done.set(k, v), v)); // falló: se reintenta a los 30 s
    cache.set(k, { at: Date.now(), p });
  }
  return cache.get(k).p;
}
const logKey = (league, id) => `log:${league}:${id}`;
const gameKey = (league, id) => `game:${league}:${id}`;
const loadLog = (api, league, id) => load(logKey(league, id), () => api.gamelog(league, id));
const loadGame = (api, league, id) => load(gameKey(league, id), () => api.game(league, id));

// % de acierto con n = partidos decididos (sin push), igual que el pct de betmath.hitRate.
function rate(vals, line, side) {
  const r = bm.hitRate(vals, line, side);
  return { hits: r.hits, n: r.n - r.pushes, pct: r.pct };
}

// Lado del jugador y rival en el partido: por el teamId del game log, o por team/opp del prop.
const teamIds = (t) => (t == null ? [] : typeof t === 'object' ? [t.id, t.abbr, t.name] : [t]).filter((v) => v != null && v !== '').map((v) => String(v).toLowerCase());
const isTeam = (t, x) => teamIds(x).some((v) => teamIds(t).includes(v));
function sidesOf(game, teamId, p) {
  if (!game?.home || !game?.away) return null;
  let mine = sameId(game.home.id, teamId) ? 'home' : sameId(game.away.id, teamId) ? 'away' : null;
  if (!mine && p?.team) mine = isTeam(game.home, p.team) ? 'home' : isTeam(game.away, p.team) ? 'away' : null;
  if (!mine && p?.opp) mine = isTeam(game.home, p.opp) ? 'away' : isTeam(game.away, p.opp) ? 'home' : null;
  if (!mine) return null;
  const opp = mine === 'home' ? 'away' : 'home';
  return { mine, opp, team: game[mine], oppTeam: game[opp] };
}

// Estadística que permite la defensa rival (si ESPN la publica) y su clasificación para el lado elegido.
// Se asume rank 1 = la defensa que menos permite, como en los rankings de ESPN.
function allowedStat(teamStats, stat) {
  const w = ALLOWED[stat];
  if (!w || !Array.isArray(teamStats)) return null;
  return teamStats.find((s) => { const k = norm(s.key); return k.includes(w) && /against|allowed|conceded|opp/.test(k); }) ?? null;
}
function matchupFrom(st, league, side) {
  if (!st) return null;
  const rank = Number.isFinite(st.rank) ? st.rank : null, n = TEAMS[league] ?? 30;
  let cls = null;
  if (rank != null) {
    const t = rank > (2 * n) / 3 ? 'favorable' : rank <= n / 3 ? 'desfavorable' : 'neutral';
    cls = side === 'Under' ? ({ favorable: 'desfavorable', desfavorable: 'favorable', neutral: 'neutral' })[t] : t;
  }
  return { stat: st, rank, cls };
}

const hrCls = (pct) => (pct == null ? 'pp-na' : pct >= 0.8 ? 'pp-h4' : pct >= 0.65 ? 'pp-h3' : pct >= 0.5 ? 'pp-h2' : pct >= 0.35 ? 'pp-h1' : 'pp-h0');
const hrCell = (h) => (h === undefined ? skel : h?.pct == null ? '<span class="pp-na">—</span>' : `<span class="pp-hr ${hrCls(h.pct)}" title="${h.hits} de ${h.n}">${pctTxt(h.pct)}</span>`);
const day = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
const gameLabel = (g) => `${day(g.date)}\n${g.home ? 'vs' : '@'} ${g.opp?.abbr ?? ''}`;
const dd = (id, label, body, cls = '') => `<details class="pp-dd ${cls}" data-dd="${id}"><summary>${label}<span class="pp-n" data-b="${id}"></span></summary><div class="pp-pop">${body}</div></details>`;
const check = (name, value, label, on, extra = '') => `<label class="pp-check"><input type="checkbox" data-f="${name}" value="${esc(value)}"${on ? ' checked' : ''}> <span>${label}</span>${extra}</label>`;

// Cierra los menús desplegables al abrir otro, al hacer clic fuera o con Escape.
function popovers(root) {
  const closeAll = (except) => root.querySelectorAll('details.pp-dd[open]').forEach((d) => d !== except && d.removeAttribute('open'));
  root.addEventListener('toggle', (e) => e.target.open && e.target.matches?.('.pp-dd') && closeAll(e.target), true);
  const onDoc = (e) => !e.target.closest?.('details.pp-dd') && closeAll();
  const onKey = (e) => {
    const open = e.key === 'Escape' && root.querySelector('details.pp-dd[open]');
    if (open) { open.removeAttribute('open'); open.querySelector('summary').focus(); }
  };
  document.addEventListener('click', onDoc);
  document.addEventListener('keydown', onKey);
  return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); };
}

// Búsqueda de cualquier jugador en ESPN: abre su detalle con una línea personalizada.
function playerSearch(root, ctx, defaultStat) {
  let timer = 0, seq = 0;
  root.addEventListener('input', (e) => {
    const input = e.target.closest('[data-psearch]');
    if (!input) return;
    const box = input.closest('.pp-search'), q = input.value.trim(), out = box.querySelector('[data-espn]');
    box.querySelectorAll('[data-plist] .pp-check').forEach((l) => (l.hidden = !!q && !norm(l.textContent).includes(norm(q))));
    clearTimeout(timer);
    if (q.length < 3) { out.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      out.innerHTML = '<p class="pp-muted">Buscando en ESPN…</p>';
      let list;
      try { list = dataOf(await ctx.api.search(ctx.league, q)) ?? []; } catch (err) { if (mine === seq) out.innerHTML = str(ui.errorBox(err)); return; }
      if (mine !== seq || !root.isConnected) return;
      out.innerHTML = list.length
        ? `<p class="pp-muted">Ábrelo y pon tu propia línea:</p><ul class="pp-results">${list.slice(0, 8).map((a) => `<li><a href="#/${esc(ctx.league)}/props/${esc(propKey({ athleteId: a.id, player: a.name, stat: defaultStat, line: null, side: 'Over', gameId: null }))}">${str(ui.headshot(a, { size: 32 }))}<span><b>${esc(a.name)}</b><small>${esc([a.teamAbbr, a.pos].filter(Boolean).join(' · '))}</small></span></a></li>`).join('')}</ul>`
        : '<p class="pp-muted">ESPN no encontró a ningún jugador con ese nombre.</p>';
    }, 350);
  });
}
const searchBox = (list = '') => `<div class="pp-search"><label class="pp-field">Buscar jugador <input type="search" data-psearch placeholder="Nombre del jugador" autocomplete="off"></label>${list}<div data-espn aria-live="polite"></div></div>`;

// Agrega o quita un prop del boleto y lo cuenta para "Populares".
function togglePick(ctx, id, label, book, gameId) {
  const { store, league } = ctx;
  if (inSlip(store, id)) return void store.removePick(id);
  store.addPick({ id, label, price: book.price, book: book.key ?? book.title, league, gameId: gameId ?? null });
  store.track(id, 'add');
}

// Guarda contra escribir en el contenedor si la vista ya cambió mientras se esperaba la red.
function mount(el) {
  el.innerHTML = `<div class="pp">${str(ui.loading())}</div>`;
  return () => el.isConnected;
}

// --- líneas de Betano ---
const BIG_EDGE = 0.15;
const BT_NOTE = 'Betano: su cuota y la ventaja (probabilidad Oddsy × cuota − 1). Arriba de 15 % suele ser algo que Oddsy no sabe (lesiones, minutos): revísalo antes de apostar.';
const edgeHtml = (e, tag = 'small') => `<${tag} class="${e > BIG_EDGE ? 'pp-ev-big' : e > 0 ? 'pos' : 'pp-na'}">${e > 0 ? '+' : ''}${Math.round(e * 100)} %</${tag}>`;
function btCell(p) {
  const e = B.edge(p.p, p.betano);
  return e == null ? '<span class="pp-na">—</span>' : `${esc(ui.fmtOdds(p.betano))} ${edgeHtml(e)}`;
}
const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'hace un momento' : m < 90 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
// Menú "Betano" de la lista: estado de las líneas y cómo instalar el marcador que las trae.
function betanoHtml(store) {
  const b = B.saved(store), n = b ? Object.keys(b.lines).length : 0;
  return `${n ? `<p>Tienes ${n} líneas de Betano, traídas ${ago(b.at)}. <button type="button" class="pp-link" data-act="btclear">Borrarlas</button></p>` : '<p class="pp-muted">Todavía no has traído líneas de Betano.</p>'}
    <p>Con el marcador "Oddsy ← Betano", cada prop usa la línea exacta de Betano y muestra su cuota. Se instala una vez; después, en betano.co, abres la página de la NBA (trae todos los partidos) o un partido y lo tocas.</p>
    <p>En el computador, arrastra este botón a la barra de marcadores: <a class="pp-btn" href="${esc(B.bookmarklet(location.origin))}" data-act="btlink">Oddsy ← Betano</a></p>
    <p>En el celular: <button type="button" class="pp-btn" data-act="btcopy">Copiar el código</button></p>
    <ol class="pp-steps"><li>En Chrome, guarda cualquier página como favorito (la estrella del menú ⋮) y edítalo.</li><li>Ponle de nombre oddsy, borra la URL y pega el código.</li><li>En Betano, toca la barra de direcciones, escribe oddsy y toca el favorito.</li></ol>
    <p class="pp-muted">En iPhone es igual en Safari y se abre desde Favoritos. Dentro de la app de Betano no funciona: abre betano.co en el navegador.</p>`;
}

// ======================= LISTA =======================
const memory = {}; // filtros por liga mientras dure la pestaña
const defaults = () => ({ stats: [], players: [], games: [], side: 'all', minOdds: '', maxOdds: '', minHit: '', hitWin: 'l10', matchup: [], sort: 'l10', dir: 'desc' });
const WIN_HEAD = { l5: ['Últ. 5', 'Últimos 5'], l10: ['Últ. 10', 'Últimos 10'], l20: ['Últ. 20', 'Últimos 20'], h2h: ['Vs rival', 'Contra este rival'], season: ['Temp.', 'Temporada actual'], prev: ['Temp. ant.', 'Temporada anterior'] };

async function renderList(el, ctx) {
  const { league, api, store } = ctx;
  const sport = leagueById(league)?.sport;
  const defs = defsOf(sport);
  const stillHere = mount(el);
  const [pr, gr] = await Promise.all([api.props(league).catch((error) => ({ error })), api.games(league).catch(() => null)]);
  if (!stillHere()) return undefined;

  const props = pr.error ? [] : (dataOf(pr) ?? []).filter((p) => p?.books?.length && Number.isFinite(p.line));
  const gamesById = new Map((dataOf(gr) ?? []).map((g) => [String(g.id), g]));
  const rowMap = new Map();
  const bt = league === 'nba' ? B.saved(store) : null;
  for (const p0 of props) {
    // Con línea de Betano, el prop pasa a esa línea y lleva su cuota (docs/superpowers/specs/2026-11-04-lineas-betano-design.md).
    const b = Number.isFinite(p0.variance) ? B.lineFor(bt, p0.player, p0.stat) : null;
    const a = b && B.atLine(p0, b[0]);
    const p = a ? { ...a, betano: p0.side === 'Over' ? b[1] : b[2] } : p0;
    const key = propKey(p);
    if (!rowMap.has(key)) rowMap.set(key, { p, key, who: who(p), def: defOf(sport, p.stat, p.market), price: oddsy(p).price });
  }
  const rows = [...rowMap.values()];
  const hasBt = rows.some((r) => r.p.betano != null);
  const f = (memory[league] ??= defaults());
  const presets = () => store.get('presets').props ?? [];
  const savePresets = (list) => store.set('presets', { ...store.get('presets'), props: list });
  let shown = PAGE, alive = true, active = 0, want = [], dirty = false;

  const logOf = (r) => (r.p.athleteId == null ? null : done.get(logKey(league, r.p.athleteId)));
  const detailOf = (r) => (r.p.gameId == null ? null : done.get(gameKey(league, r.p.gameId)));
  const gameOf = (r) => detailOf(r) || gamesById.get(String(r.p.gameId));
  const sides = (r) => sidesOf(gameOf(r), logOf(r)?.athlete?.teamId, r.p);
  function matchupOf(r) {
    const s = sides(r), gd = detailOf(r);
    return s && gd?.teamStats ? matchupFrom(allowedStat(gd.teamStats[s.opp], r.p.stat), league, r.p.side) : null;
  }
  // % de acierto por ventana; undefined = historial cargando, null = sin historial.
  function hits(r) {
    const log = logOf(r);
    if (!log) return log;
    const oppId = sides(r)?.oppTeam?.id ?? null;
    if (r.h && r.hLog === log && r.hOpp === oppId) return r.h;
    Object.assign(r, { hLog: log, hOpp: oppId });
    return (r.h = Object.fromEntries(WINS.map((w) => [w, rate(valsOf(bm.splitGames(log.games, { window: w, oppId }), sport, r.p.stat), r.p.line, r.p.side)])));
  }

  function visible() {
    const minA = f.minOdds === '' ? null : Number(f.minOdds), maxA = f.maxOdds === '' ? null : Number(f.maxOdds);
    return rows.filter((r) => {
      const p = r.p, am = bm.decimalToAmerican(r.price);
      if (f.stats.length && !f.stats.includes(p.stat)) return false;
      if (f.players.length && !f.players.includes(r.who)) return false;
      if (f.games.length && !f.games.includes(String(p.gameId))) return false;
      if (f.side !== 'all' && p.side !== f.side) return false;
      if ((minA != null && am < minA) || (maxA != null && am > maxA)) return false;
      if (f.minHit !== '') {
        const h = hits(r); // sin cargar todavía: se muestra hasta que llegue su historial
        if (h === null || (h && !(h[f.hitWin].pct * 100 >= Number(f.minHit)))) return false;
      }
      if (f.matchup.length && !f.matchup.includes(matchupOf(r)?.cls)) return false;
      return true;
    });
  }
  const SORT = { player: (r) => r.p.player, line: (r) => r.p.line, p: (r) => r.p.p, fair: (r) => r.p.fair, odds: (r) => r.price, ev: (r) => B.edge(r.p.p, r.p.betano), opp: (r) => matchupOf(r)?.rank ?? null };
  for (const w of WINS) SORT[w] = (r) => hits(r)?.[w]?.pct ?? null;
  function sorted(list) {
    const fn = SORT[f.sort] ?? SORT.l10, dir = f.dir === 'asc' ? 1 : -1;
    // Los vacíos (sin historial o sin dato) siempre al final.
    return list.map((r) => [r, fn(r)]).sort(([, a], [, b]) => (a == null) - (b == null) || (a == null ? 0 : (typeof a === 'string' ? a.localeCompare(b, 'es') : a - b) * dir)).map(([r]) => r);
  }

  function propCell(r) {
    const log = logOf(r), g = gameOf(r), s = sides(r);
    const team = s?.team?.abbr ?? log?.athlete?.teamAbbr ?? (typeof r.p.team === 'string' ? r.p.team : r.p.team?.abbr) ?? '';
    const match = g?.home ? `${g.away.abbr} @ ${g.home.abbr}` : '';
    return `<a class="pp-pl" href="#/${esc(league)}/props/${esc(r.key)}">${str(ui.headshot(log?.athlete ?? { name: r.p.player }, { size: 36 }))}<span><b>${esc(r.p.player)}</b><small>${esc([team, match].filter(Boolean).join(' · '))}</small><span>${esc(propText(r.p.side, r.p.line, r.def, r.p.stat))}</span></span></a>`;
  }
  function oppCell(r) {
    const s = sides(r);
    if (!s) return r.p.gameId != null && detailOf(r) === undefined ? skel : '<span class="pp-na">—</span>';
    const m = matchupOf(r), abbr = esc(s.oppTeam.abbr);
    if (m?.rank == null) return `<span class="pp-na" title="${m ? `Permite ${esc(m.stat.display ?? fmt1(m.stat.value))} por partido (ESPN no da el ranking)` : 'Ranking defensivo no disponible'}">— ${abbr}</span>`;
    return `<span class="pp-rank pp-${m.cls}" title="${MATCHUP[m.cls]}: ${esc(m.stat.label ?? '')} ${esc(m.stat.display ?? '')}">${m.rank}° ${abbr}</span>`;
  }
  function rowInner(r) {
    const h = hits(r), on = inSlip(store, r.key);
    return `<td><button type="button" class="pp-add" data-act="add" data-k="${esc(r.key)}" aria-pressed="${on}" aria-label="${on ? 'Quitar del' : 'Agregar al'} boleto: ${esc(`${r.p.player} ${propText(r.p.side, r.p.line, r.def, r.p.stat)}`)}">${on ? '✓' : '+'}</button></td>
      <td class="pp-c-prop">${propCell(r)}</td><td class="pp-num">${fmtLine(r.p.line)}</td>
      <td class="pp-num">${esc(ui.fmtPct(r.p.p, 1))}</td><td class="pp-num">${esc(ui.fmtOdds(r.p.fair))}</td><td class="pp-num"><b>${esc(ui.fmtOdds(r.price))}</b></td>${hasBt ? `<td class="pp-num">${btCell(r.p)}</td>` : ''}<td>${oppCell(r)}</td>
      ${WINS.map((w) => `<td class="pp-num">${hrCell(h === undefined ? undefined : h?.[w] ?? null)}</td>`).join('')}`;
  }
  const rowHtml = (r) => `<tr data-k="${esc(r.key)}" data-a="${esc(r.p.athleteId ?? '')}" data-g="${esc(r.p.gameId ?? '')}">${rowInner(r)}</tr>`;
  function head() {
    const cols = [['player', 'Jugador'], ['line', 'Línea', hasBt ? 'La de Betano cuando la trajiste; si no, la línea Oddsy' : 'Línea Oddsy: la mediana de sus últimos 20 partidos'], ['p', 'Prob.', 'Probabilidad según Oddsy'], ['fair', 'Justa', 'Cuota sin margen: 1 dividido por la probabilidad'], ['odds', 'Oddsy', 'Cuota Oddsy, con margen'], ...(hasBt ? [['ev', 'Betano', 'Cuota de Betano y la ventaja con la probabilidad de Oddsy']] : []), ['opp', 'Defensa rival', 'Puesto de la defensa rival (1 = la que menos permite)'], ...WINS.map((w) => [w, ...WIN_HEAD[w]])];
    return `<tr><th scope="col"><span class="sr-only">Boleto</span></th>${cols.map(([k, label, title]) => {
      const on = f.sort === k;
      return `<th scope="col" aria-sort="${on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="pp-sort" data-act="sort" data-sort="${k}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}${on ? (f.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
    }).join('')}</tr>`;
  }

  function paintTable() {
    const box = root.querySelector('[data-table]');
    const vis = sorted(visible());
    root.querySelector('[data-count]').textContent = `${vis.length}/${rows.length} props`;
    if (!rows.length) {
      box.innerHTML = `${pr.error ? str(ui.errorBox(pr.error)) : `${str(ui.empty('Abre un partido para ver sus props.'))}<p class="pp-muted">Aquí solo salen los próximos 3 partidos de hoy. <a href="#/${esc(league)}/games">Ver partidos</a></p>`}<p class="pp-muted">También puedes buscar cualquier jugador y revisar su historial con la línea que quieras.</p>${searchBox()}`;
      return;
    }
    const page = vis.slice(0, shown);
    box.innerHTML = vis.length
      ? `<div class="pp-scroll"><table class="pp-table"><thead>${head()}</thead><tbody>${page.map(rowHtml).join('')}</tbody></table></div>${vis.length > shown ? `<button type="button" class="pp-more" data-act="more">Ver más (${vis.length - shown} restantes)</button>` : ''}${hasBt ? `<p class="pp-muted">${BT_NOTE}</p>` : ''}`
      : str(ui.empty('Ningún prop cumple estos filtros.'));
    // Primero los partidos (rival y defensa), luego los historiales de las filas visibles y después el resto.
    const ids = (list, pick) => [...new Set(list.map(pick).filter((x) => x != null))];
    want = [...ids(vis, (r) => r.p.gameId).map((id) => ['game', id]), ...ids(vis, (r) => r.p.athleteId).map((id) => ['log', id])];
    pump();
    progress();
  }
  function refreshRows(kind, id) {
    for (const tr of root.querySelectorAll(`tr[data-${kind === 'log' ? 'a' : 'g'}="${CSS.escape(String(id))}"]`)) {
      const r = rowMap.get(tr.dataset.k);
      if (r) tr.innerHTML = rowInner(r);
    }
  }
  // Carga perezosa con a lo sumo CONCURRENCY peticiones; rellena las celdas en su sitio y reordena al terminar.
  function pump() {
    // Los game logs no cuentan contra el límite: api.gamelog junta los del mismo tick en una sola petición.
    while (alive && want.length && (active < CONCURRENCY || want[0][0] === 'log')) {
      const [kind, id] = want.shift();
      const k = kind === 'log' ? logKey(league, id) : gameKey(league, id);
      if (fresh(k)) {
        if (!done.has(k)) cache.get(k).p.then(() => alive && (refreshRows(kind, id), progress()));
        continue;
      }
      active++;
      (kind === 'log' ? loadLog : loadGame)(api, league, id).then(() => {
        active--;
        if (!alive) return;
        dirty = true;
        refreshRows(kind, id);
        progress();
        pump();
        if (!active && dirty) { dirty = false; paintTable(); }
      });
    }
  }
  function progress() {
    const ids = [...new Set(rows.map((r) => r.p.athleteId).filter((x) => x != null))];
    const n = ids.filter((id) => done.has(logKey(league, id))).length;
    root.querySelector('[data-progress]').textContent = n < ids.length ? `Cargando historial de jugadores: ${n}/${ids.length}` : '';
  }

  function badges() {
    const n = { stats: f.stats.length, players: f.players.length, games: f.games.length, side: f.side !== 'all' ? 1 : 0, odds: (f.minOdds !== '') + (f.maxOdds !== ''), hit: f.minHit !== '' ? 1 : 0, matchup: f.matchup.length };
    for (const b of root.querySelectorAll('[data-b]')) b.textContent = n[b.dataset.b] ? ` ${n[b.dataset.b]}` : '';
  }
  function presetsHtml() {
    return `<ul class="pp-presets">${presets().map((x, i) => `<li><button type="button" class="pp-link" data-act="load" data-i="${i}">${esc(x.name)}</button><button type="button" class="pp-x" data-act="del" data-i="${i}" aria-label="Borrar ${esc(x.name)}">×</button></li>`).join('') || '<li class="pp-muted">Aún no hay filtros guardados.</li>'}</ul>
      <div class="pp-row"><label class="pp-field">Nombre <input data-pname maxlength="40" placeholder="Mis props"></label><button type="button" class="pp-btn" data-act="save">Guardar filtros actuales</button></div>`;
  }
  function toolbar() {
    const statN = rows.reduce((m, r) => m.set(r.p.stat, (m.get(r.p.stat) ?? 0) + 1), new Map());
    const stats = [...statN].map(([k, n]) => { const d = defOf(sport, k); return check('stats', k, esc(d ? `${d.label} · ${statName(d, k)}` : k), f.stats.includes(k), ` <small>${n}</small>`); }).join('');
    const players = [...new Map(rows.map((r) => [r.who, r.p.player]))].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([k, name]) => check('players', k, esc(name), f.players.includes(k))).join('');
    const games = [...new Set(rows.map((r) => r.p.gameId).filter((x) => x != null))].map((id) => {
      const g = gamesById.get(String(id)), r = rows.find((x) => sameId(x.p.gameId, id));
      const label = g?.home ? `${g.away.abbr} @ ${g.home.abbr}` : [r.p.team, r.p.opp].filter((x) => typeof x === 'string').join(' vs ') || `Partido ${id}`;
      return check('games', String(id), esc(label), f.games.includes(String(id)), g?.start ? ` <small>${esc(ui.when(g.start))}</small>` : '');
    }).join('');
    const radio = (v, label) => `<label class="pp-check"><input type="radio" name="pp-side" data-f="side" value="${v}"${f.side === v ? ' checked' : ''}> <span>${label}</span></label>`;
    const winOpts = WINS.map((w) => `<option value="${w}"${f.hitWin === w ? ' selected' : ''}>${WIN_HEAD[w][1]}</option>`).join('');
    return `<div class="pp-bar" role="group" aria-label="Filtros de props">
      ${dd('presets', 'Filtros guardados', presetsHtml())}
      ${dd('stats', 'Estadísticas', `<div class="pp-list">${stats || '<p class="pp-muted">Sin props.</p>'}</div>`)}
      ${dd('players', 'Jugadores', searchBox(`<div class="pp-list" data-plist>${players}</div>`), 'pp-wide')}
      ${dd('games', 'Partidos', `<div class="pp-list">${games || '<p class="pp-muted">Sin partidos.</p>'}</div>`)}
      ${dd('side', 'Más/Menos', `${radio('all', 'Ambos')}${radio('Over', 'Más de (Over)')}${radio('Under', 'Menos de (Under)')}`)}
      ${dd('odds', 'Cuotas', `<p class="pp-muted">Rango en formato americano, por ejemplo −300 a +200.</p><div class="pp-row"><label class="pp-field">Mínima <input type="number" step="5" data-f="minOdds" value="${esc(f.minOdds)}" placeholder="-300"></label><label class="pp-field">Máxima <input type="number" step="5" data-f="maxOdds" value="${esc(f.maxOdds)}" placeholder="200"></label></div>`)}
      ${dd('hit', 'Acierto', `<div class="pp-row"><label class="pp-field">Mínimo % <input type="number" min="0" max="100" step="5" data-f="minHit" value="${esc(f.minHit)}" placeholder="60"></label><label class="pp-field">Periodo <select data-f="hitWin">${winOpts}</select></label></div>`)}
      ${dd('matchup', 'Defensa rival', `${Object.entries(MATCHUP).map(([k, label]) => check('matchup', k, `<i class="pp-dot pp-${k}"></i>${label}`, f.matchup.includes(k))).join('')}<p class="pp-muted">Según el puesto de la defensa rival. Solo si ESPN publica ese ranking.</p>`)}
      ${league === 'nba' ? dd('betano', 'Betano', betanoHtml(store), 'pp-wide') : ''}
      <button type="button" class="pp-link" data-act="reset">Limpiar</button>
      <span class="pp-count" data-count role="status"></span>
    </div>`;
  }
  const paintBar = () => { root.querySelector('[data-bar]').innerHTML = toolbar(); badges(); };
  const refresh = () => { shown = PAGE; badges(); paintTable(); };

  el.innerHTML = `<div class="pp">
    <header class="pp-top"><h1>Props</h1>${pr.source ? str(ui.sourceBadge(pr.source)) : ''}<p class="pp-muted" data-progress aria-live="polite"></p></header>
    <div data-bar></div><div data-table></div></div>`;
  const root = el.firstElementChild;
  paintBar();
  paintTable();

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'sort') {
      const key = t.dataset.sort;
      f.dir = f.sort === key ? (f.dir === 'asc' ? 'desc' : 'asc') : key === 'player' ? 'asc' : 'desc';
      f.sort = key;
      paintTable();
      root.querySelector(`[data-sort="${key}"]`)?.focus(); // la tabla se redibuja: el foco vuelve al mismo botón
    } else if (act === 'more') { shown += PAGE; paintTable(); }
    else if (act === 'reset') { Object.assign(f, defaults()); paintBar(); refresh(); }
    else if (act === 'add') {
      const r = rowMap.get(t.dataset.k);
      if (r) togglePick(ctx, r.key, `${r.p.player} · ${propText(r.p.side, r.p.line, r.def, r.p.stat)}`, oddsy(r.p), r.p.gameId);
    } else if (act === 'save') {
      const name = root.querySelector('[data-pname]').value.trim() || `Filtro ${presets().length + 1}`;
      savePresets([...presets().filter((x) => x.name !== name), { name, f: { ...f } }]);
      t.closest('.pp-pop').innerHTML = presetsHtml();
    } else if (act === 'load') { Object.assign(f, defaults(), presets()[t.dataset.i]?.f); paintBar(); refresh(); }
    else if (act === 'del') { savePresets(presets().filter((_, i) => i !== Number(t.dataset.i))); t.closest('.pp-pop').innerHTML = presetsHtml(); }
    else if (act === 'btlink') e.preventDefault(); // se arrastra a los marcadores; aquí no hace nada
    else if (act === 'btcopy') {
      const code = B.bookmarklet(location.origin);
      navigator.clipboard.writeText(code).then(() => { t.textContent = 'Código copiado'; }, () => window.prompt('Copia este código:', code));
    } else if (act === 'btclear') { store.set('betano', null); ctx.navigate(location.hash); }
  });
  root.addEventListener('change', (e) => {
    const t = e.target.closest('[data-f]');
    if (!t) return;
    const name = t.dataset.f;
    f[name] = t.type === 'checkbox' ? [...root.querySelectorAll(`input[data-f="${name}"]:checked`)].map((x) => x.value) : t.value;
    refresh();
  });
  playerSearch(root, ctx, defs[0]?.key ?? 'pts');
  const offPop = popovers(root);
  // Solo cambian los botones (como syncPicks en games.js): redibujar las filas le quitaba el foco.
  const offPicks = store.on('picks', (list) => {
    const ids = new Set(list.map((p) => p.id));
    for (const b of root.querySelectorAll('[data-act="add"]')) {
      const on = ids.has(b.dataset.k);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', b.getAttribute('aria-label').replace(/^(Quitar del|Agregar al)/, on ? 'Quitar del' : 'Agregar al'));
      b.textContent = on ? '✓' : '+';
    }
  });
  return () => { alive = false; offPop(); offPicks(); };
}

// ======================= DETALLE =======================
async function renderDetail(el, ctx) {
  const { league, api, store } = ctx;
  const sport = leagueById(league)?.sport;
  const defs = defsOf(sport);
  const k = parsePropKey(ctx.params.id);
  if (!k) { el.innerHTML = `<div class="pp">${str(ui.empty('El enlace de este prop no es válido.'))}<a class="pp-back" href="#/${esc(league)}/props">← Volver a Props</a></div>`; return undefined; }
  const stillHere = mount(el);

  // Enlace sin athleteId: se intenta encontrar al jugador en ESPN por nombre.
  let athleteId = k.athleteId;
  if (athleteId == null && k.player) {
    const found = dataOf(await api.search(league, k.player).catch(() => null)) ?? [];
    athleteId = (found.find((a) => norm(a.name) === norm(k.player)) ?? found[0])?.id ?? null;
  }
  const [log, gr] = await Promise.all([
    athleteId != null ? loadLog(api, league, athleteId) : null,
    k.gameId == null ? api.games(league).catch(() => null) : null,
  ]);
  const athlete = log?.athlete ?? { id: athleteId, name: k.player };
  // Sin partido en la clave: el próximo partido de su equipo en la cartelera de hoy.
  const gameId = k.gameId ?? (dataOf(gr) ?? []).find((g) => sameId(g.home?.id, athlete.teamId) || sameId(g.away?.id, athlete.teamId))?.id ?? null;
  // Las props se piden por partido: sin partido no hay línea Oddsy.
  const [pr, gd] = gameId != null ? await Promise.all([api.props(league, gameId).catch(() => null), loadGame(api, league, gameId)]) : [null, null];
  const pk = { athleteId, player: athlete.name ?? k.player };
  const mine = (dataOf(pr) ?? []).filter((p) => p?.books?.length && Number.isFinite(p.line) && (sameId(p.athleteId, athleteId) || norm(p.player) === norm(pk.player)));
  const sd = sidesOf(gd, athlete.teamId, mine[0]);
  // Compañeros de equipo para el filtro con/sin: plantilla del partido o, si no hay partido, del equipo.
  let mates = gd?.rosters?.[sd?.mine] ?? [];
  if (!mates.length && athlete.teamId != null) mates = dataOf(await api.roster(league, athlete.teamId).catch(() => null)) ?? [];
  mates = mates.filter((a) => !sameId(a.id, athleteId));
  if (!stillHere()) return undefined;

  const oppId = sd?.oppTeam?.id ?? null;
  const games = log?.games ?? [];
  const cur = curSeason(games);
  const hasCur = Number.isFinite(cur);
  const statsHere = defs.filter((d) => d.key === k.stat || mine.some((p) => p.stat === d.key) || games.some((g) => Number.isFinite(S.statOf(sport, d.key, g.stats))));
  // Línea Oddsy: el prop del servidor. Línea personalizada: la misma cuenta (bm.propOver) con la media y la varianza del jugador.
  const propFor = (stat, line, side) => {
    const own = mine.find((p) => p.stat === stat && p.line === line && p.side === side);
    if (own) return own;
    const base = mine.find((p) => p.stat === stat && Number.isFinite(p.variance));
    return base && Number.isFinite(line) ? B.atLine(base, line, side) : null;
  };
  const lineOf = (stat) => mine.find((p) => p.stat === stat)?.line ?? null;
  const bt = league === 'nba' ? B.saved(store) : null;
  const btOf = (stat) => B.lineFor(bt, pk.player, stat); // [línea, cuota Más, cuota Menos] de Betano
  const defaultLine = (stat) => btOf(stat)?.[0] ?? lineOf(stat) ?? (S.STATS[sport]?.find((d) => d.key === stat)?.binary ? 0.5 : medianLine(valsOf(games, sport, stat), stat)); // 0/1 por partido
  const minutesMax = Math.ceil(Math.max(0, ...games.map((g) => g.minutes).filter(Number.isFinite)));
  const s = { stat: k.stat ?? statsHere[0]?.key ?? defs[0]?.key, line: k.line, side: k.side, win: 'l10', loc: 'all', rest: 'all', result: 'all', margin: 20, minMin: 0, mate: '', mateMode: 'with', tab: 'matchup' };
  if (!Number.isFinite(s.line)) s.line = defaultLine(s.stat);
  const keyNow = () => propKey({ ...pk, stat: s.stat, line: s.line, side: s.side, gameId });
  store.track(keyNow(), 'view');

  const def = () => defOf(sport, s.stat);
  const team = sd?.team?.abbr ?? athlete.teamAbbr ?? '';
  const winTitle = { l5: 'Últimos 5', l10: 'Últimos 10', l20: 'Últimos 20', h2h: `H2H${sd ? ` vs ${sd.oppTeam.abbr}` : ''}`, season: `Temporada ${hasCur ? cur : 'actual'}`, prev: `Temporada ${hasCur ? cur - 1 : 'anterior'}` };
  const winShort = { l5: 'Últ. 5', l10: 'Últ. 10', l20: 'Últ. 20', h2h: 'Vs rival', season: hasCur ? String(cur) : 'Temp.', prev: hasCur ? String(cur - 1) : 'Temp. ant.' };
  const seg = (key, opts, label) => `<div class="pp-seg" role="group" aria-label="${label}">${opts.map(([v, text]) => `<button type="button" data-sv="${key}:${v}" aria-pressed="${String(s[key]) === String(v)}">${text}</button>`).join('')}</div>`;

  el.innerHTML = `<div class="pp pp-detail">
    <a class="pp-back" href="#/${esc(league)}/props">← Props</a>
    <section class="pp-dhead">
      <div class="pp-who">${str(ui.headshot(athlete, { size: 56 }))}<div><h1>${esc(pk.player)}</h1>
        <p class="pp-muted">${esc([athlete.pos, team].filter(Boolean).join(' · '))}${gd?.home ? ` · ${esc(`${gd.away.abbr} @ ${gd.home.abbr}`)} · ${esc(ui.when(gd.start))}` : ' · Sin partido próximo'}</p></div></div>
      <div class="pp-hctl" data-hctl></div>
      <label class="pp-field pp-line">Tu línea <input type="number" step="0.5" min="0" inputmode="decimal" data-line value="${esc(s.line)}"></label>
    </section>
    <div class="pp-stabs" role="tablist" aria-label="Estadística">${statsHere.map((d) => `<button type="button" role="tab" aria-controls="pp-ana" data-sv="stat:${esc(d.key)}" aria-selected="${d.key === s.stat}" title="${esc(statName(d, d.key))}">${esc(d.label ?? d.key)}</button>`).join('')}</div>
    <div class="pp-grid">
      <section class="pp-main" aria-label="Historial">
        <div class="pp-winbar">
          ${seg('win', WINS.map((w) => [w, winShort[w]]), 'Periodo')}
          <label class="pp-field">Ubicación <select data-s="loc"><option value="all">Local y visita</option><option value="home">Solo local</option><option value="away">Solo visita</option></select></label>
          ${dd('f', 'Filtros', `
            <label class="pp-field">Días de descanso <select data-s="rest"><option value="all">Todos</option><option value="0">0 (jugó el día anterior)</option><option value="1">1</option><option value="2">2</option><option value="3+">3 o más</option></select></label>
            <label class="pp-field">Compañero <select data-s="mate"><option value="">Ninguno</option>${mates.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.pos ? ` (${esc(a.pos)})` : ''}</option>`).join('')}</select></label>
            ${seg('mateMode', [['with', 'Con él'], ['without', 'Sin él']], 'Con o sin el compañero')}
            <label class="pp-field">Diferencia máxima en el marcador <input type="range" min="0" max="20" step="1" data-s="margin" value="20"><output data-o="margin"></output></label>
            ${seg('result', [['all', 'Todos'], ['W', 'Ganados'], ['L', 'Perdidos']], 'Resultado')}
            ${minutesMax > 0 ? `<label class="pp-field">Minutos mínimos <input type="range" min="0" max="${minutesMax}" step="1" data-s="minMin" value="0"><output data-o="minMin"></output></label>` : ''}
            <button type="button" class="pp-link" data-act="freset">Quitar filtros</button>`, 'pp-filters')}
        </div>
        <div id="pp-ana" data-ana aria-live="polite"></div>
      </section>
      <aside class="pp-side" aria-label="Partido">
        <div class="pp-ptabs" role="tablist" aria-label="Panel del partido">${[['matchup', 'Enfrentamiento'], ['lineup', 'Alineaciones'], ['insights', 'Tendencias']].map(([v, text]) => `<button type="button" role="tab" id="pp-tab-${v}" aria-controls="pp-panel" data-sv="tab:${v}" aria-selected="${s.tab === v}">${text}</button>`).join('')}</div>
        <div id="pp-panel" class="pp-panel" role="tabpanel" data-panel></div>
      </aside>
    </div></div>`;
  const root = el.firstElementChild;

  const addText = (on, sel) => (on ? '✓ En el boleto' : `+ Agregar ${ui.fmtOdds(oddsy(sel).price)}`);
  // Línea y cuotas de Betano; en su línea, la ventaja del lado elegido.
  function btLine(sel) {
    const b = btOf(s.stat);
    if (!b) return '';
    const e = b[0] === s.line ? B.edge(sel?.p, s.side === 'Over' ? b[1] : b[2]) : null;
    return `<p class="pp-avg">Línea Betano <b>${esc(fmtLine(b[0]))}</b> · Más ${esc(ui.fmtOdds(b[1]))} · Menos ${esc(ui.fmtOdds(b[2]))}${b[0] !== s.line ? ` <button type="button" class="pp-link" data-act="btline">Usar la línea de Betano</button>`
      : e != null ? ` · Ventaja ${edgeHtml(e, 'b')}` : ''}</p>${e > BIG_EDGE ? `<p class="pp-muted">${BT_NOTE}</p>` : ''}`;
  }
  function hctl() {
    const d = def(), over = propFor(s.stat, s.line, 'Over'), under = propFor(s.stat, s.line, 'Under');
    const sel = s.side === 'Over' ? over : under, on = inSlip(store, keyNow()), ours = lineOf(s.stat);
    const sideBtn = (side, p) => `<button type="button" data-sv="side:${side}" aria-pressed="${s.side === side}">${SIDE[side]} ${esc(fmtLine(s.line))} <b>${p ? esc(ui.fmtOdds(oddsy(p).price)) : '—'}</b></button>`;
    // Sin línea pero con historial de esa estadística: menos de MIN_GAMES partidos.
    const thin = ours == null && log && valsOf(games, sport, s.stat).length < MIN_GAMES;
    const why = thin ? THIN : gameId == null ? 'Sin partido próximo, Oddsy no da línea.' : 'Oddsy no tiene línea para esta estadística.';
    return `<p class="pp-market">${esc(propText(s.side, s.line, d, s.stat))}</p>
      <div class="pp-seg pp-sides" role="group" aria-label="Lado">${sideBtn('Over', over)}${sideBtn('Under', under)}</div>
      ${ours == null ? `<p class="pp-muted">${esc(why)}</p>`
        : `<p class="pp-avg">Línea Oddsy <b>${esc(fmtLine(ours))}</b>${ours !== s.line ? ` <button type="button" class="pp-link" data-act="ourline">Volver a la línea Oddsy</button>` : ''}</p>`}
      ${btLine(sel)}
      ${sel ? `<p class="pp-avg">Prob. <b>${esc(ui.fmtPct(sel.p, 1))}</b> · Justa <b>${esc(ui.fmtOdds(sel.fair))}</b> · Oddsy <b>${esc(ui.fmtOdds(oddsy(sel).price))}</b> ${str(ui.sourceBadge('oddsy'))}</p>
        <div class="pp-addbox"><button type="button" class="pp-btn" data-act="addbest" aria-pressed="${on}">${esc(addText(on, sel))}</button></div>`
        : ''}`;
  }

  // Partidos que pasan los filtros, con su valor de la estadística (del más reciente al más antiguo).
  function picked(window) {
    const mateLog = s.mate ? done.get(logKey(league, s.mate)) : null;
    const opts = { window, oppId, location: s.loc, result: s.result, minMinutes: s.minMin || undefined, maxMargin: s.margin < 20 ? s.margin : undefined, daysRest: s.rest === 'all' ? undefined : s.rest, [s.mateMode === 'with' ? 'withAthlete' : 'withoutAthlete']: mateLog ?? undefined };
    return bm.splitGames(games, opts).map((g) => ({ g, v: S.statOf(sport, s.stat, g.stats) })).filter((x) => Number.isFinite(x.v));
  }
  function ana() {
    if (!log) return str(ui.empty(athleteId == null ? 'No encontramos a este jugador en ESPN.' : 'No se pudo cargar su historial.'));
    const d = def(), win = picked(s.win), vals = win.map((x) => x.v);
    const h = rate(vals, s.line, s.side), sm = bm.summarize(vals);
    const others = WINS.filter((w) => w !== s.win).map((w) => [w, rate(picked(w).map((x) => x.v), s.line, s.side)]);
    const chron = [...win].reverse();
    const chart = str(ui.barChart({
      values: chron.map((x) => x.v), labels: chron.map((x) => gameLabel(x.g)), line: s.line, title: `${statName(d, s.stat)} por partido`,
      colorFn: (v) => (v === s.line ? 'push' : (s.side === 'Under' ? v < s.line : v > s.line) ? 'pos' : 'neg'),
    }));
    const mins = chron.filter((x) => Number.isFinite(x.g.minutes)), ms = bm.summarize(mins.map((x) => x.g.minutes));
    let ins = [];
    try { ins = bm.insightsFor({ athlete, gamelog: log, prop: { ...pk, stat: s.stat, line: s.line, side: s.side, gameId }, statDef: d, league }); } catch (err) { console.warn('insightsFor', err); }
    const mateWait = s.mate && !done.has(logKey(league, s.mate)) ? '<p class="pp-muted">Cargando los partidos del compañero…</p>' : '';
    return `${mateWait}<div class="pp-sum">
        <p class="pp-big">${esc(winTitle[s.win])}: <b class="pp-hr ${hrCls(h.pct)}">${pctTxt(h.pct)}</b> <span class="pp-muted">(${h.hits} de ${h.n})</span></p>
        <ul class="pp-wins">${others.map(([w, r]) => `<li><span>${esc(winShort[w])}</span> <b class="pp-hr ${hrCls(r.pct)}">${pctTxt(r.pct)}</b></li>`).join('')}</ul>
        <p class="pp-avg">Promedio <b>${fmt1(sm.avg)}</b> · Mediana <b>${fmt1(sm.median)}</b> · Línea <b>${esc(fmtLine(s.line))}</b></p>
      </div>
      <figure class="pp-chart">${chart}</figure>
      <h2 class="pp-h">Minutos jugados</h2>
      ${mins.length ? `<p class="pp-avg">Minutos: promedio <b>${fmt1(ms.avg)}</b> · mediana <b>${fmt1(ms.median)}</b></p><figure class="pp-chart">${str(ui.barChart({ values: mins.map((x) => x.g.minutes), labels: mins.map((x) => gameLabel(x.g)), line: Math.round(ms.avg * 10) / 10, title: 'Minutos por partido', colorFn: () => 'var(--teal)' }))}</figure>` : '<p class="pp-muted">ESPN no publica minutos para estos partidos.</p>'}
      <h2 class="pp-h">Tendencias</h2>
      ${ins.length ? `<ul class="pp-ins">${ins.slice(0, 8).map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : '<p class="pp-muted">No hay tendencias claras para esta línea.</p>'}`;
  }

  function matchupPanel() {
    if (!gd?.home) return '<p class="pp-muted">No encontramos su partido: no hay datos del rival.</p>';
    const d = def(), a = gd.away, hm = gd.home;
    const al = sd ? matchupFrom(allowedStat(gd.teamStats?.[sd.opp], s.stat), league, s.side) : null;
    const defense = sd ? `<h3>Defensa de ${esc(sd.oppTeam.abbr)} en ${esc(statName(d, s.stat).toLowerCase())}</h3>${al
      ? `<p>Permite <b>${esc(al.stat.display ?? fmt1(al.stat.value))}</b> por partido${al.rank != null ? ` · <span class="pp-rank pp-${al.cls}">${al.rank}°</span> (${MATCHUP[al.cls].toLowerCase()} para ${SIDE[s.side].toLowerCase()})` : ' · ESPN no da su puesto'}</p>`
      : `<p class="pp-muted">ESPN no publica cuántos ${esc(statName(d, s.stat).toLowerCase())} permite cada equipo.</p>`}
      <p class="pp-muted">Por posición del jugador: no hay una fuente gratuita con este dato.</p>
      <p class="pp-legend">${Object.entries(MATCHUP).map(([c, text]) => `<span><i class="pp-dot pp-${c}"></i>${text}</span>`).join('')}</p>` : '';
    const table = (title, A, B, cell) => {
      const keys = [...new Map([...(A ?? []), ...(B ?? [])].map((x) => [x.key, x.label ?? x.key]))];
      if (!keys.length) return '';
      const get = (list, key) => (list ?? []).find((x) => x.key === key);
      return `<h3>${title}</h3><div class="pp-scroll"><table class="pp-mini"><thead><tr><th scope="col"><span class="sr-only">Dato</span></th><th scope="col">${esc(a.abbr)}</th><th scope="col">${esc(hm.abbr)}</th></tr></thead><tbody>${keys.map(([key, label]) => `<tr><th scope="row">${esc(label)}</th><td>${cell(get(A, key))}</td><td>${cell(get(B, key))}</td></tr>`).join('')}</tbody></table></div>`;
    };
    const statCell = (x) => (x ? `${esc(x.display ?? fmt1(x.value))}${Number.isFinite(x.rank) ? ` <small>${x.rank}°</small>` : ''}` : '—');
    const recCell = (x) => (x ? esc(x.summary) : '—');
    return `${defense}
      ${table('Rankings de la temporada', gd.teamStats?.away, gd.teamStats?.home, statCell) || '<p class="pp-muted">ESPN no publica estadísticas de equipo para este partido.</p>'}
      ${table('Récords', gd.records?.away, gd.records?.home, recCell)}
      ${gd.ats ? table('Contra el hándicap', gd.ats.away, gd.ats.home, recCell) : ''}
      <h3>Apuestas del público</h3><p class="pp-muted">No hay una fuente gratuita para este dato.</p>`;
  }
  function lineupPanel() {
    if (!gd?.home) return '<p class="pp-muted">Sin partido: no hay alineaciones ni lesiones.</p>';
    const person = (x) => `<li><span class="pp-pos">${esc(x.pos ?? '')}</span> ${esc(x.name)}</li>`;
    return ['away', 'home'].map((side) => {
      const t = gd[side], starters = gd.starters?.[side] ?? [], roster = gd.rosters?.[side] ?? [];
      const inj = (gd.injuries ?? []).filter((i) => sameId(i.teamId, t.id) || (i.teamAbbr && i.teamAbbr === t.abbr));
      return `<section class="pp-team"><h3>${str(ui.teamLogo(t))} ${esc(t.name ?? t.abbr)}</h3>
        <h4>Titulares</h4>${starters.length ? `<ul class="pp-people">${starters.map(person).join('')}</ul>` : '<p class="pp-muted">Titulares aún no confirmados por ESPN.</p>'}
        ${roster.length ? `<details class="pp-roster"><summary>Plantilla (${roster.length})</summary><ul class="pp-people">${roster.map(person).join('')}</ul></details>` : ''}
        <h4>Lesiones</h4>${inj.length ? `<ul class="pp-inj">${inj.map((i) => `<li><b>${esc(i.athlete?.name ?? '')}</b> <span class="pp-pos">${esc(i.athlete?.pos ?? '')}</span> <span class="pp-st pp-st-${esc(norm(i.status))}">${esc(ui.INJURY[i.status] ?? i.status ?? '')}</span><small>${esc(i.detail ?? '')}${i.date ? ` · ${esc(ui.ago(i.date))}` : ''}</small></li>`).join('')}</ul>` : '<p class="pp-muted">Sin lesiones reportadas.</p>'}
      </section>`;
    }).join('');
  }
  function insightsPanel() {
    let list = [];
    try { list = gd ? bm.teamInsights(gd) : []; } catch (err) { console.warn('teamInsights', err); }
    return list.length ? `<ul class="pp-ins">${list.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : '<p class="pp-muted">No hay tendencias de equipo para este partido.</p>';
  }

  function paint() {
    root.querySelector('[data-hctl]').innerHTML = hctl();
    root.querySelector('[data-ana]').innerHTML = ana();
    const panel = root.querySelector('[data-panel]');
    panel.innerHTML = s.tab === 'lineup' ? lineupPanel() : s.tab === 'insights' ? insightsPanel() : matchupPanel();
    panel.setAttribute('aria-labelledby', `pp-tab-${s.tab}`);
    for (const b of root.querySelectorAll('[data-sv]')) {
      const [key, v] = b.dataset.sv.split(':');
      b.setAttribute(b.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', String(s[key]) === v);
    }
    const input = root.querySelector('[data-line]');
    if (document.activeElement !== input) input.value = s.line;
    const nf = (s.rest !== 'all') + !!s.mate + (s.margin < 20) + (s.result !== 'all') + (s.minMin > 0);
    root.querySelector('[data-b="f"]').textContent = nf ? ` ${nf}` : '';
    root.querySelector('[data-o="margin"]').textContent = s.margin < 20 ? `≤ ${s.margin}` : 'Cualquiera';
    const mo = root.querySelector('[data-o="minMin"]');
    if (mo) mo.textContent = s.minMin;
    history.replaceState(history.state, '', `#/${league}/props/${keyNow()}`); // enlace compartible sin volver a montar la vista
  }
  paint();

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-sv], [data-act]');
    if (!t) return;
    if (t.dataset.sv) {
      const [key, v] = t.dataset.sv.split(':');
      if (key === 'stat' && v !== s.stat) Object.assign(s, { stat: v, line: defaultLine(v) });
      else s[key] = v;
    } else if (t.dataset.act === 'addbest') {
      const p = propFor(s.stat, s.line, s.side);
      if (p) togglePick(ctx, keyNow(), `${pk.player} · ${propText(s.side, s.line, def(), s.stat)}`, oddsy(p), gameId);
      return; // el oyente de picks actualiza el botón sin redibujar
    } else if (t.dataset.act === 'ourline' || t.dataset.act === 'btline') {
      const line = t.dataset.act === 'ourline' ? lineOf(s.stat) : btOf(s.stat)?.[0];
      if (line == null) return;
      s.line = line;
    } else if (t.dataset.act === 'freset') {
      Object.assign(s, { rest: 'all', result: 'all', margin: 20, minMin: 0, mate: '', mateMode: 'with' });
      for (const x of root.querySelectorAll('.pp-filters [data-s]')) x.value = s[x.dataset.s];
    } else return;
    paint();
  });
  const onField = (e) => {
    const t = e.target;
    if (t.matches('[data-line]')) {
      const v = parseFloat(t.value);
      if (Number.isFinite(v) && v >= 0) { s.line = v; paint(); }
    } else if (t.dataset.s) {
      s[t.dataset.s] = t.type === 'range' ? Number(t.value) : t.value;
      if (t.dataset.s === 'mate' && s.mate) loadLog(api, league, s.mate).then(() => root.isConnected && paint());
      paint();
    }
  };
  root.addEventListener('input', onField);
  root.addEventListener('change', onField);
  const offPop = popovers(root);
  // Solo cambia el botón: redibujar el encabezado le quitaba el foco.
  const offPicks = store.on('picks', () => {
    const b = root.querySelector('[data-act="addbest"]'), sel = propFor(s.stat, s.line, s.side);
    if (!b || !sel) return;
    const on = inSlip(store, keyNow());
    b.setAttribute('aria-pressed', String(on));
    b.textContent = addText(on, sel);
  });
  return () => { offPop(); offPicks(); };
}

export default {
  title: 'Props',
  render(el, ctx) {
    return ctx.params?.id ? renderDetail(el, ctx) : renderList(el, ctx);
  },
};
