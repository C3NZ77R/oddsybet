// Estadio en vivo (#/<liga>/live/<id>): la cancha en perspectiva con cada jugada que publica ESPN. El balón solo va a
// posiciones reales; entre jugadas espera. ESPN publica con ~6 min de atraso, así que es una repetición, no la transmisión.
import { h, raw, esc, teamLogo, errorBox, empty } from '../ui.js';
import { momentum, runs, heat, shotZones, newPlays, shooters, shotLine, attackNow } from '../estadio.js';

const POLL_MS = 10_000;
const STEP_MS = 1400; // una jugada de la cola por paso
const FLY_MS = 700;
const FIRST_QUEUE = 5; // al abrir, repite las últimas jugadas para que se vea algo moviéndose
const SHOTS = new Set(['goal', 'shot-on', 'shot-off', 'blocked', 'post', 'pen-miss', 'shot']);
const BASKET = { home: [94.4, 50], away: [5.6, 50] }; // aro que ataca cada equipo (x, y en %)
const ZONES = [['paint', 'Pintura'], ['mid', 'Media distancia'], ['corner3', 'Triple de esquina'], ['arc3', 'Triple frontal']];
const ATTACK_ES = { peligro: 'Ataque peligroso', ataque: 'Ataque', salida: 'Sale jugando' };
const TRAIL = 6; // jugadas recientes con posición que quedan marcadas en la cancha para tocarlas

// Cancha de fútbol en metros (105 × 68) y de básquet en pies (94 × 50); los arcos y aros quedan por fuera con overflow.
const PITCH = raw(`<svg class="st-lines" viewBox="0 0 105 68" aria-hidden="true">
  <rect x="0" y="0" width="105" height="68"/><line x1="52.5" y1="0" x2="52.5" y2="68"/>
  <circle cx="52.5" cy="34" r="9.15"/><circle class="dot" cx="52.5" cy="34" r=".5"/>
  <g id="st-half"><rect x="0" y="13.84" width="16.5" height="40.32"/><rect x="0" y="24.84" width="5.5" height="18.32"/>
  <circle class="dot" cx="11" cy="34" r=".45"/><path d="M16.5 26.69A9.15 9.15 0 0 1 16.5 41.31"/>
  <rect class="goal" x="-2.2" y="30.34" width="2.2" height="7.32"/></g>
  <use href="#st-half" transform="translate(105 0) scale(-1 1)"/></svg>`);
const COURT = raw(`<svg class="st-lines" viewBox="0 0 94 50" aria-hidden="true">
  <rect x="0" y="0" width="94" height="50"/><line x1="47" y1="0" x2="47" y2="50"/><circle cx="47" cy="25" r="6"/>
  <g id="st-halfc"><rect class="key" x="0" y="17" width="19" height="16"/><circle cx="19" cy="25" r="6"/>
  <path d="M0 3H14A23.75 23.75 0 0 1 14 47H0"/><path d="M5.25 21A4 4 0 0 1 5.25 29"/>
  <line class="board" x1="4" y1="22" x2="4" y2="28"/><circle class="rim" cx="5.25" cy="25" r=".9"/></g>
  <use href="#st-halfc" transform="translate(94 0) scale(-1 1)"/></svg>`);

