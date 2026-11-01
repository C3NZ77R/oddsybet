// En vivo (#/<liga>/live): partidos en juego con señales cuando un jugador o el marcador van a un ritmo distinto al
// esperado, las pausas del partido (buen momento para apostar) y una calculadora con la línea en vivo de tu casa.
import { h, fmtPct, fmtOdds, teamLogo, empty, errorBox } from '../ui.js';
import { STATS } from '../stats.js';
import { expectedValue } from '../betmath.js';
import { propSignals, totalSignal, mainTotal, parseOdds, liveOver, windowLeft, isActive, LEVELS } from '../live.js';

const REFRESH_MS = 15_000;
const TYPING_MS = 5_000; // sin repintar mientras escribe (iOS cierra el teclado al reemplazar el input)
const SIDE = { Over: 'Más de', Under: 'Menos de' };
const UNIT = { basketball: 'puntos', soccer: 'goles' };
const r1 = (x) => Math.round(x * 10) / 10;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const toNum = (v) => (String(v ?? '').trim() === '' ? NaN : Number(String(v).replace(',', '.')));
const parseLine = (v) => { const x = toNum(v); return Number.isFinite(x) && x >= 0 ? x : null; };

const minsAgo = (iso) => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
const stopOn = (g) => (g.stop && isActive(g.stop) ? g.stop : null); // las pausas cortas ya terminaron cuando ESPN las publica
const leftText = (s) => (s == null ? 'buen momento para mirar tu casa' : s > 0 ? `el juego seguiría en ~${mmss(s)}` : 'el juego debería seguir ya');

function paceText(sig, sport) {
  const pct = fmtPct(sig.progress, 0), exp = r1(sig.expected);
  return sig.player
    ? `Lleva ${sig.current} con el ${pct} del partido jugado; lo normal a esta altura serían ${exp}.`
    : `Van ${sig.current} ${UNIT[sport]} con el ${pct} jugado; lo esperado a esta altura eran ${exp}.`;
}

