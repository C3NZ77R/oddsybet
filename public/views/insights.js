// Insights: frases de tendencia calculadas con game logs reales (ESPN) para los partidos de hoy a +3 días,
// cruzadas con las cuotas propias de /api/props (modelo Oddsy). Las de equipo van sin cuota (ESPN solo trae líneas de casas).
import { leagueById } from '../leagues.js';
import { STATS, statForMarket } from '../stats.js';
import { insightsFor, teamInsights, decimalToAmerican } from '../betmath.js';
import { dataOf, propKey, ymd } from '../ui.js';

// --- Utilidades compartidas con popular.js (mismo dueño, fuera del contrato público) ---

export const SIDE = { Over: 'Más de', Under: 'Menos de' };
export const H = (x) => x ?? ''; // HTML de un helper de texto de ui.js
export const statDef = (sport, p) => STATS[sport]?.find((s) => s.key === p.stat) ?? statForMarket(sport, p.market);
export const statName = (def, p) => def?.name ?? def?.label ?? p.stat;
export const matchup = (g, p) => (g ? `${g.away.abbr} @ ${g.home.abbr}` : [p?.team, p?.opp].filter(Boolean).join(' vs '));
// Cuota americana escrita a mano: el teclado o un texto copiado pueden traer «−» (U+2212) o «+» al inicio.
export const americanIn = (v) => {
  const s = String(v ?? '').trim().replace(/^\+/, '').replace(/^\u2212/, '-');
  return s && Number.isFinite(Number(s)) ? Number(s) : null;
};

// Cuota Oddsy (con margen) y justa (1/p) del prop; hay una sola por jugador, estadística, línea y lado.
export function oddsyOf(props) {
  const p = props.find((q) => q.books?.[0]?.price > 1);
  return p ? { price: p.books[0].price, fair: p.fair, p: p.p, book: 'oddsy' } : null;
}
// Cuota Oddsy y justa en una celda.
export const oddsHtml = (ui, o) => (o?.price ? `<b title="Cuota Oddsy, con margen">${ui.esc(ui.fmtOdds(o.price))}</b>${o.fair ? `<small title="Cuota justa, sin margen">Justa ${ui.esc(ui.fmtOdds(o.fair))}</small>` : ''}` : '<small>sin cuota</small>');

