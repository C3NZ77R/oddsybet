// Ficha de jugador ATP (#/tennis-player/{id}): ranking, puntos y Elo (general y por superficie), % de "más de X" en
// L5/L10/L20 para games totales, games ganados y sets ganados, y tabla de los últimos partidos con filtro de superficie.
// Datos de /api/tennis/player.
import { h, hitBar, dropdown, sortableTable, teamLogo, sourceBadge } from '../ui.js';
import { STATS } from '../stats.js';

const SURF = { hard: 'Dura', clay: 'Arcilla', grass: 'Hierba' };
// Líneas elegibles por estadística de STATS.tennis; la primera de cada una es la inicial.
const LINES = {
  total_games: [22.5, 16.5, 18.5, 20.5, 21.5, 23.5, 24.5, 26.5, 30.5, 36.5, 40.5],
  games_won: [12.5, 6.5, 8.5, 10.5, 11.5, 13.5, 14.5, 16.5, 18.5, 20.5],
  sets_won: [1.5, 0.5, 2.5],
};
const statName = (key) => STATS.tennis.find((d) => d.key === key).name;
const full = ([x, y]) => (Math.max(x, y) >= 6 && Math.abs(x - y) >= 2) || Math.max(x, y) === 7; // set terminado
const dateTxt = (iso) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: '2-digit' });

// Un partido visto desde el jugador id: rival, marcador propio primero, sets ganados-perdidos y las estadísticas de
// STATS.tennis (total_games, games_won, sets_won).
export function perspective(m, id) {
  const i = m.a.id === id ? 0 : 1;
  const sets = m.sets.map((s) => [s[i], s[1 - i], ...(s.length > 2 ? [s[2 + i], s[3 - i]] : [])]);
  const done = sets.filter(full);
  return {
    id: m.id,
    date: m.date,
    opp: i ? m.a : m.b,
    tournament: m.tournament,
    round: m.round,
    surface: m.surface,
    won: m.winner === (i ? 'b' : 'a'),
    retired: m.retired,
    score: sets.map(([x, y, tx, ty]) => `${x}-${y}${tx != null ? `(${Math.min(tx, ty)})` : ''}`).join(' '),
    total_games: sets.reduce((t, [x, y]) => t + x + y, 0),
    games_won: sets.reduce((t, [x]) => t + x, 0),
    sets_won: done.filter(([x, y]) => x > y).length,
    sets: `${done.filter(([x, y]) => x > y).length}-${done.filter(([x, y]) => y > x).length}`,
  };
}

