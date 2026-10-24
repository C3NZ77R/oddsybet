// Shell de Oddsy Bet: router por hash, montaje de vistas, chips de liga y boleto "Mis picks".
import { api } from './api.js';
import { store, encodePicks, decodePicks } from './store.js';
import { ui, h, empty, fmtOdds, fmtPct, bookInfo, bookChip, raw } from './ui.js';
import { LEAGUES, leagueById } from './leagues.js';
import { parlayOdds } from './betmath.js';

const $ = (s) => document.querySelector(s);
const LEAGUE_VIEWS = ['props', 'games', 'live', 'picks', 'insights', 'popular'];
const DETAIL_VIEWS = ['props', 'games'];
const NAMES = { props: 'Props', games: 'Partidos', live: 'En vivo', picks: 'Mejores apuestas', insights: 'Tendencias', popular: 'Populares', 'tennis-rankings': 'Ranking ATP', 'tennis-player': 'Jugador ATP' };
const lastLeague = () => leagueById(store.get('league')) ?? LEAGUES[0];
// El tenis solo tiene Partidos y Mejores apuestas (sin props, insights ni populares).
const viewsOf = (lg) => (lg.sport === 'tennis' ? ['games', 'picks'] : LEAGUE_VIEWS);
const home = (lg) => `#/${lg.id}/${viewsOf(lg).includes('props') ? 'props' : 'games'}`;
const defaultHash = () => home(lastLeague());

// '#/nba/props/abc?x=1' → { name, league, params, query } | null
function parse(hash) {
  const [path, qs = ''] = String(hash).replace(/^#\/?/, '').split('?');
  const seg = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = new URLSearchParams(qs);
  const r = (name, league = null, id) => ({ name, league, params: id != null ? { id } : {}, query });
  if (seg[0] === 'share' && seg.length === 1) return r('share');
  if (seg[0] === 'tennis-rankings' && seg.length === 1) return r('tennis-rankings');
  if (seg[0] === 'tennis-player' && seg.length === 2) return r('tennis-player', null, seg[1]);
  const lg = leagueById(seg[0]);
  if (lg && viewsOf(lg).includes(seg[1]) && (seg.length === 2 || (seg.length === 3 && DETAIL_VIEWS.includes(seg[1])))) return r(seg[1], lg, seg[2]);
  return null;
}

function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? '' : '/'}${hash}`;
  if (target === location.hash) return route();
  if (replace) location.replace(target);
  else location.hash = target;
}

// ---------- router ----------
let seq = 0, cleanup = null, lastKey = '';
function runCleanup() {
  const fn = cleanup;
  cleanup = null;
  try { fn?.(); } catch (err) { console.error(err); }
}

async function route() {
  const r = parse(location.hash);
  if (!r) return location.replace(defaultHash());
  if (r.name === 'share') return importShare(r.query);
  const my = ++seq;
  runCleanup();
  if (r.league && r.league.id !== store.get('league')) store.set('league', r.league.id);
  const league = r.league ?? lastLeague();
  updateChrome(r, league);

  const main = $('#view');
  const el = document.createElement('div');
  el.className = `view view-${r.name}`;
  el.innerHTML = ui.loading();
  main.replaceChildren(el);
  main.setAttribute('aria-busy', 'true');
  const key = `${r.name}/${league.id}/${r.params.id ?? ''}`;
  if (key !== lastKey) {
    window.scrollTo(0, 0);
    // También al abrir un detalle o cambiar de liga: el enlace pulsado desaparece y el foco caería en <body>.
    if (lastKey) main.focus({ preventScroll: true });
  }
  lastKey = key;
  setTitle(NAMES[r.name], r.league);

  const ctx = { league: league.id, leagueInfo: league, route: r.name, params: r.params, query: r.query, api, store, ui, navigate };
  try {
    const mod = (await import(`./views/${r.name}.js`).catch((err) => {
      throw new Error(`No se pudo cargar la vista «${NAMES[r.name]}». ${err.message}`);
    })).default;
    if (my !== seq) return;
    if (!mod?.render) throw new Error(`La vista «${NAMES[r.name]}» no exporta render().`);
    setTitle((typeof mod.title === 'function' ? mod.title(ctx) : mod.title) || NAMES[r.name], r.league);
    const ret = await mod.render(el, ctx);
    if (typeof ret !== 'function') return;
    if (my === seq) cleanup = ret;
    else try { ret(); } catch (err) { console.error(err); }
  } catch (err) {
    if (my !== seq) return;
    console.error(err);
    el.innerHTML = ui.errorBox(err);
  } finally {
    if (my === seq) main.removeAttribute('aria-busy');
  }
}

function setTitle(title, league) {
  document.title = `${title}${league ? ` · ${league.title}` : ''} | Oddsy Bet`;
}

function updateChrome(r, league) {
  for (const a of document.querySelectorAll('#nav [data-nav]')) {
    const v = a.dataset.nav;
    if (LEAGUE_VIEWS.includes(v)) a.href = `#/${(viewsOf(league).includes(v) ? league : LEAGUES[0]).id}/${v}`;
    if (v === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('.brand').href = home(league);
  const chips = $('#leagues');
  chips.hidden = !r.league;
  if (r.league) {
    chips.innerHTML = h`${LEAGUES.map((l) => h`<a href="#/${l.id}/${viewsOf(l).includes(r.name) ? r.name : 'games'}"${l.id === r.league.id ? raw(' aria-current="page"') : ''}>${l.title}</a>`)}`;
    const cur = chips.querySelector('[aria-current]');
    if (cur) chips.scrollLeft = cur.offsetLeft - chips.offsetLeft - 16; // solo horizontal: no mueve la página
  }
}

