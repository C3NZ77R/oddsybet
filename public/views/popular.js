// Populares: props más vistos / agregados SEGÚN LA ACTIVIDAD LOCAL (store.views). No existe una fuente
// gratis de popularidad global; sin actividad se muestran las mejores rachas L10 de los props disponibles.
import { leagueById } from '../leagues.js';
import { statOf } from '../stats.js';
import { propKey } from '../ui.js';
import { SIDE, H, statDef, statName, matchup, oddsyOf, oddsHtml, pool, logFor, loadUpcoming } from './insights.js';

const TABS = { view: 'Más vistos', add: 'Más agregados' };
const TOP = 20;

const parseKey = (k) => {
  try {
    return JSON.parse(decodeURIComponent(k));
  } catch {
    return null;
  }
};
// store.views: { [propKey]: n } o { [propKey]: { view, add } } (architecture.md no fija la forma).
const counts = (v) => (typeof v === 'number' ? { view: v, add: 0 } : { view: v?.view ?? v?.views ?? 0, add: v?.add ?? v?.adds ?? 0 });
const athKey = (p) => p.athleteId ?? p.player;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default {
  title: 'Populares',
  render(el, { league, api, store, ui }) {
    const { esc } = ui;
    const lg = leagueById(league);
    if (!lg) {
      el.innerHTML = H(ui.empty('Liga desconocida.'));
      return;
    }
    let dead = false;
    let tab = 'view';
    let data = null; // { games, props, source }
    const logs = new Map(); // athKey -> GameLog | null (sin datos)
    let loadingLogs = 0;

    el.innerHTML = `<section class="pop">
      <h1>Populares ${esc(lg.title)}</h1>
      <div class="pop-tabs" role="tablist" aria-label="Ranking">
        ${Object.entries(TABS).map(([k, l]) => `<button type="button" role="tab" id="pop-tab-${k}" data-tab="${k}" aria-controls="pop-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}">${l}</button>`).join('')}
      </div>
      <p class="pop-note"></p>
      <p class="pop-progress" role="status"></p>
      <div class="pop-list" id="pop-panel" role="tabpanel" aria-labelledby="pop-tab-${tab}"></div>
    </section>`;
    const root = el.querySelector('.pop');
    const listEl = root.querySelector('.pop-list');
    const alive = () => !dead && root.isConnected;

    const tabsEl = root.querySelector('.pop-tabs');
    const select = (k) => {
      tab = k;
      for (const b of tabsEl.children) {
        b.setAttribute('aria-selected', String(b.dataset.tab === k));
        b.tabIndex = b.dataset.tab === k ? 0 : -1;
      }
      listEl.setAttribute('aria-labelledby', `pop-tab-${k}`);
      update();
    };
    tabsEl.addEventListener('click', (e) => e.target.closest('[data-tab]') && select(e.target.closest('[data-tab]').dataset.tab));
    tabsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = tab === 'view' ? 'add' : 'view';
      select(next);
      tabsEl.querySelector(`[data-tab="${next}"]`).focus();
    });

    // Filas de actividad local que corresponden a un prop vigente de esta liga.
    function activityRows() {
      const views = store.get('views') || {};
      const rows = [];
      for (const [k, v] of Object.entries(views)) {
        const key = parseKey(k);
        const c = counts(v);
        if (!key || !c[tab]) continue;
        const same = data.props.filter((p) => p.player === key.p && p.stat === key.s && Number(p.line) === Number(key.l) && p.side === key.o);
        if (same.length) rows.push({ prop: same[0], same, ...c });
      }
      const other = tab === 'view' ? 'add' : 'view';
      return rows.sort((a, b) => b[tab] - a[tab] || b[other] - a[other]).slice(0, TOP);
    }

    // Acierto en los últimos 10 partidos, del más antiguo al más reciente.
    function l10(p) {
      const gl = logs.get(athKey(p));
      if (!gl) return null;
      const vals = (gl.games || []).map((g) => statOf(lg.sport, p.stat, g.stats)).filter(Number.isFinite).slice(0, 10);
      if (!vals.length) return null;
      // null = push (igual a la línea), como lo espera ui.hitBar.
      const results = vals.map((v) => (v === p.line ? null : p.side === 'Under' ? v < p.line : v > p.line)).reverse();
      const hits = results.filter((x) => x === true).length;
      const n = results.filter((x) => x != null).length;
      return n ? { results, hits, n, pct: hits / n } : null;
    }

    async function ensureLogs(props) {
      const need = [...new Map(props.filter((p) => !logs.has(athKey(p))).map((p) => [athKey(p), p])).values()];
      if (!need.length) return;
      loadingLogs += need.length;
      draw();
      need.forEach((p) => logFor(api, league, p).catch(() => {})); // un solo /api/gamelogs para todos
      await pool(need, 4, async (p) => {
        try {
          logs.set(athKey(p), await logFor(api, league, p));
        } catch {
          logs.set(athKey(p), null);
        }
        loadingLogs--;
        schedule();
      }, alive);
      draw();
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

    const card = (r) => {
      const p = r.prop;
      const g = data.games.get(p.gameId);
      const gl = logs.get(athKey(p));
      const a = gl?.athlete ?? { id: p.athleteId, name: p.player, short: p.player, headshot: null, teamAbbr: p.team };
      const abbr = a.teamAbbr ?? p.team;
      const team = [g?.home, g?.away].find((t) => t && t.abbr === abbr);
      const top = oddsyOf(r.same ?? [p]);
      const hit = r.hit;
      return `<article class="pop-card">
        <a class="pop-link" href="#/${esc(league)}/props/${esc(propKey(p))}">
          <span class="pop-img">${H(ui.headshot(a, { size: 48 }))}${team ? `<span class="pop-badge">${H(ui.teamLogo(team, { size: 18 }))}</span>` : ''}</span>
          <span class="pop-main">
            <small>${esc([matchup(g, p), g?.start || p.start ? ui.when(g?.start ?? p.start) : ''].filter(Boolean).join(' · '))}</small>
            <b>${esc(`${p.player} - ${statName(statDef(lg.sport, p), p)} ${SIDE[p.side] ?? p.side} ${p.line}`)}</b>
          </span>
        </a>
        <div class="pop-foot">
          <span class="pop-hit">${hit ? `${H(ui.hitBar(hit.results))}<small>Últ. 10 · ${hit.hits}/${hit.n}</small>` : `<small>${logs.has(athKey(p)) ? 'Sin historial' : 'Cargando acierto…'}</small>`}</span>
          <span class="pop-odds">${oddsHtml(ui, top)}</span>
        </div>
        ${r.view != null ? `<small class="pop-counts">${plural(r.view, 'vista', 'vistas')} · ${plural(r.add, 'agregado', 'agregados')}</small>` : ''}
      </article>`;
    };

    let mode = null;
    function draw() {
      if (!alive() || !data) return;
      const act = activityRows();
      mode = act.length ? 'act' : 'top';
      let rows;
      if (mode === 'act') rows = act.map((r) => ({ ...r, hit: l10(r.prop) }));
      else {
        rows = data.props.map((p) => ({ prop: p, hit: l10(p) })).filter((r) => r.hit);
        rows = rows.sort((a, b) => b.hit.pct - a.hit.pct || b.hit.n - a.hit.n).slice(0, TOP);
      }
      root.querySelector('.pop-note').innerHTML = mode === 'act'
        ? 'Los props que más abriste o agregaste al boleto aquí. No vemos lo que hacen otros usuarios.'
        : `Aún no has ${tab === 'view' ? 'abierto' : 'agregado al boleto'} props de esta liga aquí. Mientras, van los que más se cumplieron en los últimos 10 partidos.`;
      root.querySelector('.pop-progress').innerHTML = loadingLogs
        ? `Calculando aciertos: faltan ${loadingLogs} jugadores…`
        : data.source ? H(ui.sourceBadge(data.source)) : '';
      listEl.innerHTML = rows.length
        ? rows.map(card).join('')
        : loadingLogs ? '' : data.props.length ? H(ui.empty('No hay historial de jugadores para calcular rachas.'))
          : `${H(ui.empty('Abre un partido para ver sus props.'))}<p class="pop-note">Aquí solo salen los próximos 3 partidos de hoy. <a href="#/${esc(league)}/games">Ver partidos</a></p>`;
    }

    // Al cambiar de pestaña o de modo, se cargan los game logs que falten para lo que se va a mostrar.
    function update() {
      draw();
      if (data) ensureLogs(mode === 'act' ? activityRows().map((r) => r.prop) : data.props);
    }

    (async () => {
      listEl.innerHTML = H(ui.loading());
      const res = await loadUpcoming(api, league);
      if (!alive()) return;
      if (res.error && !res.props.length) {
        listEl.innerHTML = H(ui.errorBox(res.error));
        return;
      }
      data = res;
      update();
    })();

    return () => {
      dead = true;
    };
  },
};
