// Ranking ATP (#/tennis-rankings): top 150 de ESPN con puntos, tendencia semanal y Elo de Oddsy. Cada fila abre la ficha.
import { h, sortableTable, teamLogo, sourceBadge } from '../ui.js';

const trend = (r) => (r.prev == null || r.rank == null ? null : r.prev - r.rank); // > 0: subió
const trendHtml = (d) => (d == null ? '—' : d === 0 ? h`<span class="tn-muted" aria-label="Sin cambios">=</span>`
  : h`<span class="${d > 0 ? 'tn-w' : 'tn-l'}" aria-label="${d > 0 ? 'Subió' : 'Bajó'} ${Math.abs(d)}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`);

const COLUMNS = [
  { key: 'rank', label: '#', align: 'right', defaultDir: 'asc' },
  { key: 'player', label: 'Jugador', sort: (r) => r.player.name, defaultDir: 'asc',
    render: (r) => h`<a class="tn-player" href="#/tennis-player/${encodeURIComponent(r.player.id)}">${teamLogo({ logo: r.player.flag, name: r.player.name }, { size: 20 })}${r.player.name}</a>` },
  { key: 'points', label: 'Puntos', align: 'right', render: (r) => r.points?.toLocaleString('es-CO') },
  { key: 'trend', label: 'Cambio semanal', align: 'right', sort: trend, render: (r) => trendHtml(trend(r)) },
  { key: 'elo', label: 'Elo', align: 'right', render: (r) => (r.elo == null ? null : Math.round(r.elo)) },
];

export default {
  title: 'Ranking ATP',
  async render(el, { api, navigate }) {
    const { data } = await api.tennisRankings();
    el.innerHTML = h`<header class="view-head"><div><h1>Ranking ATP</h1>
      <p class="hint">Los 150 mejores en individuales. El Elo mide el nivel de cada jugador con sus partidos desde 2018. Toca un jugador para ver su ficha.</p></div>${sourceBadge('espn')}</header>
      <p><a class="gm-more" href="#/atp/games">Partidos ATP →</a></p>`;
    el.append(sortableTable({ columns: COLUMNS, rows: data, sortKey: 'rank', sortDir: 'asc', caption: 'Ranking ATP', onRowClick: (r) => navigate(`#/tennis-player/${encodeURIComponent(r.player.id)}`) }));
  },
};
