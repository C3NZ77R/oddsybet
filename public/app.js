// Shell de Oddsy Bet: router por hash, montaje de vistas, chips de liga y boleto "Mis picks".
import { api } from './api.js';
import { store, encodePicks, decodePicks } from './store.js';
import { ui, h, empty, fmtOdds, fmtPct, bookInfo, bookChip, raw } from './ui.js';
import { LEAGUES, leagueById } from './leagues.js';
import { decode as decodeBetano, save as saveBetano } from './betano.js';
import { RG_LINE, importPicks, slipModel, combinedOdds, slipText, toastMs, hasUserInput } from './shell.js';
import { initChat } from './chat.js';

const $ = (s) => document.querySelector(s);
const LEAGUE_VIEWS = ['props', 'games', 'live', 'picks', 'insights', 'popular', 'seguir'];
const DETAIL_VIEWS = ['props', 'games', 'live'];
const KEEP_INPUT = ['seguir', 'live', 'insights'];
const NAMES = { props: 'Props', games: 'Partidos', live: 'En vivo', picks: 'Mejores apuestas', insights: 'Tendencias', popular: 'Populares', 'tennis-rankings': 'Ranking ATP', 'tennis-player': 'Jugador ATP', seguir: 'Mis apuestas' };
const lastLeague = () => leagueById(store.get('league')) ?? LEAGUES[0];
// El tenis solo tiene Partidos y Mejores apuestas (sin props, insights ni populares). Mis apuestas: solo la NBA.
const viewsOf = (lg) => (lg.sport === 'tennis' ? ['games', 'picks'] : lg.id === 'nba' ? LEAGUE_VIEWS : LEAGUE_VIEWS.filter((v) => v !== 'seguir'));
const home = (lg) => `#/${lg.id}/${viewsOf(lg).includes('props') ? 'props' : 'games'}`;
const defaultHash = () => home(lastLeague());