// Ejecuta run(item) con a lo sumo `limit` en paralelo; run no debe lanzar.
export async function pool(items, limit, run, alive) {
  let i = 0;
  const worker = async () => {
    while (alive() && i < items.length) await run(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Game log por jugador, cacheado en memoria durante la sesión (si falla se reintenta la próxima vez).
// shortcut: caché sin límite de tamaño, suficiente para una pestaña; acotarla si crece la cantidad de ligas.
const logs = new Map();
export function logFor(api, league, p) {
  const k = `${league}:${p.athleteId ?? p.player}`;
  if (!logs.has(k)) {
    const job = (async () => {
      let id = p.athleteId;
      if (id == null) id = (dataOf(await api.search(league, p.player)) || []).find((a) => a.name?.toLowerCase() === p.player?.toLowerCase())?.id;
      if (id == null) throw new Error(`Sin id de ESPN para ${p.player}`);
      return dataOf(await api.gamelog(league, id));
    })();
    logs.set(k, job);
    job.catch(() => logs.delete(k));
  }
  return logs.get(k);
}

// Partidos de hoy a +3 días y props de la liga (sin los de partidos ya terminados).
export async function loadUpcoming(api, league) {
  const days = Array.from({ length: 4 }, (_, i) => ymd(new Date(Date.now() + i * 864e5)));
  const [pr, ...gr] = await Promise.allSettled([api.props(league), ...days.map((d) => api.games(league, d))]);
  const games = new Map();
  for (const r of gr) if (r.status === 'fulfilled') for (const g of dataOf(r.value) || []) games.set(g.id, g);
  const props = pr.status === 'fulfilled' ? (dataOf(pr.value) || []).filter((p) => games.get(p.gameId)?.status?.state !== 'post') : [];
  return { games, props, source: pr.value?.source ?? null, error: pr.reason ?? (gr.every((r) => r.status === 'rejected') ? gr[0].reason : null) };
}

// --- Clasificación de cada insight para los filtros ---

const CATS = { racha: 'Racha seguida', kden: 'Casi siempre en los últimos partidos', loc: 'Local / visita', prom: 'Promedio', ats: 'Equipo contra el hándicap', ml: 'Equipo como favorito o no favorito', ou: 'Total del partido (más o menos)' };
const SPLITS = { home: 'Local', away: 'Visita' };

// El tipo lo pone betmath; si no trae el split, se deduce del tipo y, en último caso, de la frase.
function splitOf(ins) {
  const s = ins.split ?? ins.location;
  if (s === 'home' || s === 'away') return s;
  const t = `${ins.type} ${ins.text}`;
  if (/home|\blocal\b|en casa/i.test(t)) return 'home';
  if (/away|road|visita|fuera de casa/i.test(t)) return 'away';
  return 'all';
}

function playerCat(ins, split) {
  if (split !== 'all') return 'loc';
  if (/avg|prom|mean/i.test(ins.type)) return 'prom';
  if (/streak|racha/i.test(ins.type) || (ins.n && ins.k === ins.n)) return 'racha';
  return 'kden';
}

// k/n es inequívoco; pct solo si falta (y por si viniera en 0-100).
const pctOf = (ins) => (ins.n && ins.k != null ? ins.k / ins.n : ins.pct > 1 ? ins.pct / 100 : ins.pct ?? 0);

function teamOf(gd, ins) {
  for (const v of [ins.team, ins.side]) if (v === 'home' || v === 'away') return gd[v];
  const id = ins.team?.id ?? ins.teamId ?? ins.team;
  return [gd.home, gd.away].find((t) => t && id != null && (t.id === id || t.abbr === id || t.abbr === ins.team?.abbr)) ?? null;
}

const SORTS = {
  pct: (a, b) => b.pct - a.pct || b.n - a.n,
  odds: (a, b) => (b.price ?? 0) - (a.price ?? 0) || b.pct - a.pct,
  time: (a, b) => new Date(a.start || 8.64e15) - new Date(b.start || 8.64e15) || b.pct - a.pct,
};

const PAGE = 60;
const fresh = () => ({ cat: new Set(), game: new Set(), player: new Set(), team: new Set(), stat: new Set(), oMin: null, oMax: null, minPct: 0, split: 'all', side: 'all', sort: 'pct' });

export default {
  title: 'Tendencias',
  render(el, { league, api, store, ui }) {
    const { esc } = ui;
    const lg = leagueById(league);
    if (!lg) {
      el.innerHTML = H(ui.empty('Liga desconocida.'));
      return;
    }
    const sport = lg.sport;
    let dead = false;
    const items = [];
    let f = fresh();
    let page = PAGE;
    let shown = [];
    const prog = { done: 0, total: 0, failed: 0, loading: true, games: 0, players: 0, source: null };

    const multi = (name, label) => `<details class="ins-flt" data-name="${name}"><summary>${label}<span class="ins-n"></span></summary><div class="ins-opts" role="group" aria-label="${label}"></div></details>`;
    const sel = (name, label, opts) => `<label class="ins-sel">${label} <select name="${name}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
    el.innerHTML = `<section class="ins">
      <h1>Tendencias ${esc(lg.title)}</h1>
      <p class="hint">Cómo vienen jugadores y equipos en sus últimos partidos, para los juegos de hoy y los próximos 3 días.</p>
      <form class="ins-bar" aria-label="Filtros de tendencias">
        ${multi('cat', 'Tipo')}${multi('game', 'Partidos')}${multi('player', 'Jugadores')}${multi('team', 'Equipos')}
        <details class="ins-flt" data-name="odds"><summary>Cuotas<span class="ins-n"></span></summary><div class="ins-opts ins-range">
          <label>Desde (americana) <input name="oMin" type="text" placeholder="-300"></label>
          <label>Hasta (americana) <input name="oMax" type="text" placeholder="+200"></label>
        </div></details>
        ${multi('stat', 'Estadísticas')}
        ${sel('minPct', 'Acierto mínimo', [['0', 'Cualquiera'], ['50', '50 %'], ['60', '60 %'], ['70', '70 %'], ['80', '80 %'], ['90', '90 %'], ['100', '100 %']])}
        ${sel('split', 'Local o visita', [['all', 'Todos'], ['home', 'Local'], ['away', 'Visita']])}
        ${sel('side', 'Más/Menos', [['all', 'Ambos'], ['Over', 'Más de'], ['Under', 'Menos de']])}
        ${sel('sort', 'Orden', [['pct', 'Acierto'], ['odds', 'Cuota'], ['time', 'Hora']])}
        <button type="button" class="ins-reset">Limpiar</button>
        <output class="ins-count" aria-live="polite"></output>
      </form>
      <p class="ins-progress" role="status"></p>
      <div class="ins-list"></div>
    </section>`;
    const root = el.querySelector('.ins');
    const form = root.querySelector('.ins-bar');
    const listEl = root.querySelector('.ins-list');
    const alive = () => !dead && root.isConnected;

    // --- Filtros ---
    const optLists = {
      cat: () => [...new Set(items.map((i) => i.cat))].map((c) => [c, CATS[c] ?? c]),
      game: () => [...new Map(items.filter((i) => i.gameId).map((i) => [i.gameId, i])).values()].sort(SORTS.time).map((i) => [i.gameId, `${i.gameLabel}${i.start ? ` · ${ui.when(i.start)}` : ''}`]),
      player: () => [...new Set(items.map((i) => i.player).filter(Boolean))].sort().map((p) => [p, p]),
      team: () => [...new Set(items.flatMap((i) => i.teams))].sort().map((t) => [t, t]),
      stat: () => [...new Map(items.filter((i) => i.statKey).map((i) => [i.statKey, i.statLabel])).entries()],
    };
    const built = {};
    function refreshOpts(force) {
      for (const d of form.querySelectorAll('details[data-name]')) {
        const name = d.dataset.name;
        const n = name === 'odds' ? (f.oMin != null) + (f.oMax != null) : f[name].size;
        d.querySelector('.ins-n').textContent = n ? ` (${n})` : '';
        if (!optLists[name] || (d.open && !force)) continue; // no se reconstruye un menú abierto
        const opts = optLists[name]();
        const sig = JSON.stringify(opts);
        if (sig === built[name] && !force) continue;
        built[name] = sig;
        d.querySelector('.ins-opts').innerHTML = opts.length
          ? opts.map(([v, l]) => `<label><input type="checkbox" name="${name}" value="${esc(v)}"${f[name].has(String(v)) ? ' checked' : ''}> ${esc(l)}</label>`).join('')
          : '<small class="ins-none">Sin opciones todavía</small>';
      }
    }
    function readForm() {
      const fd = new FormData(form);
      const num = (k) => (fd.get(k) === '' || fd.get(k) == null ? null : Number(fd.get(k)));
      for (const k of Object.keys(optLists)) f[k] = new Set(fd.getAll(k));
      Object.assign(f, { oMin: americanIn(fd.get('oMin')), oMax: americanIn(fd.get('oMax')), minPct: num('minPct') ?? 0, split: fd.get('split'), side: fd.get('side'), sort: fd.get('sort') });
    }
    const pass = (it) => {
      if (f.cat.size && !f.cat.has(it.cat)) return false;
      if (f.game.size && !f.game.has(String(it.gameId))) return false;
      if (f.player.size && !f.player.has(it.player)) return false;
      if (f.team.size && !it.teams.some((t) => f.team.has(t))) return false;
      if (f.stat.size && !f.stat.has(it.statKey)) return false;
      if (it.pct * 100 < f.minPct - 1e-9) return false;
      if (f.split !== 'all' && it.split !== f.split) return false;
      if (f.side !== 'all' && it.side !== f.side) return false;
      if (f.oMin != null || f.oMax != null) {
        if (!it.price) return false;
        const a = decimalToAmerican(it.price);
        if ((f.oMin != null && a < f.oMin) || (f.oMax != null && a > f.oMax)) return false;
      }
      return true;
    };
    form.addEventListener('input', () => {
      readForm();
      page = PAGE;
      draw();
    });
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('toggle', (e) => !e.target.open && refreshOpts(), true);
    form.querySelector('.ins-reset').addEventListener('click', () => {
      form.reset();
      f = fresh();
      page = PAGE;
      refreshOpts(true);
      draw();
    });

    // --- Tarjetas ---
    const slip = () => new Set((store.get('picks') || []).map((p) => p.id));
    const card = (it, i, inSlip) => `<article class="ins-card">
      <header class="ins-ent">
        <span class="ins-img">${it.img}</span>
        <div class="ins-who">${it.href ? `<a href="${esc(it.href)}">${esc(it.name)}</a>` : `<b>${esc(it.name)}</b>`}<small>${esc([it.teamAbbr, it.gameLabel].filter(Boolean).join(' · '))}</small></div>
        ${it.start ? `<time datetime="${esc(it.start)}">${esc(ui.when(it.start))}</time>` : ''}
      </header>
      <p class="ins-text">${esc(it.text)}</p>
      <div class="ins-out">
        <span class="ins-pick">${esc(it.outcome)}</span>
        <span class="ins-hit">${H(ui.hitBar(it.pct))}${it.n ? `<small>${it.k}/${it.n}</small>` : ''}</span>
        <span class="ins-odds">${it.kind === 'player' ? oddsHtml(ui, it) : it.price ? `<b>${esc(ui.fmtOdds(it.price))}</b>${H(ui.bookChip(it.book))}` : '<small>sin cuota</small>'}</span>
        <button type="button" class="ins-add" data-i="${i}"${it.price ? '' : ' disabled'} aria-pressed="${inSlip.has(it.pickId)}" aria-label="${inSlip.has(it.pickId) ? 'Quitar del boleto' : 'Agregar al boleto'}: ${esc(it.pickLabel)}">${inSlip.has(it.pickId) ? '✓' : '+'}</button>
      </div>
    </article>`;

    function draw() {
      if (!alive()) return;
      shown = items.filter(pass).sort(SORTS[f.sort] ?? SORTS.pct);
      form.querySelector('.ins-count').textContent = `${shown.length}/${items.length} tendencias`;
      const inSlip = slip();
      const rest = shown.length - page;
      listEl.innerHTML = shown.length
        ? shown.slice(0, page).map((it, i) => card(it, i, inSlip)).join('') + (rest > 0 ? `<button type="button" class="ins-more">Mostrar más (${rest})</button>` : '')
        : prog.loading ? '' : H(ui.empty(items.length ? 'Ninguna tendencia cumple los filtros.' : 'No hay tendencias para los próximos partidos.'));
      // Sin props de jugador (solo cubren los próximos 3 partidos de hoy) quedan solo los insights de equipo.
      if (!prog.loading && !prog.props) listEl.insertAdjacentHTML('afterbegin', `<p class="hint">Por ahora solo hay tendencias de equipos. Las de jugadores salen para los 3 próximos partidos de hoy; para otro, ábrelo en <a href="#/${esc(league)}/games">Partidos</a>.</p>`);
      root.querySelector('.ins-progress').innerHTML = prog.loading
        ? `Analizando ${prog.done} de ${prog.total || '…'} (partidos y jugadores)…`
        : `${prog.games} partidos y ${prog.players} jugadores analizados${prog.failed ? ` · ${prog.failed} sin datos` : ''}. ${prog.source ? H(ui.sourceBadge(prog.source)) : ''}`;
      refreshOpts();
    }
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        draw();
      }, 250);
    };

    listEl.addEventListener('click', (e) => {
      if (e.target.closest('.ins-more')) {
        page += PAGE;
        draw();
        listEl.querySelectorAll('.ins-card')[page - PAGE]?.querySelector('a, button')?.focus();
        return;
      }
      const b = e.target.closest('.ins-add');
      const it = b && shown[Number(b.dataset.i)];
      if (!it?.price) return;
      const on = slip().has(it.pickId);
      if (on) store.removePick(it.pickId);
      else {
        store.addPick({ id: it.pickId, label: it.pickLabel, price: it.price, book: it.book, league, gameId: it.gameId, addedAt: Date.now() });
        if (it.propKey) store.track(it.propKey, 'add');
      }
      // Se actualiza el botón en su sitio para no perder el foco.
      b.setAttribute('aria-pressed', String(!on));
      b.setAttribute('aria-label', `${on ? 'Agregar al boleto' : 'Quitar del boleto'}: ${it.pickLabel}`);
      b.textContent = on ? '+' : '✓';
    });

    // --- Generación ---
    function addPlayer(gl, ps, games) {
      const seen = new Set();
      const a = gl.athlete || { name: ps[0].player };
      for (const p of ps) {
        const def = statDef(sport, p);
        if (!def) continue;
        let list = [];
        try {
          list = insightsFor({ athlete: a, gamelog: gl, prop: p, statDef: def, league }) || [];
        } catch {
          continue;
        }
        for (const ins of list) {
          const side = ins.side ?? p.side;
          const line = ins.line ?? p.line;
          const id = [p.stat, side, line, ins.type, ins.text].join('|');
          if (seen.has(id)) continue;
          seen.add(id);
          const same = ps.filter((q) => q.stat === p.stat && q.line === line && q.side === side);
          const kp = same[0] ?? { ...p, side, line };
          const top = oddsyOf(same);
          const g = games.get(p.gameId);
          const split = splitOf(ins);
          const sName = statName(def, p);
          const teamAbbr = a.teamAbbr ?? p.team ?? '';
          items.push({
            kind: 'player', cat: playerCat(ins, split), split, text: ins.text, side, pct: pctOf(ins), k: ins.k, n: ins.n ?? 0,
            price: top?.price ?? null, fair: top?.fair ?? null, book: top?.book ?? null, start: g?.start ?? p.start ?? null, gameId: p.gameId ?? null,
            gameLabel: matchup(g, p), player: p.player, teams: teamAbbr ? [teamAbbr] : [], teamAbbr, statKey: p.stat, statLabel: sName,
            name: a.name ?? p.player, img: H(ui.headshot(a, { league })), href: `#/${league}/props/${propKey(kp)}`, propKey: propKey(kp),
            outcome: `${SIDE[side] ?? side} ${line} ${sName}`, pickId: propKey(kp), pickLabel: `${p.player} ${SIDE[side] ?? side} ${line} ${sName}`,
          });
        }
      }
    }

    function addTeam(gd) {
      let list = [];
      try {
        list = teamInsights(gd) || [];
      } catch {
        return;
      }
      // Sin cuota: ESPN solo trae líneas de casas y Oddsy no muestra precios ajenos (Ruling 11).
      const gameLabel = matchup(gd);
      list.forEach((ins, i) => {
        const t = teamOf(gd, ins);
        const ou = ins.side === 'Over' || ins.side === 'Under';
        const cat = ou ? 'ou' : /ats|spread|hand/i.test(ins.type) ? 'ats' : 'ml';
        const outcome = ou ? `Total del partido: ${ins.side === 'Over' ? 'más' : 'menos'}` : t ? `${t.abbr} ${cat === 'ats' ? 'con hándicap' : 'gana'}` : ins.side ?? '';
        items.push({
          kind: 'team', cat, split: splitOf(ins), text: ins.text, side: ou ? ins.side : null, pct: pctOf(ins), k: ins.k, n: ins.n ?? 0,
          price: null, book: null, start: gd.start, gameId: gd.id, gameLabel,
          player: null, teams: t ? [t.abbr] : [gd.away.abbr, gd.home.abbr], teamAbbr: '', statKey: null, statLabel: null,
          name: t?.name ?? gameLabel, img: t ? H(ui.teamLogo(t, { size: 40 })) : H(ui.teamLogo(gd.away, { size: 32 })) + H(ui.teamLogo(gd.home, { size: 32 })), href: `#/${league}/games/${encodeURIComponent(gd.id)}`,
          propKey: null, outcome, pickId: `${gd.id}|${ins.type}|${ins.side ?? ''}|${i}`, pickLabel: `${gameLabel}: ${outcome}`,
        });
      });
    }

    (async () => {
      draw();
      const { games, props, source, error } = await loadUpcoming(api, league);
      if (!alive()) return;
      prog.source = source;
      prog.props = props.length;
      if (error && !games.size && !props.length) {
        prog.loading = false;
        listEl.innerHTML = H(ui.errorBox(error));
        root.querySelector('.ins-progress').textContent = '';
        return;
      }
      const byAth = new Map();
      for (const p of props) {
        const k = p.athleteId ?? p.player;
        if (!byAth.has(k)) byAth.set(k, []);
        byAth.get(k).push(p);
      }
      const pre = [...games.values()].filter((g) => g.status?.state === 'pre');
      const tasks = [...pre.map((g) => ({ g })), ...[...byAth.values()].map((ps) => ({ ps }))];
      prog.total = tasks.length;
      draw();
      // Todos los game logs en el mismo tick: api.gamelog los junta en uno o dos /api/gamelogs.
      for (const ps of byAth.values()) logFor(api, league, ps[0]).catch(() => {});
      await pool(tasks, 4, async ({ g, ps }) => {
        try {
          if (g) {
            addTeam(dataOf(await api.game(league, g.id)));
            prog.games++;
          } else {
            addPlayer(await logFor(api, league, ps[0]), ps, games);
            prog.players++;
          }
        } catch {
          prog.failed++;
        }
        prog.done++;
        schedule();
      }, alive);
      prog.loading = false;
      draw();
    })();

    return () => {
      dead = true;
    };
  },
};
