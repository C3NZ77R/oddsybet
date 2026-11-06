// En vivo (#/<liga>/live): partidos en juego con señales cuando un jugador o el marcador van a un ritmo distinto al
// esperado, las pausas del partido y una calculadora con la línea en vivo de tu casa.
import { h, fmtPct, fmtOdds, teamLogo, empty, errorBox, ago } from '../ui.js';
import { STATS } from '../stats.js';
import { expectedValue } from '../betmath.js';
import { propSignals, totalSignal, mainTotal, parseOdds, liveOver, isActive, LEVELS } from '../live.js';

const REFRESH_MS = 15_000;
const MAX_SIGS = 5; // señales visibles por partido antes de «Ver todas»
const TYPING_MS = 5_000; // sin repintar mientras escribe (iOS cierra el teclado al reemplazar el input)
const SIDE = { Over: 'Más de', Under: 'Menos de' };
const UNIT = { basketball: 'puntos', soccer: 'goles' };
const r1 = (x) => Math.round(x * 10) / 10;
const toNum = (v) => (String(v ?? '').trim() === '' ? NaN : Number(String(v).replace(',', '.')));
const parseLine = (v) => { const x = toNum(v); return Number.isFinite(x) && x >= 0 ? x : null; };

const minsAgo = (iso) => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
const stopOn = (g) => (g.stop && isActive(g.stop) ? g.stop : null); // las pausas cortas ya terminaron cuando ESPN las publica

// Orden estable entre refrescos: lo que ya se veía conserva su lugar y lo nuevo entra después, según `rule`.
export const keepOrder = (prev, idOf, rule) => (a, b) => {
  const i = prev.indexOf(idOf(a)), j = prev.indexOf(idOf(b));
  return (i < 0) - (j < 0) || (i < 0 ? rule(a, b) : i - j);
};
// Señales: el nivel y la fuerza solo ordenan las nuevas; las que ya se veían no suben ni bajan al cambiar de nivel.
export const sigSort = (prev) => keepOrder(prev, (s) => s.id, (a, b) => b.level - a.level || Math.abs(b.z) - Math.abs(a.z));

function paceText(sig, sport) {
  const pct = fmtPct(sig.progress, 0), exp = r1(sig.expected);
  return sig.player
    ? `Lleva ${sig.current} con el ${pct} del partido jugado; lo normal a esta altura serían ${exp}.`
    : `Van ${sig.current} ${UNIT[sport]} con el ${pct} jugado; lo esperado a esta altura eran ${exp}.`;
}

// Probabilidades con la línea que escribió el usuario y, con cuota, el valor esperado según el modelo (no una promesa).
export function calcText(sig, v) {
  const line = parseLine(v.line);
  if (line == null) return 'Escribe la línea que muestra tu casa ahora para ver qué tan probable es.';
  const over = liveOver(sig.kind, sig.current, sig.rem, line);
  const p = sig.side === 'Over' ? over : 1 - over;
  const odds = parseOdds(v.odds);
  const head = `Según el modelo de Oddsy: ${SIDE.Over} ${line}: ${fmtPct(over, 0)} · ${SIDE.Under} ${line}: ${fmtPct(1 - over, 0)}. Cuota justa para «${SIDE[sig.side]}»: ${p > 0.01 ? fmtOdds(1 / p) : '—'}.`;
  if (!odds) return head;
  const ev = Math.round(expectedValue(p, odds) * 100);
  // Mejores apuestas pide 5 % sobre la justa por el error del modelo: aquí se dice lo mismo.
  const cushion = ev > 0 && ev < 5 ? ' Es menos que el colchón del 5 % que Oddsy usa por el error del modelo.' : '';
  return `${head} El valor esperado con esa cuota es de ${ev > 0 ? '+' : ''}${ev} %.${cushion} Los datos de ESPN van atrasados y el modelo se puede equivocar.`;
}

function sigCard(sig, sport, inputs) {
  const def = (STATS[sport] ?? []).find((d) => d.key === sig.stat);
  const v = inputs.get(sig.id) ?? {};
  const [ok, n] = sig.aligned;
  const pSide = sig.side === 'Over' ? sig.pOver : 1 - sig.pOver;
  return h`<article class="lv-sig lv-l${sig.level}" data-sig="${sig.id}">
    <p class="lv-tag"><b>Señal ${LEVELS[sig.level]}</b> · ${ok} de ${n} ${n === 1 ? 'razón' : 'razones'} a favor</p>
    <h3>${sig.player ? `${sig.player} · ${def?.name ?? sig.stat}` : 'Total del partido'}: <span class="lv-side">${SIDE[sig.side]} ${sig.line}</span></h3>
    <p class="lv-nums"><span>${sig.player ? 'Lleva' : 'Van'} <b>${sig.current}</b></span><span>Proyección final <b>${r1(sig.projected)}</b></span><span>Línea previa de Oddsy <b>${sig.line}</b> (${fmtPct(pSide, 0)})</span></p>
    <ul class="lv-why"><li>${paceText(sig, sport)}</li>${sig.script ? h`<li>${sig.script.s > 0 ? 'A favor' : 'En contra'}: ${sig.script.text}</li>` : ''}</ul>
    <div class="lv-calc">
      <label>Línea en vivo de tu casa <input name="line" inputmode="decimal" autocomplete="off" placeholder="${sig.line}" value="${v.line ?? ''}"></label>
      <label>Cuota para «${SIDE[sig.side]}» <input name="odds" autocomplete="off" placeholder="1.91 o -110" value="${v.odds ?? ''}"></label>
      <output aria-live="polite">${calcText(sig, v)}</output>
    </div>
  </article>`;
}