// ---------- compartir picks ----------
function importShare(query) {
  const incoming = decodePicks(query.get('p'));
  const have = new Set(store.get('picks').map((p) => p.id));
  // El boleto nunca pasa de 50 picks, el mismo tope que decodePicks.
  const add = incoming.filter((p) => !have.has(p.id)).slice(0, Math.max(0, 50 - have.size)).map((p) => ({ ...p, addedAt: Date.now() }));
  if (add.length) store.set('picks', [...store.get('picks'), ...add]);
  toast(incoming.length
    ? `Se agregaron ${add.length} de ${incoming.length} picks del enlace compartido.`
    : 'Este enlace no tiene picks válidos.');
  if (incoming.length) openSlip();
  location.replace(defaultHash());
}

async function sharePicks() {
  const url = `${location.origin}${location.pathname}#/share?p=${encodePicks(store.get('picks'))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Enlace copiado. Quien lo abra verá estos picks en su boleto.');
  } catch {
    window.prompt('Copia este enlace para compartir tus picks:', url);
  }
}

function shareWhatsApp() {
  const picks = store.get('picks');
  const url = `${location.origin}${location.pathname}#/share?p=${encodePicks(picks)}`;
  const lines = picks.slice(0, 10).map((p) => `• ${p.label} @ ${fmtOdds(p.price)}`);
  const text = `Mis picks en Oddsy Bet (cuotas del modelo):\n${lines.join('\n')}\n${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

// ---------- boleto ----------
const leagueTitle = (id) => leagueById(id)?.title ?? id;
const combined = (list) => {
  const prices = list.map((p) => p.price).filter((x) => x > 1);
  return prices.length ? parlayOdds(prices) : null;
};

function renderSlip() {
  const picks = store.get('picks');
  $('#slipCount').textContent = picks.length || '';
  $('#fabCount').textContent = picks.length;
  const body = $('#slipBody'), foot = $('#slipFoot');
  if (!picks.length) {
    body.innerHTML = empty('Tu boleto está vacío. Toca una cuota o el botón + en Props, Partidos o Tendencias para agregar picks.');
    foot.innerHTML = '';
    return;
  }
  const groups = new Map();
  for (const p of picks) {
    const k = bookInfo(p.book).key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  body.innerHTML = h`${[...groups.values()].map((list) => h`<section class="slip-group" aria-label="${bookInfo(list[0].book).name}: ${list.length} ${list.length === 1 ? 'pick' : 'picks'}">
      <header class="slip-ghead">${bookChip(list[0].book)}<span class="slip-n">${list.length}/${picks.length}</span>${list.length > 1 ? h`<span class="slip-par" title="Cuota combinada en esta casa">${fmtOdds(combined(list))}</span>` : ''}</header>
      <ul>${list.map((p) => h`<li class="slip-pick">
        <div class="slip-txt"><span class="slip-label">${p.label}</span>${p.league ? h`<small>${leagueTitle(p.league)}</small>` : ''}</div>
        <b class="slip-price">${fmtOdds(p.price)}</b>
        <button type="button" class="icon-btn sm" data-remove="${p.id}" aria-label="Quitar ${p.label}">✕</button>
      </li>`)}</ul></section>`)}`;
  const total = combined(picks);
  foot.innerHTML = h`<dl class="slip-total">
      <div><dt>Picks</dt><dd>${picks.length}</dd></div>
      <div><dt>Cuota combinada</dt><dd>${fmtOdds(total)}</dd></div>
      <div><dt>Probabilidad según la cuota</dt><dd>${fmtPct(total ? 1 / total : null, 1)}</dd></div>
    </dl>
    <p class="slip-note">La cuota combinada es solo una referencia. Si juntas picks del mismo partido, unos dependen de otros, y cada casa tiene sus propias reglas para combinarlos.</p>
    <div class="slip-actions"><button type="button" class="btn btn-primary" data-share>Compartir</button><button type="button" class="btn" data-share-wa>WhatsApp</button><button type="button" class="btn" data-clear>Vaciar</button></div>`;
}

const wide = window.matchMedia('(min-width: 1280px)');
let slipOpen = false;
function syncSlip() {
  const drawer = !wide.matches;
  $('#slip').hidden = drawer && !slipOpen;
  $('#slip').classList.toggle('open', drawer && slipOpen);
  $('#slipFab').setAttribute('aria-expanded', String(drawer && slipOpen));
}
function openSlip() {
  slipOpen = true;
  syncSlip();
  if (!wide.matches) $('#slip .slip-close').focus();
}
function closeSlip(focusFab) {
  slipOpen = false;
  syncSlip();
  if (focusFab) $('#slipFab').focus();
}

let lastFormat = store.get('settings').oddsFormat;
function syncOddsToggle() {
  for (const b of document.querySelectorAll('[data-odds]')) b.setAttribute('aria-pressed', String(b.dataset.odds === lastFormat));
}

// ---------- utilidades del shell ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---------- eventos ----------
$('#view').addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) route(); });
$('[data-skip]').addEventListener('click', (e) => { e.preventDefault(); $('#view').focus(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (slipOpen && !wide.matches) closeSlip(true);
});

for (const b of document.querySelectorAll('[data-odds]')) {
  b.addEventListener('click', () => store.set('settings', { ...store.get('settings'), oddsFormat: b.dataset.odds }));
}

$('#slipFab').addEventListener('click', () => (slipOpen ? closeSlip() : openSlip()));
$('#slip').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { store.removePick(rm.dataset.remove); $('#slipTitle').focus(); return; }
  if (e.target.closest('[data-slip-close]')) return closeSlip(true);
  if (e.target.closest('[data-share-wa]')) return shareWhatsApp();
  if (e.target.closest('[data-share]')) return sharePicks();
  if (e.target.closest('[data-clear]') && window.confirm('¿Vaciar todos los picks del boleto?')) store.set('picks', []);
});
wide.addEventListener('change', syncSlip);

store.on('picks', renderSlip);
store.on('settings', (s) => {
  if (s?.oddsFormat === lastFormat) return;
  lastFormat = s.oddsFormat;
  syncOddsToggle();
  renderSlip();
  route();
});

if (!store.get('heroSeen')) {
  $('#hero').hidden = false;
  store.set('heroSeen', true);
}
$('[data-hero-close]').addEventListener('click', () => { $('#hero').hidden = true; $('#view').focus(); });

window.addEventListener('hashchange', route);
syncOddsToggle();
syncSlip();
renderSlip();
route();