// Probabilidades con la línea que escribió el usuario y, con cuota, si a la larga gana o pierde.
function calcText(sig, v) {
  const line = parseLine(v.line);
  if (line == null) return 'Escribe la línea que muestra tu casa ahora para ver qué tan probable es.';
  const over = liveOver(sig.kind, sig.current, sig.rem, line);
  const p = sig.side === 'Over' ? over : 1 - over;
  const odds = parseOdds(v.odds);
  const head = `${SIDE.Over} ${line}: ${fmtPct(over, 0)} · ${SIDE.Under} ${line}: ${fmtPct(1 - over, 0)}. Cuota justa para «${SIDE[sig.side]}»: ${p > 0.01 ? fmtOdds(1 / p) : '—'}.`;
  if (!odds) return head;
  const ev = Math.round(expectedValue(p, odds) * 100);
  return `${head} ${ev > 0 ? `Con esa cuota, a la larga ganarías ~$${ev} por cada $100.` : `Con esa cuota, a la larga perderías ~$${-ev} por cada $100: no conviene.`}`;
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

function gameCard(g, x, sigs, sport, inputs) {
  const wp = g.winProb, stop = stopOn(g);
  const waiting = !x ? 'Cargando las líneas de Oddsy de este partido…'
    : g.progress < 0.1 ? 'Todavía es temprano para leer el ritmo: las señales salen después del 10% del partido.'
      : 'Sin señales por ahora: todos van al ritmo esperado.';
  return h`<section class="card lv-game">
    <header class="lv-head">
      <div class="lv-teams">${team(g.away)}<span class="lv-vs">@</span>${team(g.home)}</div>
      <p class="lv-status"><span class="gm-live">En vivo</span> ${g.status?.detail ?? ''}</p>
      ${stop ? h`<p class="lv-stop" data-stop-at="${stop.at ?? ''}" data-stop-kind="${stop.kind}"><b>Pausa: ${stop.label}</b> · <span data-left>${leftText(windowLeft(stop))}</span></p>` : ''}
    </header>
    ${wp > 0.01 && wp < 0.99 ? h`<p class="lv-wp">Probabilidad de ganar según ESPN: <b>${g.home.abbr} ${fmtPct(wp, 0)}</b> (cuota justa ${fmtOdds(1 / wp)}) · <b>${g.away.abbr} ${fmtPct(1 - wp, 0)}</b> (${fmtOdds(1 / (1 - wp))})</p>` : ''}
    ${g.lastPlay ? h`<p class="lv-play"><small>Última jugada en ESPN${g.lastPlayAt ? ` (de hace ~${minsAgo(g.lastPlayAt)} min)` : ''}:</small> ${g.lastPlay}</p>` : ''}
    ${sigs.length ? h`<div class="lv-sigs">${sigs.map((s) => sigCard(s, sport, inputs))}</div>` : h`<p class="empty">${waiting}</p>`}
  </section>`;
}

export default {
  title: 'En vivo',
  async render(el, { api, leagueInfo: lg }) {
    const extras = new Map(); // gameId -> { props, total } | null mientras carga
    const inputs = new Map(); // id de señal -> { line, odds } que escribió el usuario
    const sigById = new Map();
    let games = [], err = null, typedAt = 0;

    const want = (id) => {
      if (extras.has(id)) return;
      extras.set(id, null);
      Promise.all([
        api.props(lg.id, id).then((r) => r.data ?? []).catch(() => []),
        api.markets(lg.id, id).then((r) => (r.accuracy?.publish === false ? null : mainTotal(r.data?.markets))).catch(() => null),
      ]).then(([props, total]) => { extras.set(id, { props, total }); paint(); });
    };

    const paint = () => {
      // Mientras escribe no se repinta: en iOS reemplazar el input cierra el teclado. Con el foco quieto (en Android queda
      // en el input al cerrar el teclado) sí repinta y devuelve el foco y el cursor.
      if (Date.now() - typedAt < TYPING_MS) return;
      const a = document.activeElement;
      const typing = a?.tagName === 'INPUT' && el.contains(a) ? { sig: a.closest('[data-sig]')?.dataset.sig, name: a.name, from: a.selectionStart, to: a.selectionEnd } : null;
      sigById.clear();
      const rows = games.map((g) => {
        want(g.id);
        const x = extras.get(g.id);
        const sigs = x ? [totalSignal(g, x.total, lg.sport), ...propSignals(x.props, g, lg.sport)].filter(Boolean)
          .sort((a, b) => b.level - a.level || Math.abs(b.z) - Math.abs(a.z)) : [];
        sigs.forEach((s) => sigById.set(s.id, s));
        return [g, x, sigs];
      }).sort(([a, , sa], [b, , sb]) => !!stopOn(b) - !!stopOn(a) || (sb[0]?.level ?? 0) - (sa[0]?.level ?? 0)); // en pausa, arriba
      el.innerHTML = h`<header class="view-head"><div><h1>En vivo · ${lg.title}</h1>
        <p class="hint">Oddsy mira cada partido en juego y avisa cuando un jugador o el marcador van a un ritmo distinto al esperado. Escribe la línea en vivo de tu casa y te decimos qué tan probable es y si la cuota vale la pena. Los partidos en medio tiempo van arriba: es buen momento para apostar. No son picks: tú decides.</p>
        <p class="hint"><small>Datos de ESPN; se actualiza cada 15 s. ESPN publica cada jugada con unos minutos de atraso (unos 6), así que tu casa va más adelante: revisa el marcador y el precio antes de apostar.</small></p></div></header>
        ${err ? errorBox(err) : rows.length ? rows.map(([g, x, s]) => gameCard(g, x, s, lg.sport, inputs))
          : h`${empty(`No hay partidos de ${lg.title} en juego ahora.`)}<p><a class="btn" href="#/${lg.id}/games">Ver los próximos partidos</a></p>`}`;
      const input = typing?.sig && el.querySelector(`[data-sig="${CSS.escape(typing.sig)}"] [name="${typing.name}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(typing.from, typing.to);
      }
    };

    const load = async () => {
      try {
        games = (await api.get('/api/live', { league: lg.id }, { fresh: true })).data ?? [];
        err = null;
      } catch (e) {
        err = e;
      }
    };

    el.addEventListener('input', (e) => {
      typedAt = Date.now();
      const card = e.target.closest('[data-sig]');
      const sig = card && sigById.get(card.dataset.sig);
      if (!sig) return;
      const v = { line: card.querySelector('[name=line]').value, odds: card.querySelector('[name=odds]').value };
      inputs.set(sig.id, v);
      card.querySelector('output').textContent = calcText(sig, v);
    });

    await load();
    paint();
    const refresh = setInterval(() => { if (!document.hidden) load().then(paint); }, REFRESH_MS);
    const tick = setInterval(() => {
      for (const p of el.querySelectorAll('[data-stop-at]')) p.querySelector('[data-left]').textContent = leftText(windowLeft({ kind: p.dataset.stopKind, at: p.dataset.stopAt }));
    }, 1000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  },
};
