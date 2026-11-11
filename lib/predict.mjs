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

// Veredicto fijo en código: Gemini lo copia en vez de calcularlo (en pruebas llamó «segura» a un 74 %).
export const verdictOf = (p) => (p >= 0.8 ? 'segura' : p >= 0.6 ? 'posible' : 'arriesgada');
const fmtOdds = (x) => x.toFixed(2), fmtPct = (p) => `${Math.round(p * 100)} %`;
// El usuario pide «80 % a cuota 1.70»: a ese porcentaje la justa ronda 1.25, así que se avisa con el pick más probable.
export function oddsNote(picks, odds) {
  const top = picks[0];
  if (!top || !(odds > 1) || picks.some((p) => p.fair >= odds)) return '';
  return `Ningún pick llega a la cuota ${fmtOdds(odds)} con su probabilidad: a ${fmtPct(top.p)} la cuota justa ronda ${fmtOdds(top.fair)}. Una casa rara vez paga más que la justa.`;
}

export function filterPicks(rows, { minP = 0, team = '', market = '' } = {}) {
  const t = normName(team);
  return rows.filter((r) => r.p >= minP && (!t || normName(r.game).includes(t)) && (!market || r.market === market));
}

export async function findPicks({ league = '', sport = '', day = 'hoy', minP = 0, team = '', market = '', odds = 0 } = {},
  { model = null, picksOf = getPicks, gamesOf = defaultGamesOf, now = Date.now() } = {}) {
  const at = now + (day === 'mañana' ? DAY : 0);
  const iso = dayOf(at), date = iso.replaceAll('-', '');
  const ids = league ? [league] : LEAGUES.filter((l) => !sport || l.sport === sport).map((l) => l.id);
  const byLeague = await Promise.allSettled(ids.map(async (id) => {
    const [{ data }, games] = await Promise.all([picksOf(id, { date, model }), gamesOf(id, date)]);
    const gameOf = new Map(games.map((g) => [g.id, g]));
    return data.flatMap(({ gameId, picks }) => {
      const g = gameOf.get(gameId);
      if (g?.status?.state !== 'pre') return [];
      // Un pick por partido, el más probable del mercado pedido (o de todos): variedad y menos tokens.
      const top = picks.filter((p) => !market || p.market === market).sort((a, b) => b.p - a.p)[0];
      return top ? [{ league: id, leagueTitle: leagueById(id)?.title ?? id, game: `${g.home?.name} vs ${g.away?.name}`, start: g.start, pick: pickText(top, g),
        market: top.market, p: top.p, verdict: verdictOf(top.p), minOdds: top.minOdds, fair: top.fair, record: top.record ?? null, featured: Boolean(top.featured) }] : [];
    });
  }));
  const leagues = ids.filter((_, i) => byLeague[i].status === 'fulfilled');
  const rows = byLeague.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const picks = filterPicks(rows, { minP: minP > 1 ? minP / 100 : minP, team, market }).sort((a, b) => b.p - a.p).slice(0, MAX_PICKS);
  return { day: iso, leagues, picks, note: oddsNote(picks, Number(odds)) };
}
