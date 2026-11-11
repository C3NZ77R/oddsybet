// Predicciones para el asistente (lib/chat.mjs): busca entre las Mejores apuestas (getPicks) de las ligas pedidas los
// partidos por jugar y devuelve cada pick en palabras con su probabilidad, cuota mínima, cuota justa y acierto. No guarda nada.
import { LEAGUES, leagueById } from '../public/leagues.js';
import { pickText } from '../public/picktext.js';
import { getPicks, getTennisGames } from './markets.mjs';
import { getGames } from './espn.mjs';
import { dayOf } from './picklog.mjs';

export const MAX_PICKS = 8; // tokens de la capa gratis de Gemini
const DAY = 86_400_000;

export const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const defaultGamesOf = (league, date) => (leagueById(league)?.sport === 'tennis' ? getTennisGames(league, date) : getGames(league, date));

export function filterPicks(rows, { minP = 0, team = '', market = '' } = {}) {
  const t = normName(team);
  return rows.filter((r) => r.p >= minP && (!t || normName(r.game).includes(t)) && (!market || r.market === market));
}

export async function findPicks({ league = '', day = 'hoy', minP = 0, team = '', market = '' } = {},
  { model = null, picksOf = getPicks, gamesOf = defaultGamesOf, now = Date.now() } = {}) {
  const at = now + (day === 'mañana' ? DAY : 0);
  const iso = dayOf(at), date = iso.replaceAll('-', '');
  const ids = league ? [league] : LEAGUES.map((l) => l.id);
  const byLeague = await Promise.allSettled(ids.map(async (id) => {
    const [{ data }, games] = await Promise.all([picksOf(id, { date, model }), gamesOf(id, date)]);
    const gameOf = new Map(games.map((g) => [g.id, g]));
    return data.flatMap(({ gameId, picks }) => {
      const g = gameOf.get(gameId);
      if (g?.status?.state !== 'pre') return [];
      return picks.map((p) => ({ league: id, leagueTitle: leagueById(id)?.title ?? id, game: `${g.home?.name} vs ${g.away?.name}`, start: g.start,
        pick: pickText(p, g), market: p.market, p: p.p, minOdds: p.minOdds, fair: p.fair, record: p.record ?? null, featured: Boolean(p.featured) }));
    });
  }));
  const leagues = ids.filter((_, i) => byLeague[i].status === 'fulfilled');
  const rows = byLeague.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const picks = filterPicks(rows, { minP: minP > 1 ? minP / 100 : minP, team, market }).sort((a, b) => b.p - a.p).slice(0, MAX_PICKS);
  return { day: iso, leagues, picks };
}
