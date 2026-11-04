// Mejores apuestas (#/<liga>/picks): por partido de hoy a +2 días, las selecciones más probables según el modelo, con la
// cuota mínima a la que vale la pena y cuánto se cumplió ese tipo de predicción en el backtest (/api/picks). Arriba, el
// registro de Oddsy (/api/record): cómo le fue a cada pick del partido (★), guardado antes de empezar y cerrado con ESPN.
import { h, fmtPct, fmtOdds, when, empty, ymd } from '../ui.js';

// "Local o empate" → "Millonarios o empate"; el tenis ya trae los nombres de los jugadores.
const named = (text, g) => String(text).replace(/\bLocal\b/g, g.home?.name ?? 'Local').replace(/\bVisitante\b/g, g.away?.name ?? 'Visitante');
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const HCP = { spread: 'hándicap', games_hcp: 'hándicap de games' };
const pickText = (p, g) => named(HCP[p.market] ? `${p.name} ${signed(p.line)} (${HCP[p.market]})`
  : p.market === '1x2' || p.market === 'ml' ? (p.name === 'Empate' ? 'Empate' : `Gana ${p.name}`)
    : `${p.label}: ${p.name}`, g);
const recordText = (r) => (r ? h`${fmtPct(r.hit, 0)} <small>de ${r.n}</small>` : "—");
const star = (p) => (p.featured ? h`<span class="pk-star" aria-label="Pick del partido">★</span> ` : '');

function gameCard(g, picks) {
  return h`<section class="card pk-game">
    <h2>${g.home?.name} vs ${g.away?.name}</h2>
    <p class="hint">${when(g.start)}</p>
    <table class="tbl"><caption class="sr-only">Mejores apuestas de ${g.home?.name} contra ${g.away?.name}</caption>
      <thead><tr><th scope="col">Apuesta</th><th scope="col">Probabilidad</th><th scope="col">Cuota mínima</th><th scope="col">Se cumplió</th></tr></thead>
      <tbody>${picks.map((p) => h`<tr><td>${star(p)}${pickText(p, g)}</td><td>${fmtPct(p.p, 0)}</td><td><b>${fmtOdds(p.minOdds)}</b></td><td>${recordText(p.record)}</td></tr>`)}</tbody>
    </table>${picks.some((p) => p.featured) ? h`<p class="hint">★ Pick del partido: es el que cuenta en el registro de Oddsy.</p>` : ''}</section>`;
}

// ---------- registro de Oddsy ----------
const MARKET_NAMES = { '1x2': 'Resultado', dc: 'Doble oportunidad', dnb: 'Empate no válido', ou: 'Totales', btts: 'Ambos marcan', ml: 'Ganador', spread: 'Hándicap',
  games_hcp: 'Hándicap de games', first_set: 'Primer set', ou_sets: 'Total de sets', ou_games: 'Total de games', ou_set1: 'Games del 1er set' };