const team = (t) => h`<span class="lv-team">${teamLogo(t)}<b>${t.abbr || t.name}</b><b class="lv-pts">${t.score ?? 0}</b></span>`;

function gameCard(g, x, sigs, sport, inputs, open, league) {
  const wp = g.winProb, stop = stopOn(g);
  const all = open.has(g.id), shown = all ? sigs : sigs.slice(0, MAX_SIGS);
  const waiting = !x ? 'Cargando las líneas de Oddsy de este partido…'
    : g.progress < 0.1 ? 'Aún es temprano: las señales salen después del 10% del partido.'
      : 'Sin señales por ahora: todos van al ritmo esperado.';
  return h`<section class="card lv-game">
    <header class="lv-head">
      <div class="lv-teams">${team(g.away)}<span class="lv-vs">@</span>${team(g.home)}</div>
      <p class="lv-status"><span class="gm-live">En vivo</span> ${g.status?.detail ?? ''}</p>
      ${stop ? h`<p class="lv-stop">Pausa: ${stop.label}</p>` : ''}
      <a class="btn btn-primary lv-open" href="#/${league}/live/${g.id}">Ver estadio</a>
    </header>
    ${wp > 0.01 && wp < 0.99 ? h`<p class="lv-wp">Probabilidad de ganar según ESPN: <b>${g.home.abbr} ${fmtPct(wp, 0)}</b> (cuota justa ${fmtOdds(1 / wp)}) · <b>${g.away.abbr} ${fmtPct(1 - wp, 0)}</b> (${fmtOdds(1 / (1 - wp))})</p>` : ''}
    ${g.lastPlay ? h`<p class="lv-play"><small>Última jugada en ESPN${g.lastPlayAt ? ` (de hace ~${minsAgo(g.lastPlayAt)} min)` : ''}:</small> ${g.lastPlay}</p>` : ''}
    ${sigs.length ? h`<div class="lv-sigs" id="lv-sigs-${g.id}">${shown.map((s) => sigCard(s, sport, inputs))}</div>` : h`<p class="empty">${waiting}</p>`}
    ${sigs.length > MAX_SIGS ? h`<button type="button" class="btn sm lv-more" data-more="${g.id}" aria-expanded="${String(all)}" aria-controls="lv-sigs-${g.id}">${all ? 'Ver menos' : `Ver todas (${sigs.length})`}</button>` : ''}
  </section>`;
}