// Color de cada equipo legible sobre el fondo oscuro: los oscuros se aclaran hacia el blanco (el azul del Everton sigue
// siendo azul). Si los dos quedan parecidos, el visitante usa el durazno de la marca.
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hex = (v) => `#${v.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
function readable(c, fallback) {
  if (!/^#[0-9a-f]{6}$/i.test(c ?? '')) return fallback;
  let v = rgb(c);
  for (let k = 0; k < 8 && lum(v) < 0.42; k++) v = v.map((n) => n + (255 - n) * 0.25);
  return hex(v);
}
function colors(game) {
  const home = readable(game.home?.color, '#e8edf0'), away = readable(game.away?.color, '#f6a47c');
  const [a, b] = [rgb(home), rgb(away)];
  return { home, away: Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 90 ? (home === '#f6a47c' ? '#2fe2c4' : '#f6a47c') : away };
}

const clockOf = (p, sport) => (sport === 'basketball' ? `${p.period > 4 ? `Pr${p.period - 4}` : `C${p.period ?? '?'}`} ${p.clock ?? ''}` : p.clock ?? '');
const minsAgo = (iso) => (iso ? Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : null);

// Marcador al momento de la jugada i: [visitante, local].
function scoreAt(plays, i, sport) {
  if (sport === 'basketball') {
    for (let k = i; k >= 0; k--) if (plays[k].score) return plays[k].score;
    return [0, 0];
  }
  const s = [0, 0];
  for (let k = 0; k <= i; k++) if (plays[k].kind === 'goal' && plays[k].side) s[plays[k].side === 'home' ? 1 : 0]++;
  return s;
}
const lastPlaced = (plays, i) => { for (let k = i; k >= 0; k--) if (plays[k].x != null) return plays[k]; return null; };
// Cómo terminó un tiro de básquet; en fútbol el tipo de jugada ya lo dice.
const outcome = (p) => (p.kind === 'shot' ? (p.made ? `entró · +${p.pts}` : 'falló') : p.kind === 'ft' ? (p.made ? 'anotado' : 'fallado') : null);

export default async function stadium(el, { api, leagueInfo: lg, params }) {
  const sport = lg.sport, id = params.id;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let game = null, plays = [], err = null, built = false, stopped = false;
  // Cada carga trae objetos nuevos: la cola y la jugada actual se guardan por `seq`, que es estable entre cargas.
  // edgeSeq: hasta dónde llegan las capas (el momento del partido que se ve). Tocar un punto muestra esa jugada sin moverlo,
  // así los demás tiros no desaparecen.
  let cur = -1, curSeq = null, edgeSeq = null, mode = 'live', layer = 'plays', col = null, feedKey = null, shooter = '';
  const seen = new Set(), queue = [];
  let pumpTimer = null, step = 0, ball = { x: 50, y: 50 };
  const $ = (s) => el.querySelector(s);
  const idxOf = (seq) => plays.findIndex((p) => p.seq === seq);
  const later = (fn, ms) => { const my = step; setTimeout(() => { if (!stopped && my === step) fn(); }, ms); }; // se cancela si cambia la jugada

  const load = async () => {
    try {
      ({ game, plays } = (await api.get('/api/plays', { league: lg.id, id }, { fresh: true })).data);
      err = null;
    } catch (e) {
      err = e;
    }
  };

  // ---------- estructura (una vez: repintar el escenario cortaría las animaciones) ----------
  function build() {
    col = colors(game);
    const side = (s) => h`<span class="st-team">${teamLogo(game[s], { size: 32 })}<b>${game[s].abbr || game[s].name}</b></span>`;
    el.innerHTML = h`<header class="st-head" style="--home:${col.home};--away:${col.away}">
        <a class="st-back" href="#/${lg.id}/live">← En vivo</a>
        <div class="st-board">${side('away')}<span class="st-score"><b data-s="away">0</b><i>–</i><b data-s="home">0</b></span>${side('home')}</div>
        <p class="st-status" data-status></p>
      </header>
      <p class="hint st-delay">ESPN publica cada jugada con unos minutos de atraso.</p>
      <div data-err></div>
      <section class="card st-arena" style="--home:${col.home};--away:${col.away}">
        <div class="st-stage" data-sport="${sport}">
          <div class="st-field">${sport === 'soccer' ? PITCH : COURT}
            ${sport === 'soccer' ? h`<div class="st-zone" data-zone hidden></div>` : ''}
            <div class="st-heat" data-heat></div>
            <svg class="st-marks" viewBox="0 0 100 100" preserveAspectRatio="none" data-trail></svg>
            <div class="st-pins" data-pins></div>
            <div class="st-ballpos" data-ball hidden><span class="st-shadow"></span><span class="st-ball"></span></div>
          </div>
          <div class="st-fx" data-fx aria-hidden="true"></div>
          ${sport === 'soccer' ? h`<p class="st-attack" data-attack hidden title="Según la última jugada de ataque que publicó ESPN"></p>` : ''}
          <p class="st-empty" data-empty hidden></p>
        </div>
        <p class="st-cap" data-cap aria-live="polite"></p>
        <div class="st-tools" role="group" aria-label="Capas de la cancha">
          ${[['plays', 'Jugadas'], ['heat-home', `Calor ${game.home.abbr ?? 'local'}`], ['heat-away', `Calor ${game.away.abbr ?? 'visitante'}`], ['shots', 'Tiros']]
            .map(([k, t]) => h`<button type="button" class="chip-btn" data-layer="${k}" aria-pressed="${k === layer}">${t}</button>`)}
          ${sport === 'basketball' ? h`<label class="st-shooter" hidden>Jugador <select data-shooter><option value="">Todos</option></select></label>` : ''}
        </div>
        <div class="st-scrub"><label>Rebobinar <input type="range" min="0" max="0" value="0" data-scrub></label>
          <button type="button" class="btn btn-primary" data-replay>▶ Repetir el partido</button>
          <button type="button" class="btn" data-live hidden>Volver al final</button></div>
      </section>
      <section class="card st-pulse" data-pulse></section>
      ${sport === 'basketball' ? h`<section class="card st-zones" data-zones hidden></section>` : ''}
      <section class="card st-feed"><h2>Últimas jugadas</h2><ol data-feed></ol></section>`;
    built = true;
  }

  // ---------- mostrar una jugada ----------
  const at = (node, x, y) => { node.style.left = `${x}%`; node.style.top = `${y}%`; };
  const sideCol = (p) => (p.side ? col[p.side] : 'var(--muted)');

  function fly(to, { high = 40, ms = FLY_MS } = {}) {
    const pos = $('[data-ball]');
    pos.hidden = false;
    const from = { ...ball };
    ball = { x: to[0], y: to[1] };
    at(pos, ball.x, ball.y);
    if (reduce) return;
    pos.animate([{ left: `${from.x}%`, top: `${from.y}%` }, { left: `${ball.x}%`, top: `${ball.y}%` }], { duration: ms, easing: 'cubic-bezier(.3,.7,.4,1)' });
    pos.querySelector('.st-ball').animate([{ transform: 'translateZ(0)' }, { transform: `translateZ(${high}px)`, offset: 0.45 }, { transform: 'translateZ(0)' }], { duration: ms, easing: 'ease-out' });
    pos.querySelector('.st-shadow').animate([{ transform: 'scale(1)', opacity: 0.55 }, { transform: 'scale(.45)', opacity: 0.2, offset: 0.45 }, { transform: 'scale(1)', opacity: 0.55 }], { duration: ms });
  }

  function ring(x, y, color) {
    if (reduce) return;
    const r = document.createElement('span');
    r.className = 'st-ring';
    r.style.setProperty('--c', color);
    at(r, x, y);
    $('[data-pins]').append(r);
    r.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }], { duration: 900, easing: 'ease-out' }).finished.then(() => r.remove(), () => r.remove());
  }

  // Trayectoria del tiro sobre la cancha: verde si entró, blanca al arco, gris si se fue o la bloquearon.
  function trail(p, to) {
    const svg = $('[data-trail]');
    const good = p.kind === 'goal' || (p.kind === 'shot' && p.made);
    const tone = good ? 'var(--pos)' : p.kind === 'shot-on' || p.kind === 'post' || p.kind === 'pen-miss' ? '#fff' : 'var(--muted)';
    svg.innerHTML = `<path d="M${p.x} ${p.y}L${to[0]} ${to[1]}" stroke="${tone}" vector-effect="non-scaling-stroke" pathLength="1"/>`;
    if (!reduce) svg.firstChild.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: FLY_MS, easing: 'ease-out' });
  }

  function celebrate(text, color) {
    const fx = $('[data-fx]');
    const big = document.createElement('p');
    big.className = 'st-big';
    big.style.setProperty('--c', color);
    big.textContent = text;
    fx.append(big);
    if (reduce) { setTimeout(() => big.remove(), 1500); return; }
    big.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.25 }, { transform: 'scale(1)', opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1600, easing: 'ease-out' }).finished.then(() => big.remove(), () => big.remove());
    for (let i = 0; i < 30; i++) {
      const c = document.createElement('i');
      c.className = 'st-confetti';
      c.style.background = [color, '#fff', 'var(--teal)', 'var(--peach)'][i % 4];
      fx.append(c);
      const a = Math.random() * Math.PI * 2, d = 80 + Math.random() * 140;
      c.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d - 40}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(() => c.remove(), () => c.remove());
    }
  }

  // En la última jugada manda el marcador oficial: en fútbol contar goles fallaría con definiciones por penales o goles anulados.
  function scoreboard(i, flipSide) {
    const [a, hm] = i < 0 || i === plays.length - 1 ? [game.away.score ?? 0, game.home.score ?? 0] : scoreAt(plays, i, sport);
    for (const [s, v] of [['away', a], ['home', hm]]) {
      const b = $(`[data-s="${s}"]`);
      if (b.textContent === String(v)) continue;
      b.textContent = v;
      if (!reduce && s === flipSide) b.animate([{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0)' }], { duration: 450, easing: 'ease-out' });
    }
  }

  function show(i, animate, inspect = false) {
    const p = plays[i];
    if (!p) return;
    if (!animate) step++; // un salto cancela lo pendiente; en la repetición la celebración del gol anterior sí debe salir
    cur = i;
    curSeq = p.seq;
    if (!inspect) edgeSeq = p.seq;
    const color = sideCol(p);
    const ago = game.status?.state === 'in' && mode === 'live' && i === plays.length - 1 && !queue.length ? minsAgo(p.at) : null;
    const cap = $('[data-cap]');
    cap.setAttribute('aria-live', mode === 'live' && !queue.length ? 'polite' : 'off'); // durante la repetición o el arrastre, solo se anuncia el final
    const out = outcome(p);
    cap.innerHTML = h`<b>${clockOf(p, sport)}</b> <span class="st-kind" style="--c:${color}">${p.label}</span>
      ${p.who ? h`<span>${p.who}</span>` : ''}${out ? h` <span class="st-out${p.made ? ' ok' : ''}">${out}</span>` : ''}${p.side ? h` <small>${game[p.side].abbr ?? ''}</small>` : ''}${ago ? h` <small class="st-ago">· hace ~${ago} min</small>` : ''}`;
    const scored = p.kind === 'goal' || (p.kind === 'shot' && p.made);
    scoreboard(inspect ? plays.findLastIndex((q) => q.seq <= edgeSeq) : i, animate && scored ? p.side : null); // inspeccionar no cambia el marcador
    if (p.x != null) {
      if (!animate) {
        $('[data-ball]').hidden = false;
        ball = { x: p.x, y: p.y };
        at($('[data-ball]'), p.x, p.y);
        $('[data-trail]').innerHTML = '';
      } else if (SHOTS.has(p.kind)) {
        const target = sport === 'basketball' ? (p.side ? BASKET[p.side] : null) : p.tx != null ? [p.tx, p.ty] : null;
        fly([p.x, p.y], { high: 18, ms: FLY_MS * 0.6 });
        if (target) {
          later(() => {
            trail(p, target);
            fly(scored || sport === 'soccer' ? target : [target[0] + (p.side === 'home' ? -3 : 3), target[1] + 6], { high: sport === 'basketball' ? 90 : 30 });
          }, reduce ? 0 : FLY_MS * 0.6);
        }
        ring(p.x, p.y, color);
      } else {
        $('[data-trail]').innerHTML = '';
        fly([p.x, p.y]);
        ring(p.x, p.y, color);
      }
    } else if (!animate) {
      const last = lastPlaced(plays, i);
      $('[data-ball]').hidden = !last;
      if (last) { ball = { x: last.x, y: last.y }; at($('[data-ball]'), last.x, last.y); }
    }
    if (animate && p.kind === 'goal') later(() => celebrate(`¡GOL de ${game[p.side]?.abbr ?? ''}!`, color), reduce ? 0 : FLY_MS * 1.4);
    if (animate && p.kind === 'shot' && p.made && p.pts === 3) later(() => celebrate(`+3 ${game[p.side]?.abbr ?? ''}`, color), reduce ? 0 : FLY_MS * 1.4);
    const scrub = $('[data-scrub]');
    scrub.value = i;
    scrub.setAttribute('aria-valuetext', `${clockOf(p, sport)} ${p.label}`);
    replayLabel();
    paintLayers();
  }

  const playing = () => mode === 'live' && (queue.length > 0 || pumpTimer != null);
  function replayLabel() {
    $('[data-replay]').textContent = playing() ? 'Pausar' :cur >= plays.length - 1 ? '▶ Repetir el partido' : '▶ Seguir desde aquí';
  }

  // ---------- cola de repetición ----------
  function pump() {
    pumpTimer = null;
    let i = -1;
    while (queue.length && i < 0) i = idxOf(queue.shift()); // una jugada que ESPN quitó en la última carga se salta
    if (stopped || mode !== 'live' || i < 0) return replayLabel();
    pumpTimer = 0; // marca "repitiendo" mientras show() pinta el botón
    show(i, true);
    if (!queue.length) paintFeed();
    // Un partido entero son ~115 jugadas en fútbol y ~500 en la NBA: con cola larga va al doble de velocidad.
    pumpTimer = setTimeout(pump, reduce ? 600 : queue.length > 20 ? STEP_MS / 2 : STEP_MS);
  }

  function pause() {
    step++; // cancela el segundo tramo del tiro y la celebración pendientes
    mode = 'scrub';
    queue.length = 0;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    $('[data-live]').hidden = false;
    replayLabel();
  }

  // Zona de peligro (fútbol): ilumina el tercio donde ataca el equipo según su última jugada de ataque. Solo con "Jugadas".
  function paintAttack() {
    const zone = $('[data-zone]'), badge = $('[data-attack]');
    if (!zone) return;
    const a = layer === 'plays' && cur >= 0 ? attackNow(plays, cur) : null;
    zone.hidden = badge.hidden = !a;
    if (!a) return;
    const x = a.side === 'home' ? a.ax : 100 - a.ax; // vuelve a la x absoluta para saber qué tercio pintar
    zone.style.left = `${(Math.min(2, Math.floor(x / (100 / 3))) * 100) / 3}%`;
    zone.dataset.dir = a.side === 'home' ? 'right' : 'left';
    zone.dataset.level = a.level;
    for (const n of [zone, badge]) n.style.setProperty('--c', col[a.side]);
    badge.dataset.level = a.level;
    badge.textContent = `${ATTACK_ES[a.level]} · ${game[a.side].abbr ?? ''}`;
  }

  // ---------- capas y tableros (hasta la jugada que se está viendo: rebobinar también los rebobina) ----------
  function paintLayers() {
    const edge = edgeSeq == null ? cur : plays.findLastIndex((p) => p.seq <= edgeSeq);
    const upto = plays.slice(0, Math.max(cur, edge) + 1);
    const heatEl = $('[data-heat]'), pins = $('[data-pins]');
    for (const b of el.querySelectorAll('[data-layer]')) b.setAttribute('aria-pressed', String(b.dataset.layer === layer));
    heatEl.hidden = !layer.startsWith('heat');
    if (layer.startsWith('heat')) {
      const side = layer.slice(5), grid = heat(upto, side).flat();
      heatEl.style.setProperty('--c', col[side]);
      // Las celdas difuminadas se crean una vez: en la repetición solo cambia su opacidad (rehacerlas pesa en el celular).
      if (heatEl.children.length !== grid.length) heatEl.innerHTML = '<i></i>'.repeat(grid.length);
      grid.forEach((v, k) => { heatEl.children[k].style.opacity = (v * 0.75).toFixed(2); });
    }
    // Puntos que se pueden tocar: en "Tiros", cada tiro (del jugador elegido, si hay uno); en "Jugadas", el rastro de las últimas.
    for (const n of pins.querySelectorAll('.st-pin')) n.remove();
    const pin = (p, extra = '') => {
      const ok = p.kind === 'goal' || (p.kind === 'shot' && p.made), out = outcome(p);
      const name = `${clockOf(p, sport)} ${p.label}${p.who ? ` de ${p.who}` : ''}${out ? `, ${out}` : ''}`;
      return `<button type="button" class="st-pin${ok ? ' ok' : ''}${p.seq === curSeq ? ' cur' : ''}" data-goto="${p.seq}" style="left:${p.x}%;top:${p.y}%;--c:${col[p.side] ?? '#fff'};${extra}" aria-label="${esc(name)}" title="${esc(name)}"></button>`;
    };
    if (layer === 'shots') {
      pins.insertAdjacentHTML('beforeend', upto.filter((p) => SHOTS.has(p.kind) && p.x != null && (!shooter || p.who === shooter)).map((p) => pin(p)).join(''));
    } else if (layer === 'plays') {
      const recent = upto.filter((p) => p.x != null && p.side).slice(-TRAIL);
      pins.insertAdjacentHTML('beforeend', recent.map((p, k) => pin(p, `opacity:${(0.35 + (0.65 * (k + 1)) / recent.length).toFixed(2)}`)).join(''));
    }
    paintAttack();
    const pick = $('[data-shooter]');
    if (pick) {
      pick.closest('label').hidden = layer !== 'shots';
      const list = shooters(plays), key = list.map((s) => `${s.who}:${s.att}`).join('|');
      if (pick.dataset.key !== key) { // solo cuando hay tiros nuevos: rehacer las opciones cierra el menú abierto
        pick.dataset.key = key;
        pick.innerHTML = h`<option value="">Todos</option>${list.map((s) => h`<option value="${s.who}">${s.who} (${game[s.side].abbr}) · ${s.att} tiros</option>`)}`;
        pick.value = shooter;
      }
    }
    const zones = $('[data-zones]');
    if (zones) {
      zones.hidden = layer !== 'shots';
      if (layer === 'shots') {
        const cell = ({ made, att }) => (att ? `${made}/${att} <small>${Math.round((made / att) * 100)}%</small>` : '—');
        const me = shooter && shooters(plays).find((s) => s.who === shooter);
        if (me) {
          // La planilla de un jugador hasta la jugada que se está viendo: lo que miran las props de puntos y triples.
          const mine = upto.filter((p) => p.who === shooter), l = shotLine(upto, shooter), z = shotZones(mine, me.side);
          const pts = mine.reduce((s, p) => s + ((p.kind === 'shot' || p.kind === 'ft') && p.made ? p.pts : 0), 0);
          zones.innerHTML = h`<h2 style="color:${col[me.side]}">${shooter} <small>${game[me.side].abbr}</small></h2>
            <p class="st-line"><span>Puntos <b>${pts}</b></span><span>De campo <b>${l.fg.made}/${l.fg.att}</b></span><span>Triples <b>${l.three.made}/${l.three.att}</b></span><span>Libres <b>${l.ft.made}/${l.ft.att}</b></span></p>
            <table class="st-ztab"><tbody>${ZONES.map(([k, t]) => h`<tr><th>${t}</th><td>${raw(cell(z[k]))}</td></tr>`)}</tbody></table>`;
        } else {
          const z = { home: shotZones(upto, 'home'), away: shotZones(upto, 'away') };
          zones.innerHTML = h`<h2>Tiros por zona</h2><table class="st-ztab"><thead><tr><th></th><th style="color:${col.away}">${game.away.abbr}</th><th style="color:${col.home}">${game.home.abbr}</th></tr></thead>
            <tbody>${ZONES.map(([k, t]) => h`<tr><th>${t}</th><td>${raw(cell(z.away[k]))}</td><td>${raw(cell(z.home[k]))}</td></tr>`)}</tbody></table>`;
        }
      }
    }
    paintPulse(upto);
  }

  function paintPulse(upto) {
    const box = $('[data-pulse]');
    if (sport === 'soccer') {
      const m = momentum(upto), max = Math.max(1, ...m.flatMap((b) => [b.home, b.away]));
      const w = 100 / m.length, now = upto.at(-1)?.t ?? 0, span = m.length * 300; // con descuento o prórroga hay más de 18 tramos
      const nowX = Math.min(100, (now / span) * 100);
      const bars = m.map((b, i) => `<rect x="${i * w + 0.4}" y="${50 - (b.home / max) * 46}" width="${w - 0.8}" height="${(b.home / max) * 46}" fill="${col.home}"/>`
        + `<rect x="${i * w + 0.4}" y="50" width="${w - 0.8}" height="${(b.away / max) * 46}" fill="${col.away}"/>`).join('');
      const last3 = m.filter((b) => b.t0 <= now).slice(-3), hp = last3.reduce((s, b) => s + b.home, 0), ap = last3.reduce((s, b) => s + b.away, 0);
      const who = hp + ap < 2 ? 'Partido parejo en los últimos 15 minutos.' : `En los últimos 15 minutos presiona más ${hp >= ap ? game.home.abbr : game.away.abbr}.`;
      box.innerHTML = h`<h2>Quién presiona</h2><p class="hint">${who}</p>
        <svg class="st-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Presión por tramos de 5 minutos: ${game.home.abbr} arriba, ${game.away.abbr} abajo">${raw(bars)}
        <line x1="0" y1="50" x2="100" y2="50" class="mid"/><line x1="${nowX}" y1="0" x2="${nowX}" y2="100" class="now"/></svg>
        <p class="st-axis">${raw([[0, "0'"], [2700, "45'"], [5400, "90'"]].map(([t, txt]) => `<span style="left:${(t / span) * 100}%">${txt}</span>`).join(''))}</p>
        <p class="st-legend"><span style="--c:${col.home}">${game.home.abbr} arriba</span><span style="--c:${col.away}">${game.away.abbr} abajo</span></p>`;
      return;
    }
    const wp = upto.filter((p) => p.wp != null);
    const total = Math.max(lg.id === 'wnba' ? 2400 : 2880, plays.at(-1)?.t ?? 0); // tiempo reglamentario: WNBA 4×10 min, NBA 4×12
    const pt = (p) => `${((p.t ?? 0) / total * 100).toFixed(2)},${((1 - p.wp) * 100).toFixed(2)}`;
    const top = runs(upto).sort((a, b) => b.pts - a.pts).slice(0, 3);
    const label = top.map((r) => {
      const end = plays.find((p) => p.seq === r.toSeq);
      return h`<li style="--c:${col[r.side]}">Racha ${r.pts}-0 de ${game[r.side].abbr}${end ? ` (${clockOf(end, sport)})` : ''}</li>`;
    });
    const last = wp.at(-1);
    box.innerHTML = h`<h2>Probabilidad de ganar (ESPN)</h2>
      ${last ? h`<p class="hint">${game.home.abbr} ${Math.round(last.wp * 100)}% · ${game.away.abbr} ${Math.round((1 - last.wp) * 100)}%</p>` : h`<p class="hint">ESPN todavía no publica la probabilidad de este partido.</p>`}
      <svg class="st-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Probabilidad de ganar de ${game.home.abbr} a lo largo del partido">
        <rect x="0" y="0" width="100" height="50" fill="${col.home}" opacity=".07"/><rect x="0" y="50" width="100" height="50" fill="${col.away}" opacity=".07"/>
        <line x1="0" y1="50" x2="100" y2="50" class="mid"/>${[25, 50, 75].map((x) => raw(`<line x1="${x}" y1="0" x2="${x}" y2="100" class="q"/>`))}
        ${wp.length > 1 ? raw(`<polyline points="${wp.map(pt).join(' ')}" class="wp"/>`) : ''}</svg>
      <p class="st-legend"><span style="--c:${col.home}">${game.home.abbr} arriba</span><span style="--c:${col.away}">${game.away.abbr} abajo</span></p>
      ${top.length ? h`<ul class="st-runs">${label}</ul>` : ''}`;
  }

  function paintFeed() {
    const list = plays.slice(Math.max(0, plays.length - 8)).reverse();
    const key = list.map((p) => `${p.seq}:${p.id}:${p.label}:${p.who}:${p.side}:${p.clock}`).join('|');
    if (key === feedKey) return; // sin cambios no se repinta: quien navega con teclado no pierde el foco cada 10 s
    feedKey = key;
    $('[data-feed]').innerHTML = list.length ? h`${list.map((p) => h`<li><button type="button" data-goto="${p.seq}" style="--c:${sideCol(p)}">
      <b>${clockOf(p, sport)}</b> <span class="st-kind">${p.label}</span> ${p.who ?? ''}${p.side ? h` <small>${game[p.side].abbr ?? ''}</small>` : ''}</button></li>`)}` : h`<li class="empty">Sin jugadas todavía.</li>`;
  }

  // ---------- datos ----------
  function paint() {
    if (stopped) return;
    if (!game) {
      el.innerHTML = err ? String(errorBox(err)) : String(empty('No encontramos este partido en ESPN.'));
      return;
    }
    if (!built) build();
    const errHtml = err ? String(errorBox(err)) : '';
    if ($('[data-err]').dataset.html !== errHtml) { $('[data-err]').innerHTML = errHtml; $('[data-err]').dataset.html = errHtml; }
    const st = game.status ?? {};
    $('[data-status]').innerHTML = st.state === 'in' ? h`<span class="gm-live">En vivo</span> ${st.detail ?? ''}` : h`${st.state === 'post' ? 'Final' : st.detail ?? 'Por empezar'}`;
    // La jugada que se está viendo se vuelve a ubicar por seq: ESPN puede traer la lista más corta o en otro orden.
    if (curSeq != null) cur = plays.findLastIndex((p) => p.seq <= curSeq);
    const scrub = $('[data-scrub]');
    scrub.max = Math.max(0, plays.length - 1);
    if (cur >= 0) scrub.value = cur;
    scrub.disabled = plays.length < 2;
    for (const b of el.querySelectorAll('[data-layer],[data-replay]')) b.disabled = !plays.length;
    const placed = plays.some((p) => p.x != null);
    const msg = $('[data-empty]');
    msg.hidden = placed;
    msg.textContent = st.state === 'pre' && !plays.length ? 'El partido todavía no empieza.' : 'Todavía no hay jugadas con posición. En cuanto ESPN publique la primera, aparece aquí.';
    const fresh = newPlays(seen, plays, seen.size ? 12 : FIRST_QUEUE);
    for (const p of plays) seen.add(p.id);
    if (cur < 0 && plays.length) show(Math.max(0, plays.length - 1 - fresh.length), false); // arranca justo antes de lo que va a repetir
    queue.push(...fresh.map((p) => p.seq));
    paintFeed();
    if (mode === 'live' && !pumpTimer) pump(); // si ya está repitiendo, lo nuevo espera su turno en la cola
    if (cur < 0) { scoreboard(-1); paintLayers(); }
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-layer],[data-live],[data-goto],[data-replay]');
    if (!b || !plays.length) return;
    if (b.dataset.layer) { layer = b.dataset.layer; paintLayers(); return; }
    if (b.hasAttribute('data-replay')) {
      if (playing()) return pause();
      const from = cur >= plays.length - 1 ? 0 : cur + 1; // al final, vuelve a empezar
      if (from === 0) show(0, false);
      mode = 'live';
      $('[data-live]').hidden = true;
      queue.length = 0;
      queue.push(...plays.slice(from === 0 ? 1 : from).map((p) => p.seq));
      return pump();
    }
    if (b.hasAttribute('data-live')) {
      pause();
      mode = 'live';
      b.hidden = true;
      show(plays.length - 1, false);
      return;
    }
    pause();
    show(idxOf(Number(b.dataset.goto)), false, b.classList.contains('st-pin')); // un punto de la cancha solo se inspecciona
  });
  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-shooter]')) return;
    shooter = e.target.value;
    paintLayers();
  });
  el.addEventListener('input', (e) => {
    if (!e.target.matches('[data-scrub]')) return;
    pause();
    show(Number(e.target.value), false);
  });

  await load();
  paint();
  const poll = setInterval(() => {
    if (document.hidden || game?.status?.state === 'post') return; // un partido terminado ya no cambia
    load().then(paint);
  }, POLL_MS);
  return () => { stopped = true; clearInterval(poll); clearTimeout(pumpTimer); };
}
