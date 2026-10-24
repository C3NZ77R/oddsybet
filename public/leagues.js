// Ligas soportadas. Lo comparten el servidor (validación y rutas de ESPN) y el navegador.
// sport = deporte en las URL de ESPN y clave de STATS (public/stats.js); espn = liga en ESPN.
export const LEAGUES = [
  { id: 'nba', title: 'NBA', sport: 'basketball', espn: 'nba' },
  { id: 'nfl', title: 'NFL', sport: 'football', espn: 'nfl' },
  { id: 'mlb', title: 'MLB', sport: 'baseball', espn: 'mlb' },
  { id: 'wnba', title: 'WNBA', sport: 'basketball', espn: 'wnba' },
  { id: 'laliga', title: 'LaLiga', sport: 'soccer', espn: 'esp.1' },
  { id: 'epl', title: 'Premier League', sport: 'soccer', espn: 'eng.1' },
  { id: 'ucl', title: 'Champions', sport: 'soccer', espn: 'uefa.champions' },
  { id: 'libertadores', title: 'Libertadores', sport: 'soccer', espn: 'conmebol.libertadores' },
  { id: 'colombia', title: 'Liga BetPlay', sport: 'soccer', espn: 'col.1' },
  { id: 'atp', title: 'ATP', sport: 'tennis', espn: 'atp' },
];

export const leagueById = (id) => LEAGUES.find((l) => l.id === id) ?? null;