export default {
  title: 'En vivo',
  async render(el, ctx) {
    if (ctx.params.id) return (await import('./stadium.js')).default(el, ctx); // #/<liga>/live/<id>: el estadio de un partido
    const { api, leagueInfo: lg } = ctx;
    const extras = new Map(); // gameId -> { props, total } | null mientras carga
    const inputs = new Map(); // id de señal -> { line, odds } que escribió el usuario
    const sigById = new Map();
    const open = new Set(); // partidos con todas las señales a la vista
    let games = [], err = null, typedAt = 0, okAt = 0, paused = false, last = '', lastNote = '', order = [], sigOrder = [];

    el.innerHTML = h`<header class="view-head"><div><h1>En vivo · ${lg.title}</h1>
      <p class="hint"><small>ESPN publica las jugadas unos 6 minutos tarde: revisa el precio en tu casa antes de apostar.</small></p></div></header>
      <div class="lv-bar"><span class="hint" data-age></span><button type="button" class="btn sm" data-pause aria-pressed="false">Pausar actualización</button></div>
      <p class="lv-note" role="status" data-note></p>
      <div data-body></div>`;
    const body = el.querySelector('[data-body]'), note = el.querySelector('[data-note]'), age = el.querySelector('[data-age]');
    const showAge = () => { age.textContent = okAt ? `Actualizado ${ago(new Date(okAt).toISOString())}` : ''; };

    const want = (id) => {
      if (extras.has(id)) return;
      extras.set(id, null);
      Promise.all([
        api.props(lg.id, id).then((r) => r.data ?? []),
        api.markets(lg.id, id).then((r) => (r.accuracy?.publish === false ? null : mainTotal(r.data?.markets))),
      ]).then(([props, total]) => { extras.set(id, { props, total }); paint(); }, () => extras.delete(id)); // falló: "sin señales" sería falso
    };

    // force: lo pidió el usuario (Ver todas, Reintentar), así que pinta aunque esté en pausa.
    const paint = (force = false) => {
      showAge();
      // Un fallo con datos previos no borra nada: avisa y se reintenta en el siguiente ciclo.
      const noteHtml = err && okAt ? h`No se pudo actualizar. Ves los últimos datos que cargaron. <button type="button" class="btn sm" data-reload>Reintentar</button>`.toString() : '';
      if (noteHtml !== lastNote) { // sin repetir el aviso al lector de pantalla en cada ciclo
        const refocus = note.contains(document.activeElement);
        note.innerHTML = lastNote = noteHtml;
        if (refocus) note.querySelector('button')?.focus();
      }
      if (paused && !force) return;
      // Mientras escribe no se repinta: en iOS reemplazar el input cierra el teclado. Con el foco quieto (en Android queda
      // en el input al cerrar el teclado) sí repinta y devuelve el foco y el cursor.
      if (!force && Date.now() - typedAt < TYPING_MS) return;
      sigById.clear();
      const bySig = sigSort(sigOrder);
      const rows = games.map((g) => {
        want(g.id);
        const x = extras.get(g.id);
        const sigs = x ? [totalSignal(g, x.total, lg.sport), ...propSignals(x.props, g, lg.sport)].filter(Boolean)
          .sort(bySig) : [];
        sigs.forEach((s) => sigById.set(s.id, s));
        return [g, x, sigs];
      }).sort(keepOrder(order, (r) => r[0].id, (a, b) => (b[2][0]?.level ?? 0) - (a[2][0]?.level ?? 0)));
      order = rows.map((r) => r[0].id);
      sigOrder = rows.flatMap((r) => r[2].map((s) => s.id));
      const html = (err && !okAt ? errorBox(err) : rows.length ? h`${rows.map(([g, x, s]) => gameCard(g, x, s, lg.sport, inputs, open, lg.id))}`
        : h`${empty(`No hay partidos de ${lg.title} en juego ahora.`)}<p><a class="btn" href="#/${lg.id}/games">Ver los próximos partidos</a></p>`).toString();
      if (html === last) return; // nada cambió: no se toca el DOM (el lector de pantalla no pierde su lugar)
      last = html;
      const a = document.activeElement;
      const at = body.contains(a) ? { sig: a.closest('[data-sig]')?.dataset.sig, name: a.name, more: a.dataset.more, href: a.getAttribute('href'), from: a.selectionStart, to: a.selectionEnd } : null;
      body.innerHTML = html;
      const back = at?.more ? body.querySelector(`[data-more="${CSS.escape(at.more)}"]`)
        : at?.sig ? body.querySelector(`[data-sig="${CSS.escape(at.sig)}"] [name="${at.name}"]`)
          : at?.href && body.querySelector(`a[href="${CSS.escape(at.href)}"]`);
      if (back) {
        back.focus();
        if (back.tagName === 'INPUT') back.setSelectionRange(at.from, at.to);
      }
    };

    const load = async () => {
      try {
        games = (await api.get('/api/live', { league: lg.id }, { fresh: true })).data ?? [];
        err = null;
        okAt = Date.now();
      } catch (e) {
        err = e;
      }
    };
    const refreshNow = () => { if (!document.hidden && !paused) load().then(() => paint()); };

    el.addEventListener('input', (e) => {
      typedAt = Date.now();
      const card = e.target.closest('[data-sig]');
      const sig = card && sigById.get(card.dataset.sig);
      if (!sig) return;
      const v = { line: card.querySelector('[name=line]').value, odds: card.querySelector('[name=odds]').value };
      inputs.set(sig.id, v);
      card.querySelector('output').textContent = calcText(sig, v);
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.more) {
        if (!open.delete(b.dataset.more)) open.add(b.dataset.more);
        paint(true);
      } else if (b.hasAttribute('data-pause')) {
        paused = !paused;
        b.setAttribute('aria-pressed', String(paused));
        b.textContent = paused ? 'Reanudar' : 'Pausar actualización';
        refreshNow();
      } else if (b.hasAttribute('data-reload')) {
        b.disabled = true;
        load().then(() => { b.disabled = false; paint(true); });
      }
    });

    await load();
    paint();
    const refresh = setInterval(refreshNow, REFRESH_MS);
    const ageTick = setInterval(showAge, 5_000);
    document.addEventListener('visibilitychange', refreshNow); // al volver de la app de la casa, datos al día
    return () => { clearInterval(refresh); clearInterval(ageTick); document.removeEventListener('visibilitychange', refreshNow); };
  },
};