export function headHtml({ player: p, rank, points, elo }) {
  const kpi = (dt, dd) => h`<div><dt>${dt}</dt><dd>${dd ?? '—'}</dd></div>`;
  return h`<header class="tn-head card">${teamLogo({ logo: p.flag, name: p.name }, { size: 48 })}
    <div class="tn-name"><h1>${p.name}</h1>${p.country ? h`<p class="hint">${p.country}</p>` : ''}</div>
    <dl class="tn-kpis">${kpi('Ranking', rank ? `#${rank}` : null)}${kpi('Puntos', points?.toLocaleString('es-CO'))}${kpi('Elo', elo ? Math.round(elo.all) : null)}
      ${Object.entries(SURF).map(([k, t]) => kpi(`Elo ${t.toLowerCase()}`, elo?.ns?.[k] ? Math.round(elo[k]) : null))}</dl></header>`;
}

// % de partidos con más de `line` de la estadística en los últimos 5, 10 y 20 (rows del más reciente al más antiguo; sin retiros).
export function hitsHtml(rows, stat, line) {
  const valid = rows.filter((r) => !r.retired);
  return h`<ul class="tn-hits">${[5, 10, 20].map((n) => {
    const last = valid.slice(0, n);
    const k = last.filter((r) => r[stat] > line).length;
    return h`<li><b>Últ. ${n}</b>${hitBar(last.length ? k / last.length : null, { label: true })}<small>${k} de ${last.length}</small></li>`;
  })}</ul>`;
}

const COLUMNS = [
  { key: 'date', label: 'Fecha', render: (r) => dateTxt(r.date), sort: (r) => Date.parse(r.date) },
  { key: 'opp', label: 'Rival', sort: (r) => r.opp.name, defaultDir: 'asc',
    render: (r) => h`<a class="tn-player" href="#/tennis-player/${encodeURIComponent(r.opp.id)}">${teamLogo({ logo: r.opp.flag, name: r.opp.name }, { size: 20 })}${r.opp.name}</a>` },
  { key: 'tournament', label: 'Torneo', defaultDir: 'asc', render: (r) => h`${r.tournament}${r.round ? h`<br><small class="tn-muted">${r.round}</small>` : ''}` },
  { key: 'surface', label: 'Superficie', defaultDir: 'asc', render: (r) => SURF[r.surface] ?? r.surface },
  { key: 'won', label: 'Resultado', sort: (r) => Number(r.won), render: (r) => h`<b class="${r.won ? 'tn-w' : 'tn-l'}">${r.won ? 'Ganó' : 'Perdió'}</b>` },
  { key: 'score', label: 'Marcador', sortable: false, render: (r) => `${r.score}${r.retired ? ' (retiro)' : ''}` },
  { key: 'total_games', label: statName('total_games'), align: 'right' },
  { key: 'games_won', label: statName('games_won'), align: 'right' },
  { key: 'sets', label: 'Sets', sortable: false, align: 'right' },
];

export default {
  title: 'Jugador ATP',
  async render(el, { api, params }) {
    const { data } = await api.tennisPlayer(params.id);
    const rows = data.matches.map((m) => perspective(m, data.player.id)).sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
    const state = { surface: '', stat: 'total_games', line: LINES.total_games[0] };
    el.innerHTML = h`<a class="gm-back" href="#/tennis-rankings">← Ranking ATP</a>
      ${headHtml(data)}
      <div class="toolbar" data-bar><span class="tn-muted">${sourceBadge('espn')} Elo: nivel del jugador según Oddsy, con sus partidos desde 2018</span></div>
      <section class="card tn-sec"><h2 data-title></h2><div data-hits></div></section>
      <section class="tn-sec"><h2>Últimos partidos</h2><div data-table></div></section>`;
    const table = sortableTable({ columns: COLUMNS, sortKey: 'date', sortDir: 'desc', pageSize: 25, caption: `Últimos partidos de ${data.player.name}`, emptyText: 'Sin partidos en esta superficie.' });
    el.querySelector('[data-table]').append(table);
    const draw = () => {
      const list = rows.filter((r) => !state.surface || r.surface === state.surface);
      el.querySelector('[data-title]').textContent = `Más de ${state.line} · ${statName(state.stat).toLowerCase()}`;
      el.querySelector('[data-hits]').innerHTML = hitsHtml(list, state.stat, state.line);
      table.setRows(list);
    };
    const lineDd = () => dropdown({ label: 'Línea', value: state.line, options: [...LINES[state.stat]].sort((x, y) => x - y).map((l) => ({ value: l, label: `Más de ${l}` })), onChange: (v) => { state.line = v; draw(); } });
    let lines = lineDd();
    el.querySelector('[data-bar]').prepend(
      dropdown({ label: 'Superficie', value: '', options: [{ value: '', label: 'Todas' }, ...Object.entries(SURF).map(([value, label]) => ({ value, label }))], onChange: (v) => { state.surface = v; draw(); } }),
      dropdown({ label: 'Estadística', value: state.stat, options: STATS.tennis.map((d) => ({ value: d.key, label: d.name })),
        onChange: (v) => { Object.assign(state, { stat: v, line: LINES[v][0] }); lines.replaceWith(lines = lineDd()); draw(); } }),
      lines,
    );
    draw();
  },
};
