// Mejores apuestas (#/<liga>/picks): por partido de hoy a +2 días, las selecciones más probables según el modelo, con la
// cuota mínima a la que vale la pena y cuánto se cumplió ese tipo de predicción en el backtest (/api/picks).
import { h, fmtPct, fmtOdds, when, empty, ymd } from '../ui.js';

// "Local o empate" → "Millonarios o empate"; el tenis ya trae los nombres de los jugadores.
const named = (text, g) => String(text).replace(/\bLocal\b/g, g.home?.name ?? 'Local').replace(/\bVisitante\b/g, g.away?.name ?? 'Visitante');
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const HCP = { spread: 'hándicap', rl: 'hándicap de carreras', games_hcp: 'hándicap de games' };
const pickText = (p, g) => named(HCP[p.market] ? `${p.name} ${signed(p.line)} (${HCP[p.market]})`
  : p.market === '1x2' || p.market === 'ml' ? (p.name === 'Empate' ? 'Empate' : `Gana ${p.name}`)
    : `${p.label}: ${p.name}`, g);
const recordText = (r) => (r ? h`${fmtPct(r.hit, 0)} <small>de ${r.n}</small>` : "—");

function gameCard(g, picks) {
  return h`<section class="card pk-game">
    <h2>${g.home?.name} vs ${g.away?.name}</h2>
    <p class="hint">${when(g.start)}</p>
    <table class="tbl"><caption class="sr-only">Mejores apuestas de ${g.home?.name} contra ${g.away?.name}</caption>
      <thead><tr><th scope="col">Apuesta</th><th scope="col">Probabilidad</th><th scope="col">Cuota mínima</th><th scope="col">Se cumplió</th></tr></thead>
      <tbody>${picks.map((p) => h`<tr><td>${pickText(p, g)}</td><td>${fmtPct(p.p, 0)}</td><td><b>${fmtOdds(p.minOdds)}</b></td><td>${recordText(p.record)}</td></tr>`)}</tbody>
    </table></section>`;
}

// Resumen de texto de las mejores apuestas del día para pegarlo en un grupo o chat de WhatsApp.
export function dayText(title, rows, max = 8) {
  const top = rows.flatMap(([g, ps]) => ps.map((p) => ({ g, p }))).sort((a, b) => b.p.p - a.p.p).slice(0, max);
  const lines = top.map(({ g, p }) => `• ${g.home?.name} vs ${g.away?.name}: ${pickText(p, g)} (${fmtPct(p.p, 0)}, cuota mínima ${fmtOdds(p.minOdds)})`);
  return `Picks de Oddsy Bet · ${title}\n${lines.join('\n')}\nCuotas del modelo propio, con precisión publicada.`;
}

export default {
  title: 'Mejores apuestas',
  async render(el, { api, leagueInfo: lg }) {
    const days = [0, 1, 2].map((i) => ymd(new Date(Date.now() + i * 864e5)));
    // Cada petición falla por separado: un error en el día +2 no tapa los picks de hoy.
    const failed = [];
    const safe = (p) => p.catch((err) => (failed.push(err), { data: [] }));
    const res = await Promise.all(days.map((d) => Promise.all([safe(api.games(lg.id, d)), safe(api.get('/api/picks', { league: lg.id, date: d }))])));
    if (failed.length === days.length * 2) throw failed[0];
    const games = new Map(res.flatMap(([gs]) => gs.data ?? []).map((g) => [g.id, g]));
    const acc = res.map(([, pk]) => pk.accuracy).find(Boolean); // la del primer día que respondió
    const rows = res.flatMap(([, pk]) => pk.data ?? []).map((x) => [games.get(x.gameId), x.picks])
      .filter(([g, ps]) => g?.status?.state === 'pre' && ps.length).sort(([a], [b]) => a.start.localeCompare(b.start));
    el.innerHTML = h`<header class="view-head"><div><h1>Mejores apuestas · ${lg.title}</h1>
      <p class="hint">Las apuestas más probables de cada partido según Oddsy, para hoy y los próximos dos días. Apuesta solo si tu casa paga <b>la cuota mínima o más</b>. Si paga menos, a la larga pierdes plata aunque aciertes seguido. «Se cumplió» dice cuántas veces acertó ese tipo de apuesta en la temporada pasada, en partidos que Oddsy no había visto antes.</p></div></header>
      ${acc?.publish === false ? empty('Todavía no mostramos apuestas en esta liga: Oddsy aún no predice mejor que usar los resultados de la temporada pasada.')
        : rows.length ? h`<p><button type="button" class="btn" data-wa>Compartir picks por WhatsApp</button></p>${rows.map(([g, ps]) => gameCard(g, ps))}` : empty('No hay partidos próximos con apuestas de 50% o más.')}`;
    el.querySelector?.('[data-wa]')?.addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(dayText(lg.title, rows))}`, '_blank', 'noopener'));
  },
};
