// Bajas en el margen de la NBA: un jugador de rotación (≥ 20 min de media en sus últimos 10, con al menos 5) que no juega
// resta su Game Score medio (últimos 20) × beta al margen de su equipo. Solo cuenta si su último partido está entre los
// últimos 20 de su equipo: una baja de toda la temporada ya está en los ratings. scripts/absences-backtest.mjs, NBA 2025-26
// con las bajas reales de cada partido: Brier de la mitad de prueba 0.1948 → 0.1814 (beta ajustado en la primera mitad).
// En producción las bajas son las Out del reporte de lesiones de ESPN.
import { getGamelog, getInjuries, getSeasonResults, mapLimit } from './espn.mjs';

export const ABSENCE = { nba: { beta: 0.094, teamGames: 20, minMinutes: 20, minGames: 5 } };

// Game Score de Hollinger sin rebotes ofensivos ni faltas (el game log de ESPN no los separa).
export const gameScore = (s) => s.pts + 0.4 * (s.fgm ?? 0) - 0.7 * (s.fga ?? 0) + 0.7 * (s.reb ?? 0) + 0.7 * (s.ast ?? 0)
  + (s.stl ?? 0) + 0.7 * (s.blk ?? 0) - (s.to ?? 0);

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// Valor de la baja (0 si no cuenta). played: partidos jugados antes de la fecha, del más reciente al más viejo.
// teamDates: fechas ISO de los partidos de su equipo antes de la fecha, del más reciente al más viejo.
export function absentValue(played, teamDates, cfg) {
  const last10 = played.slice(0, 10);
  if (last10.length < cfg.minGames || avg(last10.map((g) => g.minutes ?? 0)) < cfg.minMinutes) return 0;
  const since = teamDates.length >= cfg.teamGames ? teamDates[cfg.teamGames - 1] : '';
  if (played[0].date < since) return 0;
  return avg(played.slice(0, 20).map((g) => gameScore(g.stats)));
}

// Ajuste al mu (margen local) de cada partido por venir: { [gameId]: delta }. Un fallo de ESPN deja el partido sin ajuste.
export async function absenceDeltas(league, games) {
  const cfg = ABSENCE[league];
  const pre = games.filter((g) => g.status?.state === 'pre' && g.home?.id && g.away?.id);
  if (!cfg || !pre.length) return {};
  const teams = new Set(pre.flatMap((g) => [String(g.home.id), String(g.away.id)]));
  const [injuries, results] = await Promise.all([getInjuries(league), getSeasonResults(league)]);
  const out = injuries.filter((i) => i.status === 'Out' && teams.has(String(i.teamId)) && i.athlete?.id);
  const values = await mapLimit(out, 4, async (i) => {
    const log = await getGamelog(league, i.athlete.id, null, { athlete: i.athlete }).catch(() => null);
    const played = (log?.games ?? []).filter((g) => g.minutes > 0);
    if (!played.length) return 0;
    const dates = results.filter((r) => r.homeId === String(i.teamId) || r.awayId === String(i.teamId)).map((r) => r.date).sort().reverse();
    return absentValue(played, dates, cfg);
  });
  const missing = {};
  out.forEach((i, k) => { missing[String(i.teamId)] = (missing[String(i.teamId)] ?? 0) + values[k]; });
  return Object.fromEntries(pre.map((g) => [g.id, cfg.beta * ((missing[String(g.away.id)] ?? 0) - (missing[String(g.home.id)] ?? 0))]));
}