const MARK = { ganada: ['✓', 'Ganada'], perdida: ['✗', 'Perdida'], nula: ['↺', 'Anulada'], pendiente: ['…', 'Pendiente'] };
const fmtDay = (d) => new Date(`${d}T12:00:00-05:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' }).replace('.', '');
const closedOf = (picks) => picks.filter((p) => p.status === 'ganada' || p.status === 'perdida');
const dayTitle = (day) => `${day.yesterday ? 'Ayer' : fmtDay(day.date)} · ${closedOf(day.picks).filter((p) => p.status === 'ganada').length} de ${closedOf(day.picks).length}`;
const totalLine = (label, w) => (w && w.won + w.lost ? h`<li>${label}: <b>${w.won} de ${w.won + w.lost}</b> (${fmtPct(w.hit, 0)}) · Oddsy prometía ${fmtPct(w.promised, 0)}</li>` : '');

function learnText(m) {
  if (!m) return '';
  const at = when(m.at);
  if (m.status === 'en_uso') return h`<p>Ajuste en uso desde ${at}: en las últimas 2 semanas, que guardó aparte para probarse, acertó mejor que el modelo solo (error ${m.llModel} contra ${m.llBase}; más bajo es mejor). Aprendió de ${m.n} picks cerrados.</p>`;
  if (m.status === 'sin_mejora') return h`<p>Último aprendizaje ${at}: lo aprendido no acertó mejor que el modelo solo en las últimas 2 semanas, así que Oddsy sigue con el modelo sin ajustes.</p>`;
  return h`<p>Todavía junta picks cerrados para aprender (lleva ${m.n ?? 0}).</p>`;
}

export function recordHtml(r) {
  if (!r) return '';
  const intro = h`<p class="hint">Cada pick del partido (★) se guarda antes de que empiece y se cierra solo con el resultado de ESPN. No se borra ninguno, tampoco los perdidos.</p>`;
  if (!r.since) return h`<section class="card pk-record"><h2>Registro de Oddsy</h2>${intro}<p>El registro empieza con el próximo partido que tenga pick.</p></section>`;
  const day = r.day;
  const g = (p) => ({ home: { name: p.home }, away: { name: p.away } });
  const list = day ? h`<ul class="pk-list">${day.picks.map((p) => {
    const [mark, label] = MARK[p.status] ?? MARK.pendiente;
    return h`<li class="pk-${p.status}"><span class="pk-mark" aria-hidden="true">${mark}</span> <span class="sr-only">${label}:</span> ${p.home} vs ${p.away} · ${pickText(p, g(p))} · ${fmtPct(p.p, 0)}${p.score ? ` · ${p.score}` : ''}${p.reason && p.status !== 'ganada' ? h` <small>${p.reason}</small>` : ''}</li>`;
  })}</ul>` : '';
  const totals = [totalLine('Últimos 7 días', r.windows?.[0]), totalLine('Últimos 30 días', r.windows?.[1]), totalLine('Todos los picks de la lista (30 días)', r.all)];
  const started = !day && totals.every((t) => !t) ? h`<p>El registro empezó el ${fmtDay(r.since)}. El primer resultado sale cuando termine el primer partido con pick.</p>` : '';
  return h`<section class="card pk-record"><h2>${day ? `Registro de Oddsy · ${dayTitle(day)}` : 'Registro de Oddsy'}</h2>${intro}${list}${started}
    <ul class="pk-totals">${totals}</ul>
    <details><summary>Cómo aprende Oddsy</summary>
      <p class="hint">Cada noche compara lo que prometió con lo que salió, por mercado y por liga, y ajusta sus probabilidades. Solo usa el ajuste si en las dos semanas más recientes, que no usó para aprender, habría acertado mejor.</p>
      ${r.markets?.length ? h`<table class="tbl"><caption class="sr-only">Prometido contra salido por mercado, últimos 30 días</caption>
        <thead><tr><th scope="col">Mercado</th><th scope="col">Picks</th><th scope="col">Prometía</th><th scope="col">Salió</th></tr></thead>
        <tbody>${r.markets.map((m) => h`<tr><td>${MARKET_NAMES[m.market] ?? m.market}</td><td>${m.n}</td><td>${fmtPct(m.promised, 0)}</td><td>${fmtPct(m.hit, 0)}</td></tr>`)}</tbody></table>` : ''}
      ${learnText(r.model)}
    </details></section>`;
}

// Resumen de texto de las mejores apuestas del día para pegarlo en un grupo o chat de WhatsApp: primero los picks del
// partido y, si hay registro, cómo le fue a Oddsy.
export function dayText(title, rows, max = 8, record = null) {
  const top = rows.flatMap(([g, ps]) => ps.map((p) => ({ g, p }))).sort((a, b) => Number(Boolean(b.p.featured)) - Number(Boolean(a.p.featured)) || b.p.p - a.p.p).slice(0, max);
  const lines = top.map(({ g, p }) => `• ${p.featured ? '★ ' : ''}${g.home?.name} vs ${g.away?.name}: ${pickText(p, g)} (${fmtPct(p.p, 0)}, cuota mínima ${fmtOdds(p.minOdds)})`);
  const month = record?.windows?.[1];
  const past = record?.day ? `${dayTitle(record.day).replace(' · ', ': ')}${month?.won + month?.lost ? ` · últimos 30 días: ${fmtPct(month.hit, 0)}` : ''}\n` : '';
  return `Picks de Oddsy Bet · ${title}\n${past}${lines.join('\n')}\nCuotas del modelo propio, con precisión publicada.`;
}

export default {
  title: 'Mejores apuestas',
  async render(el, { api, leagueInfo: lg }) {
    const days = [0, 1, 2].map((i) => ymd(new Date(Date.now() + i * 864e5)));
    // Cada petición falla por separado: un error en el día +2 no tapa los picks de hoy.
    const failed = [];
    const safe = (p) => p.catch((err) => (failed.push(err), { data: [] }));
    const pending = Promise.all(days.map((d) => Promise.all([safe(api.games(lg.id, d)), safe(api.get('/api/picks', { league: lg.id, date: d }))])));
    // El registro va aparte: si falla, los picks salen igual y la tarjeta no aparece.
    const [res, record] = await Promise.all([pending, api.get('/api/record', { league: lg.id }).then((r) => r?.data ?? null, () => null)]);
    if (failed.length === days.length * 2) throw failed[0];
    const games = new Map(res.flatMap(([gs]) => gs.data ?? []).map((g) => [g.id, g]));
    const acc = res.map(([, pk]) => pk.accuracy).find(Boolean); // la del primer día que respondió
    // Llegan también los picks que lo aprendido dejó bajo el 50 % (el registro los guarda); aquí no se muestran.
    const rows = res.flatMap(([, pk]) => pk.data ?? []).map((x) => [games.get(x.gameId), x.picks.filter((p) => p.p >= 0.5)])
      .filter(([g, ps]) => g?.status?.state === 'pre' && ps.length).sort(([a], [b]) => a.start.localeCompare(b.start));
    el.innerHTML = h`${recordHtml(record)}<header class="view-head"><div><h1>Mejores apuestas · ${lg.title}</h1>
      <p class="hint">Las apuestas más probables de cada partido según Oddsy, para hoy y los próximos dos días. Apuesta solo si tu casa paga <b>la cuota mínima o más</b>. Si paga menos, a la larga pierdes plata aunque aciertes seguido. «Se cumplió» dice cuántas veces acertó ese tipo de apuesta en la temporada pasada, en partidos que Oddsy no había visto antes.</p></div></header>
      ${acc?.publish === false ? empty('Todavía no mostramos apuestas en esta liga: Oddsy aún no predice mejor que usar los resultados de la temporada pasada.')
        : rows.length ? h`<p><button type="button" class="btn" data-wa>Compartir picks por WhatsApp</button></p>${rows.map(([g, ps]) => gameCard(g, ps))}` : empty('No hay partidos próximos con apuestas de 50% o más.')}`;
    el.querySelector?.('[data-wa]')?.addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(dayText(lg.title, rows, 8, record))}`, '_blank', 'noopener'));
  },
};
