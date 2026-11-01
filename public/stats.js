// Estadísticas de jugador por deporte. Lo comparten el servidor (lib/espn.mjs normaliza los game logs de ESPN a estas
// claves cortas y lib/props.mjs les pone línea propia a las que tienen `market`) y el navegador (pestañas, insights, props).
// Cada definición: { key, label (corto, como en las pestañas), name (español), market? (id del prop), markets? (otros
// mercados equivalentes, p. ej. Sí/No de anotar), from? (estadística derivada a partir de las claves crudas), binary? (0/1 por partido: solo la línea 0.5) }.

// Suma tolerante: null si falta la primera clave (la que define el tipo de jugador); las demás, si faltan, cuentan como 0.
const sum = (...keys) => (s) => (Number.isFinite(s[keys[0]]) ? keys.reduce((t, k) => t + (Number.isFinite(s[k]) ? s[k] : 0), 0) : null);
const tens = (s) => ['pts', 'reb', 'ast', 'stl', 'blk'].filter((k) => s[k] >= 10).length;
const has = (s, ...keys) => keys.every((k) => Number.isFinite(s[k]));
export const doubleDouble = (s) => (has(s, 'pts', 'reb', 'ast') ? (tens(s) >= 2 ? 1 : 0) : null);
export const tripleDouble = (s) => (has(s, 'pts', 'reb', 'ast') ? (tens(s) >= 3 ? 1 : 0) : null);

export const STATS = {
  basketball: [
    { key: 'pts', label: 'PTS', name: 'Puntos', market: 'player_points' },
    { key: 'reb', label: 'REB', name: 'Rebotes', market: 'player_rebounds' },
    { key: 'ast', label: 'AST', name: 'Asistencias', market: 'player_assists' },
    { key: '3pm', label: '3PTM', name: 'Triples anotados', market: 'player_threes' },
    { key: 'pra', label: 'PTS+REB+AST', name: 'Puntos + rebotes + asistencias', market: 'player_points_rebounds_assists', from: sum('pts', 'reb', 'ast') },
    { key: 'pr', label: 'PTS+REB', name: 'Puntos + rebotes', market: 'player_points_rebounds', from: sum('pts', 'reb') },
    { key: 'pa', label: 'PTS+AST', name: 'Puntos + asistencias', market: 'player_points_assists', from: sum('pts', 'ast') },
    { key: 'ra', label: 'REB+AST', name: 'Rebotes + asistencias', market: 'player_rebounds_assists', from: sum('reb', 'ast') },
    { key: 'stl', label: 'STL', name: 'Robos', market: 'player_steals' },
    { key: 'blk', label: 'BLK', name: 'Tapones', market: 'player_blocks' },
    { key: 'sb', label: 'STL+BLK', name: 'Robos + tapones', market: 'player_blocks_steals', from: sum('stl', 'blk') },
    { key: 'to', label: 'TO', name: 'Pérdidas', market: 'player_turnovers' },
    { key: 'fgm', label: 'FGM', name: 'Tiros de campo anotados', market: 'player_field_goals' },
    { key: 'fga', label: 'FGA', name: 'Tiros de campo intentados' },
    { key: '3pa', label: '3PTA', name: 'Triples intentados' },
    { key: 'ftm', label: 'FTM', name: 'Tiros libres anotados', market: 'player_frees_made' },
    { key: 'fta', label: 'FTA', name: 'Tiros libres intentados', market: 'player_frees_attempts' },
    { key: 'dd', label: 'DD2', name: 'Doble-doble', market: 'player_double_double', from: doubleDouble, binary: true },
    { key: 'td', label: 'TD3', name: 'Triple-doble', market: 'player_triple_double', from: tripleDouble, binary: true },
  ],
  soccer: [
    { key: 'goals', label: 'G', name: 'Goles', market: 'player_goal_scorer_anytime' },
    { key: 'assists', label: 'A', name: 'Asistencias', market: 'player_assists' },
    { key: 'shots', label: 'TIROS', name: 'Tiros', market: 'player_shots' },
    { key: 'sot', label: 'TAP', name: 'Tiros a puerta', market: 'player_shots_on_target' },
    { key: 'fc', label: 'FC', name: 'Faltas cometidas' },
    { key: 'fs', label: 'FR', name: 'Faltas recibidas' },
    { key: 'yc', label: 'TA', name: 'Tarjetas amarillas', market: 'player_to_receive_card' },
  ],
  // Por partido, desde el marcador en sets (sin props de mercado: el tenis se cotiza con matchDist).
  tennis: [
    { key: 'games_won', label: 'GAMES G', name: 'Games ganados' },
    { key: 'sets_won', label: 'SETS', name: 'Sets ganados' },
    { key: 'total_games', label: 'GAMES', name: 'Games totales' },
  ],
};

const defOf = (sport, key) => STATS[sport]?.find((d) => d.key === key) ?? null;

// Valor de una estadística (cruda o derivada) en un partido; null si no se puede calcular.
export function statOf(sport, key, gameStats) {
  if (!gameStats) return null;
  const d = defOf(sport, key);
  const v = d?.from ? d.from(gameStats) : gameStats[key];
  return Number.isFinite(v) ? v : null;
}

// Definición para un id de mercado de prop (acepta también las variantes `_alternate`).
export function statForMarket(sport, market) {
  const m = String(market || '').replace(/_alternate$/, '');
  return STATS[sport]?.find((d) => d.market === m || d.markets?.includes(m)) ?? null;
}
