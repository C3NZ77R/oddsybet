// Mis apuestas (#/nba/seguir): activar avisos en el celular, registrar una apuesta hecha en otra casa (foto o texto del
// ticket, que lee Gemini, o a mano), confirmarla y ver cómo va. Los avisos los manda el servidor aunque Oddsy esté cerrado.
import { h, raw, empty, fmtOdds } from '../ui.js';
import { STATS } from '../stats.js';
import { store } from '../store.js';
import { pushSupport, enablePush, shrinkImage, trackApi } from '../track.js';

const REFRESH_MS = 15_000;
const MARKETS = { ml: 'Ganador', spread: 'Hándicap', total: 'Total de puntos', prop: 'Prop de jugador' };
const FIXED = new Set(['No es de la NBA', 'Mercado que Oddsy no sigue']); // estas no se pueden corregir: se ven sin seguir
const PROP_STATS = STATS.basketball.filter((d) => d.market);
const BINARY = new Set(['dd', 'td']);
const SEL_STATUS = { pendiente: 'Por empezar', en_juego: 'En juego', cumplida: 'Cumplida', fallada: 'Fallada', anulada: 'Anulada', devuelta: 'Devuelta', no_seguida: 'No seguida' };
const BET_STATUS = { pendiente: 'Por empezar', en_juego: 'En juego', ganada: 'Ganada', perdida: 'Perdida', anulada: 'Anulada', parcial: 'Cumplida en lo seguido' };

let nextKey = 0;
const blank = () => ({ key: ++nextKey, market: 'prop', gameId: '', stat: 'pts', athleteId: '', side: 'Over', line: '', odds: '', label: '', reason: null, fixed: false });

// Un refresco fallido no borra la lista que ya se veía: deja un aviso (una sola vez) y el siguiente ciclo reintenta.
export function listFailed(box, err) {
  const title = box.querySelector('#sgListTitle');
  if (!title) { if (box.textContent !== err.message) box.innerHTML = h`<p class="sg-msg" role="alert">${err.message}</p>`; } // sin repetir la alerta
  else if (!box.querySelector('[data-listerr]')) title.insertAdjacentHTML('afterend', String(h`<p class="sg-msg" role="status" data-listerr>No se pudo actualizar. Ves la última lista que cargó; se reintenta solo.</p>`));
}

// Borrador de /api/track/read → filas editables.
export function rowsOf(draft) {
  return draft.map((d) => ({
    key: ++nextKey, market: d.market, gameId: d.gameId ?? '', stat: d.stat ?? (d.market === 'prop' ? 'pts' : null), athleteId: d.athleteId ?? '',
    side: d.side ?? '', line: d.line ?? '', odds: d.odds ?? '', label: d.label ?? '',
    reason: d.tracked === false ? d.reason : null, fixed: d.tracked === false && (FIXED.has(d.reason) || !MARKETS[d.market]),
  }));
}

const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').trim().replace('−', '-').replace(',', '.')));

// Filas → selecciones para POST /api/track/bets (el servidor revalida todo y arma las etiquetas).
export function payloadOf(rows) {
  return rows.map((r) => {
    if (r.fixed) return { market: r.market, label: r.label, status: 'no_seguida' };
    const s = { market: r.market, gameId: r.gameId };
    if (r.market === 'prop') Object.assign(s, { stat: r.stat, athleteId: r.athleteId });
    s.side = r.side;
    if (r.market !== 'ml') s.line = BINARY.has(r.stat) ? 0.5 : String(r.line ?? '').trim() === '' ? null : num(r.line); // Number('') es 0
    if (r.odds !== '' && r.odds != null) s.odds = r.odds;
    return s;
  });
}