// '#/nba/props/abc?x=1' → { name, league, params, query } | null
function parse(hash) {
  const [path, qs = ''] = String(hash).replace(/^#\/?/, '').split('?');
  const seg = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = new URLSearchParams(qs);
  const r = (name, league = null, id) => ({ name, league, params: id != null ? { id } : {}, query });
  if (seg[0] === 'share' && seg.length === 1) return r('share');
  if (seg[0] === 'betano' && seg.length === 1) return r('betano');
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
let seq = 0, cleanup = null, lastKey = '', curView = '';
function runCleanup() {
  const fn = cleanup;
  cleanup = null;
  try { fn?.(); } catch (err) { console.error(err); }
}

async function route() {
  const r = parse(location.hash);
  if (!r) return location.replace(defaultHash());
  if (r.name === 'share') return importShare(r.query);
  if (r.name === 'betano') return importBetano(r.query);
  const my = ++seq;
  runCleanup();
  curView = r.name;
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
  // El boleto nunca pasa de 50 picks, el mismo tope que decodePicks.
  const add = importPicks(store.get('picks'), incoming);
  if (add.length) store.set('picks', [...store.get('picks'), ...add]);
  toast(incoming.length
    ? `Se agregaron ${add.length} de ${incoming.length} picks que alguien armó con el modelo de Oddsy. Van aparte en tu boleto: la cuota viene del enlace, sin verificar.`
    : 'Este enlace no tiene picks válidos.');
  if (incoming.length) openSlip();
  const lg = leagueById(incoming[0]?.league);
  location.replace(lg ? `#/${lg.id}/picks` : defaultHash());
}

// ---------- líneas de Betano (las trae el marcador de public/betano.js) ----------
async function importBetano(query) {
  const lines = await decodeBetano(query.get('d'));
  const n = Object.keys(lines).length, players = new Set(Object.keys(lines).map((k) => k.split('|')[0])).size;
  if (n && !window.confirm(`¿Guardar ${n} líneas de Betano? Solo si las trajiste tú con el marcador de Oddsy.`)) { location.replace('#/nba/props'); return; }
  if (n) saveBetano(store, lines);
  toast(n ? `Llegaron ${n} líneas de Betano de ${players} jugadores.` : 'Este enlace no trae líneas de Betano.');
  location.replace('#/nba/props');
}

async function sharePicks() {
  const url = `${location.origin}${location.pathname}#/share?p=${encodePicks(store.get('picks'))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Enlace copiado. Quien lo abra recibirá estos picks.');
  } catch {
    window.prompt('Copia este enlace para compartir tus picks:', url);
  }
}

function shareWhatsApp() {
  const picks = store.get('picks');
  const url = `${location.origin}${location.pathname}#/share?p=${encodePicks(picks)}`;
  const text = slipText(picks, url, fmtOdds);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

// ---------- boleto ----------
const leagueTitle = (id) => leagueById(id)?.title ?? id;
const pickLi = (p) => h`<li class="slip-pick">
  <div class="slip-txt"><span class="slip-label">${p.label}</span>${p.league ? h`<small>${leagueTitle(p.league)}</small>` : ''}</div>
  <b class="slip-price">${fmtOdds(p.price)}</b>
  <button type="button" class="icon-btn sm" data-remove="${p.id}" aria-label="Quitar ${p.label}">✕</button>
</li>`;

function renderSlip() {
  const picks = store.get('picks');
  $('#slipCount').textContent = picks.length || '';
  $('#fabCount').textContent = picks.length;
  const body = $('#slipBody'), foot = $('#slipFoot');
  if (!picks.length) {
    body.innerHTML = empty('Aún no tienes picks. Toca una cuota o el botón + en Props, Partidos o Tendencias.');
    foot.innerHTML = '';
    return;
  }
  const { own, shared, conflicts, total } = slipModel(picks);
  const groups = new Map();
  for (const p of own) {
    const k = bookInfo(p.book).key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  body.innerHTML = h`${conflicts.length ? h`<p class="slip-warn">${conflicts.map(([a, b]) => h`«${a.label}» y «${b.label}» no pueden ganar juntas. `)}Quita una para ver la cuota combinada.</p>` : ''}
    ${[...groups.values()].map((list) => h`<section class="slip-group" aria-label="${bookInfo(list[0].book).name}: ${list.length} ${list.length === 1 ? 'pick' : 'picks'}">
      <header class="slip-ghead">${bookChip(list[0].book)}<span class="slip-n">${list.length}/${picks.length}</span>${list.length > 1 && !conflicts.length ? h`<span class="slip-par" title="Cuota combinada del modelo">${fmtOdds(combinedOdds(list))}</span>` : ''}</header>
      <ul>${list.map(pickLi)}</ul></section>`)}
    ${shared.length ? h`<section class="slip-group slip-shared" aria-labelledby="slipSharedTitle">
      <header class="slip-ghead"><h3 id="slipSharedTitle">Picks que te compartieron</h3><span class="slip-n">${shared.length}/${picks.length}</span></header>
      <p class="slip-gnote">Los armó otra persona con el modelo de Oddsy. Cuota del enlace, sin verificar: no entra en la cuota combinada.</p>
      <ul>${shared.map(pickLi)}</ul>
      <p class="slip-gnote"><button type="button" class="btn sm" data-drop-shared>Descartar los compartidos</button></p></section>` : ''}`;
  foot.innerHTML = h`<dl class="slip-total">
      <div><dt>Picks</dt><dd>${picks.length}</dd></div>
      <div><dt>Cuota combinada</dt><dd>${fmtOdds(total)}</dd></div>
      <div><dt>Probabilidad implícita en la cuota, con el margen de Oddsy</dt><dd>${fmtPct(total ? 1 / total : null, 1)}</dd></div>
    </dl>
    <p class="slip-note">La cuota combinada es solo una referencia: picks del mismo partido se influyen entre sí y cada casa combina a su manera.</p>
    <p class="slip-note"><b>${RG_LINE}</b></p>
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
function armToast() {
  const t = $('#toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), toastMs(t.textContent));
}
function toast(msg) {
  $('#toast').textContent = msg;
  $('#toast').classList.add('show');
  armToast();
}
// Se detiene mientras el puntero o el foco estén encima, para terminar de leerlo.
for (const ev of ['pointerenter', 'focusin']) $('#toast').addEventListener(ev, () => clearTimeout(toastTimer));
for (const ev of ['pointerleave', 'focusout']) $('#toast').addEventListener(ev, () => $('#toast').classList.contains('show') && armToast());

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
  if (e.target.closest('[data-drop-shared]')) { store.set('picks', store.get('picks').filter((p) => !p.shared)); $('#slipTitle').focus(); return; }
  if (e.target.closest('[data-clear]') && window.confirm('¿Vaciar el boleto?')) store.set('picks', []);
});
wide.addEventListener('change', syncSlip);

store.on('picks', renderSlip);
store.on('settings', (s) => {
  if (s?.oddsFormat === lastFormat) return;
  lastFormat = s.oddsFormat;
  syncOddsToggle();
  renderSlip();
  // Mis apuestas, En vivo y Tendencias no guardan lo escrito: si hay algo, se deja la vista como está.
  if (KEEP_INPUT.includes(curView) && hasUserInput($('#view'))) return toast('Formato cambiado en el boleto. Esta vista lo usará cuando la vuelvas a abrir, así no pierdes lo que escribiste.');
  route();
});

if (!store.get('heroSeen')) {
  $('#hero').hidden = false;
  store.set('heroSeen', true);
}
$('[data-hero-close]').addEventListener('click', () => { $('#hero').hidden = true; $('#view').focus(); });

window.addEventListener('hashchange', route);
// Tocar un aviso con Oddsy abierto: el service worker pide llevar la página a Mis apuestas.
navigator.serviceWorker?.addEventListener('message', (e) => {
  const hash = e.data?.type === 'open' ? new URL(e.data.url, location.origin).hash : '';
  if (hash) location.hash = hash;
});
syncOddsToggle();
syncSlip();
renderSlip();
initChat();
route();