const opt = (value, label, cur) => h`<option value="${value}"${String(value) === String(cur) ? raw(' selected') : ''}>${label}</option>`;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const when = (iso) => new Date(iso).toLocaleString('es-CO', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function pushHtml(state, err) {
  const msg = err ? h`<p class="sg-msg" role="alert">${err}</p>` : '';
  if (state === 'active') return h`<h2>Avisos activados</h2>${msg}`;
  if (state === 'ios-install') {
    return h`<h2>Primero, agrega Oddsy a tu inicio</h2><p class="hint">En iPhone los avisos solo funcionan con Oddsy instalado (iOS 16.4 o más nuevo):</p>
      <ol class="sg-steps"><li>Toca <b>Compartir</b> en Safari (el cuadro con la flecha).</li><li>Elige <b>Agregar a inicio</b>.</li><li>Abre Oddsy desde el ícono nuevo y vuelve a esta sección.</li></ol>${msg}`;
  }
  if (state === 'denied') return h`<h2>Los avisos están bloqueados</h2><p class="hint">Actívalos en los ajustes del celular (Notificaciones → Oddsy).</p>${msg}`;
  if (state === 'unsupported') return h`<h2>Los avisos son para el celular</h2><p class="hint">Ábrelo en Chrome en Android, o en iPhone agrégalo a la pantalla de inicio.</p>${msg}`;
  return h`<h2>Activa los avisos</h2>
    <button type="button" class="btn btn-primary" data-enable>Activar avisos</button>${msg}`;
}

export default {
  title: 'Mis apuestas',
  async render(el, { api, query }) {
    const ua = navigator.userAgent;
    const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // shortcut: ?escritorio=1 deja activarlos en el computador solo para probar; los avisos son para el celular.
    const mobile = ios || /Android|Mobile/.test(ua) || query.has('escritorio');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const hasPush = mobile && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const active = () => !!store.get('track') && window.Notification?.permission === 'granted';
    const pushState = () => (active() ? 'active' : pushSupport({ standalone, ios, hasPush, permission: window.Notification?.permission ?? 'default' }));

    let rows = null, meta = { book: '', odds: '' }, games = [], busy = false, pushErr = '', addMsg = '';
    const rosters = new Map(); // teamId → atletas

    el.innerHTML = h`<header class="view-head"><div><h1>Mis apuestas · NBA</h1></div></header>
      <section class="card sg-push" data-push></section>
      <section class="card sg-add" data-add hidden></section>
      <section class="sg-list" data-list aria-labelledby="sgListTitle"></section>`;
    const $ = (s) => el.querySelector(s);

    const gameOf = (id) => games.find((g) => g.id === String(id));
    const athletesOf = (g) => (g ? [...(rosters.get(g.away.id) ?? []), ...(rosters.get(g.home.id) ?? [])] : []);
    const loadRosters = (ids) => Promise.all(ids.filter((id) => id && !rosters.has(id)).map((id) =>
      api.roster('nba', id).then((b) => rosters.set(id, b.data ?? [])).catch(() => rosters.set(id, []))));
    const loadGames = async () => {
      if (games.length) return;
      // Ayer, hoy y mañana, como el servidor: de madrugada sigue en juego un partido que empezó ayer.
      const days = [-1, 0, 1].map((k) => new Date(Date.now() + k * 864e5));
      const lists = await Promise.all(days.map((d) => api.games('nba', ymd(d)).then((b) => b.data ?? []).catch(() => [])));
      games = [...new Map(lists.flat().filter((g) => g.status?.state !== 'post').map((g) => [g.id, g])).values()];
    };

    function rowHtml(r, i) {
      if (r.fixed) {
        return h`<li class="sg-row sg-fixed" data-row="${r.key}"><p><b>${r.label || 'Selección'}</b></p><p class="sg-reason">No la seguimos: ${r.reason}.</p>
          <button type="button" class="btn sm" data-remove aria-label="Quitar la selección ${i + 1}">Quitar</button></li>`;
      }
      const g = gameOf(r.gameId);
      const sides = r.market === 'ml' || r.market === 'spread'
        ? (g ? [['away', g.away.name], ['home', g.home.name]] : [])
        : BINARY.has(r.stat) ? [['Over', 'Sí'], ['Under', 'No']] : [['Over', 'Más de'], ['Under', 'Menos de']];
      return h`<li class="sg-row" data-row="${r.key}">
        ${r.reason ? h`<p class="sg-reason">Revisa: ${r.reason}.${r.label ? ` Leímos «${r.label}».` : ''}</p>` : ''}
        <div class="sg-fields">
          <label>Partido <select data-f="gameId">${opt('', 'Elige el partido', r.gameId)}${games.map((x) => opt(x.id, `${x.away.abbr} @ ${x.home.abbr} · ${when(x.start)}`, r.gameId))}</select></label>
          <label>Mercado <select data-f="market">${Object.entries(MARKETS).map(([k, v]) => opt(k, v, r.market))}</select></label>
          ${r.market === 'prop' ? h`<label>Jugador <select data-f="athleteId">${opt('', g ? 'Elige el jugador' : 'Primero el partido', r.athleteId)}${athletesOf(g).map((a) => opt(a.id, a.name, r.athleteId))}</select></label>
            <label>Estadística <select data-f="stat">${PROP_STATS.map((d) => opt(d.key, d.name, r.stat))}</select></label>` : ''}
          <label>${r.market === 'ml' || r.market === 'spread' ? 'Equipo' : 'Lado'} <select data-f="side">${opt('', 'Elige', r.side)}${sides.map(([k, v]) => opt(k, v, r.side))}</select></label>
          ${r.market !== 'ml' && !BINARY.has(r.stat) ? h`<label>Línea <input data-f="line" inputmode="decimal" autocomplete="off" placeholder="${r.market === 'spread' ? '-5.5' : '24.5'}" value="${r.line}"></label>` : ''}
          <label>Cuota <input data-f="odds" autocomplete="off" placeholder="1.85 o -110" value="${r.odds}"></label>
        </div>
        <button type="button" class="btn sm" data-remove aria-label="Quitar la selección ${i + 1}">Quitar</button>
      </li>`;
    }

    function paintAdd() {
      const box = $('[data-add]');
      box.hidden = !active();
      if (box.hidden) return;
      const msg = addMsg ? h`<p class="sg-msg" role="alert">${addMsg}</p>` : '';
      if (!rows) {
        box.innerHTML = h`<h2>Registrar una apuesta</h2>
          <div class="sg-actions">
            <label class="btn btn-primary sg-file"><input type="file" accept="image/*" data-file class="sr-only"${busy ? raw(' disabled') : ''}>Subir pantallazo</label>
            <button type="button" class="btn" data-paste${busy ? raw(' disabled') : ''}>Pegar texto</button>
            <button type="button" class="btn" data-manual${busy ? raw(' disabled') : ''}>Llenar a mano</button>
          </div>
          <div class="sg-paste" data-pastebox hidden><label>Texto del ticket <textarea rows="5" maxlength="4000" data-text></textarea></label>
            <button type="button" class="btn" data-read-text>Leer el ticket</button></div>
          ${busy ? h`<p class="sg-msg" role="status">Leyendo el ticket…</p>` : msg}
          <p class="sg-note"><small>La foto la lee Gemini de Google en su capa gratis, donde Google puede revisar lo que se envía. Antes de subirla, recorta o tapa tu usuario, el saldo y el número de ticket (el editor de pantallazos del celular lo hace). Oddsy no guarda la foto ni el texto.</small></p>
          <p class="sg-note"><small>Los datos vienen de ESPN, que publica las jugadas con unos minutos de atraso: los avisos pueden llegar después de lo que ves en tu casa.</small></p>`;
        return;
      }
      box.innerHTML = h`<h2>Revisa tu apuesta</h2>
        <ol class="sg-rows">${rows.map(rowHtml)}</ol>
        <p><button type="button" class="btn" data-addrow>Agregar selección</button></p>
        <div class="sg-fields sg-meta"><label>Casa <input data-meta="book" maxlength="40" autocomplete="off" placeholder="Betplay" value="${meta.book}"></label>
          <label>Cuota total <input data-meta="odds" autocomplete="off" placeholder="3.40" value="${meta.odds}"></label></div>
        <div class="sg-actions"><button type="button" class="btn btn-primary" data-save${busy ? raw(' disabled') : ''}>Seguir apuesta</button><button type="button" class="btn" data-cancel>Cancelar</button></div>
        ${msg}`;
    }

    let lastList = '';
    async function paintList() {
      const box = $('[data-list]');
      if (!active()) { box.innerHTML = ''; return; }
      let bets;
      try {
        bets = (await trackApi.listBets()).bets ?? [];
      } catch (err) {
        listFailed(box, err);
        return;
      }
      const html = String(h`<h2 id="sgListTitle">Apuestas que sigues</h2>${bets.length ? bets.map((b) => {
        const sels = b.selections ?? [];
        return h`<article class="card sg-bet">
          <header class="sg-bet-head"><h3>${sels.length > 1 ? `Combinada de ${sels.length}` : sels[0]?.label ?? 'Apuesta'}</h3><span class="sg-st sg-${b.status}">${BET_STATUS[b.status] ?? b.status}</span></header>
          ${b.book || b.odds ? h`<p class="hint">${[b.book, b.odds ? `cuota ${fmtOdds(Number(b.odds))}` : ''].filter(Boolean).join(' · ')}</p>` : ''}
          <ul class="sg-sels">${sels.map((s) => h`<li><span>${s.label}</span><span class="sg-st sg-${s.status}">${SEL_STATUS[s.status] ?? s.status}</span>${s.current != null && s.status !== 'no_seguida'
            ? h`<small>${s.market === 'ml' || s.market === 'spread' ? `diferencia ${s.current > 0 ? '+' : ''}${s.current}` : `lleva ${s.current}`}</small>` : ''}</li>`)}</ul>
          <button type="button" class="btn sm" data-stop="${b.id}">Dejar de seguir</button>
        </article>`;
      }) : empty('Todavía no sigues ninguna apuesta.')}`);
      if (html !== lastList) box.innerHTML = lastList = html;
    }

    const paintPush = () => { $('[data-push]').innerHTML = pushHtml(pushState(), pushErr); };
    const paintAll = () => { paintPush(); paintAdd(); paintList(); };

    async function startDraft(draft, book = '', odds = '') {
      await loadGames();
      rows = draft.length ? rowsOf(draft) : [blank()];
      meta = { book: book ?? '', odds: odds ?? '' };
      await loadRosters(rows.flatMap((r) => { const g = gameOf(r.gameId); return g ? [g.home.id, g.away.id] : []; }));
      paintAdd();
    }
    async function read(input) {
      busy = true; addMsg = ''; paintAdd();
      try {
        const r = await trackApi.read(input);
        busy = false;
        if (!r.selections?.length) addMsg = 'No encontramos selecciones en el ticket: llénala a mano.';
        await startDraft(r.selections ?? [], r.book, r.odds ?? '');
      } catch (err) {
        busy = false;
        addMsg = err.message;
        if (err.status === 429 || err.status === 502) await startDraft([]); // sin lectura automática: formulario vacío
        else paintAdd();
      }
    }
    const rowOf = (target) => rows?.find((r) => r.key === Number(target.closest('[data-row]')?.dataset.row));

    el.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.closest('[data-enable]')) {
        pushErr = '';
        try { await enablePush(); } catch (err) { pushErr = err.message; }
        return paintAll();
      }
      if (t.closest('[data-paste]')) { const box = $('[data-pastebox]'); box.hidden = !box.hidden; if (!box.hidden) $('[data-text]').focus(); return; }
      if (t.closest('[data-read-text]')) { const text = $('[data-text]').value.trim(); if (text) read({ text }); return; }
      if (t.closest('[data-manual]')) { addMsg = ''; return startDraft([]); }
      if (t.closest('[data-addrow]')) { rows.push(blank()); return paintAdd(); }
      if (t.closest('[data-cancel]')) { rows = null; addMsg = ''; return paintAdd(); }
      if (t.closest('[data-remove]')) {
        const r = rowOf(t);
        rows = rows.filter((x) => x !== r);
        if (!rows.length) rows = null;
        return paintAdd();
      }
      if (t.closest('[data-save]')) {
        busy = true; addMsg = ''; paintAdd();
        try {
          await trackApi.createBet({ book: meta.book, odds: meta.odds, selections: payloadOf(rows) });
          rows = null;
          addMsg = 'Listo: te avisaremos de esta apuesta.';
        } catch (err) {
          addMsg = err.message;
        }
        busy = false;
        paintAdd();
        return paintList();
      }
      const stop = t.closest('[data-stop]');
      if (stop && window.confirm('¿Dejar de seguir esta apuesta? Ya no te llegarán sus avisos.')) {
        try { await trackApi.deleteBet(stop.dataset.stop); } catch (err) { window.alert(err.message); }
        paintList();
      }
    });

    // Escribir no repinta (iOS cierra el teclado al reemplazar el input); los selects sí, porque cambian los campos.
    el.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.meta) meta[t.dataset.meta] = t.value;
      else if (t.tagName === 'INPUT' && t.dataset.f) { const r = rowOf(t); if (r) r[t.dataset.f] = t.value; }
    });
    el.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.matches('[data-file]') && t.files?.[0]) {
        busy = true; addMsg = ''; paintAdd();
        let image;
        try { image = await shrinkImage(t.files[0]); } catch (err) { busy = false; addMsg = err.message; return paintAdd(); }
        return read({ image });
      }
      if (t.tagName !== 'SELECT' || !t.dataset.f) return;
      const r = rowOf(t);
      if (!r) return;
      const f = t.dataset.f;
      r[f] = t.value;
      r.reason = null;
      if (f === 'market') Object.assign(r, { side: r.market === 'prop' || r.market === 'total' ? 'Over' : '', stat: r.market === 'prop' ? 'pts' : null, athleteId: '', line: '' });
      if (f === 'stat') { r.line = BINARY.has(r.stat) ? 0.5 : r.line === 0.5 ? '' : r.line; }
      if (f === 'gameId') {
        r.athleteId = '';
        if (r.market === 'ml' || r.market === 'spread') r.side = '';
        const g = gameOf(r.gameId);
        if (g) await loadRosters([g.home.id, g.away.id]);
      }
      paintAdd();
      el.querySelector(`[data-row="${r.key}"] [data-f="${f}"]`)?.focus();
    });

    const off = store.on('track', paintAll); // un 401 borra el dispositivo: vuelve el botón de activar
    paintAll();
    const refresh = setInterval(() => { if (!document.hidden && active()) paintList(); }, REFRESH_MS);
    return () => { clearInterval(refresh); off(); };
  },
};
