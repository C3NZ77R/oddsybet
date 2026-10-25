// Fuerza de equipos a partir de resultados: ataque (gf) y defensa (ga) por partido ajustados por rival y por
// localía, con shrink a la media de liga. Deportes 'normal': modelo aditivo, E[pf] = gf + ga_rival − m ± HFA/2.
// Deportes 'poisson': multiplicativo, E[pf] = media_sede · (gf/m) · (ga_rival/m). m = media por equipo y partido.
export const SPORT_MODEL = { soccer: 'poisson', baseball: 'poisson', basketball: 'normal', football: 'normal' };
// Modelo normal, calibrado en la primera mitad de la última temporada con scripts/backtest.mjs (football: σ fijo de la
// literatura). MU_SHRINK: regresión a la media de mu, que sin ella sale sobreconfiado; SIGMA_T: desvío de los totales.
export const SIGMA = { football: 13.5, basketball: 12.5 };
export const MU_SHRINK = { football: 0.8, basketball: 0.81 };
// Por liga antes que por deporte: la WNBA anota menos (16.4 = fitNormal sobre la WNBA 2025 completa en .cache/espn).
export const SIGMA_T = { football: 13.2, basketball: 19.2, wnba: 16.4 };

// Poisson: regresión de las λ de cada partido hacia su media (MLB: la fuerza de los equipos predice poco y sin ella el
// modelo sale sobreconfiado). scripts/backtest.mjs mlb 2025: Brier de prueba 0.2534 → 0.2472 con 0.4 (grilla 0.2–1.2 en
// la mitad de calibración); en el fútbol la mejor de la grilla queda en 1 o empeora la prueba.
export const LAMBDA_SHRINK = { baseball: 0.4 };

// Medias de respaldo [local, visita] cuando la liga aún no tiene partidos (ni de la temporada anterior).
const DEFAULT_AVG = { soccer: [1.5, 1.2], baseball: [4.6, 4.4], basketball: [114, 111], football: [24, 21] };
// Vida media en días del peso de un partido (0.5^(antigüedad/vida media)); sin valor, todos pesan igual.
export const HALF_LIFE = { soccer: 365 };
// Prior de un equipo nuevo (menos de la mitad de los partidos medianos: recién ascendido, o sin partidos), en
// múltiplos de la media de liga. col.1 2024–2026: los ascendidos hacen 0.74× y reciben 1.09× en sus primeros 10.
export const NEWCOMER = { soccer: { gf: 0.8, ga: 1.1 } }; // backtest col.1: Brier 2025 0.6090 → 0.6085, 2026 0.6168 → 0.6162 // col.1: mejor Brier que sin peso en 2025 (0.6090 vs 0.6097) y 2026 (0.6168 vs 0.6179)
const DAY = 86_400_000;
const TOL = 1e-9;
const MAX_ITERS = 500;

const modelOf = (sport) => {
  const m = SPORT_MODEL[sport];
  if (!m) throw new TypeError(`Deporte sin modelo: ${sport}`);
  return m;
};
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

export function ratingsFromResults(results, { sport, asOf = Infinity, prior = 5, halfLife = HALF_LIFE[sport] ?? Infinity, newcomer = NEWCOMER[sport] } = {}) {
  const mult = modelOf(sport) === 'poisson';
  const cut = typeof asOf === 'string' ? Date.parse(asOf) : Number(asOf);
  if (Number.isNaN(cut)) throw new TypeError('asOf inválido');
  const kept = results.filter((r) => Date.parse(r.date) < cut);
  // Peso por antigüedad contra el corte (sin corte, contra el último partido); la prior sigue en partidos enteros.
  const ref = Number.isFinite(cut) ? cut : kept.reduce((m, r) => Math.max(m, Date.parse(r.date)), 0);
  const rs = kept.map((r) => ({ ...r, w: 0.5 ** ((ref - Date.parse(r.date)) / (halfLife * DAY)) }));
  // La ventaja local sale solo de partidos con sede; los neutrales cuentan para la fuerza de cada equipo.
  const venue = rs.filter((r) => !r.neutral);
  const all = sum(rs, (r) => r.w * (r.homeScore + r.awayScore)) / (2 * sum(rs, (r) => r.w) || 1);
  const avgHome = venue.length ? sum(venue, (r) => r.w * r.homeScore) / sum(venue, (r) => r.w) : all;
  const avgAway = venue.length ? sum(venue, (r) => r.w * r.awayScore) / sum(venue, (r) => r.w) : all;
  const avg = (avgHome + avgAway) / 2;
  const teams = new Map();
  if (!(avg > 0)) return { teams, avgHome, avgAway };

  // Cada partido visto desde cada equipo: rival, a favor, en contra y efecto de sede propio (v) y del rival (vo).
  const [vH, vA, v0] = mult ? [avgHome / avg, avgAway / avg, 1] : [avgHome - avg, avgAway - avg, 0];
  const sides = new Map();
  const add = (id, g) => (sides.get(id) ?? sides.set(id, []).get(id)).push(g);
  for (const r of rs) {
    const [vh, va] = r.neutral ? [v0, v0] : [vH, vA];
    add(r.homeId, { opp: r.awayId, pf: r.homeScore, pa: r.awayScore, v: vh, vo: va, w: r.w });
    add(r.awayId, { opp: r.homeId, pf: r.awayScore, pa: r.homeScore, v: va, vo: vh, w: r.w });
  }

  // Punto fijo: cada rating es la media (con prior partidos en la media de liga) de lo que el equipo habría hecho
  // contra un rival medio en campo neutral. Jacobi amortiguado: sin amortiguar, el nivel total oscila.
  const gps = [...sides.values()].map((gs) => gs.length).sort((x, y) => x - y);
  const half = (gps[Math.floor(gps.length / 2)] ?? 0) / 2;
  const center = new Map([...sides].map(([id, gs]) => [id, newcomer && gs.length < half ? newcomer : { gf: 1, ga: 1 }]));
  let t = new Map([...sides.keys()].map((id) => [id, { gf: avg, ga: avg }]));
  for (let k = 0, delta = Infinity; k < MAX_ITERS && delta > TOL; k++) {
    const next = new Map();
    delta = 0;
    for (const [id, gs] of sides) {
      const opp = (g) => t.get(g.opp);
      const c = center.get(id);
      const [f, a] = mult
        ? [(sum(gs, (g) => g.w * g.pf) + prior * avg * c.gf) / (sum(gs, (g) => (g.w * g.v * opp(g).ga) / avg) + prior),
          (sum(gs, (g) => g.w * g.pa) + prior * avg * c.ga) / (sum(gs, (g) => (g.w * g.vo * opp(g).gf) / avg) + prior)]
        : [(sum(gs, (g) => g.w * (g.pf - opp(g).ga + avg - g.v)) + prior * avg * c.gf) / (sum(gs, (g) => g.w) + prior),
          (sum(gs, (g) => g.w * (g.pa - opp(g).gf + avg - g.vo)) + prior * avg * c.ga) / (sum(gs, (g) => g.w) + prior)];
      const o = t.get(id);
      const n = { gf: (o.gf + f) / 2, ga: (o.ga + a) / 2 };
      delta = Math.max(delta, Math.abs(n.gf - o.gf), Math.abs(n.ga - o.ga));
      next.set(id, n);
    }
    t = next;
  }
  for (const [id, gs] of sides) teams.set(id, { ...t.get(id), gp: gs.length });
  return { teams, avgHome, avgAway };
}

// Espera de goles (poisson) o de margen y total (normal). Equipo desconocido = media de liga.
// neutral: sin ventaja local (ambos lados con la media de liga). league: para el σ_T propio de la liga.
export function expected(sport, ratings, homeId, awayId, { neutral = false, league } = {}) {
  const model = modelOf(sport);
  const d = DEFAULT_AVG[sport];
  const ok = ratings.avgHome > 0 && ratings.avgAway > 0;
  const avg = ok ? (ratings.avgHome + ratings.avgAway) / 2 : (d[0] + d[1]) / 2;
  const [avgHome, avgAway] = neutral ? [avg, avg] : ok ? [ratings.avgHome, ratings.avgAway] : d;
  const nc = NEWCOMER[sport] ?? { gf: 1, ga: 1 }; // equipo sin partidos: recién llegado a la liga
  const T = (id) => ratings.teams.get(id) ?? { gf: avg * nc.gf, ga: avg * nc.ga, gp: 0 };
  const [h, a] = [T(homeId), T(awayId)];
  if (model === 'normal') {
    return {
      kind: 'normal',
      mu: MU_SHRINK[sport] * (h.gf - h.ga - (a.gf - a.ga) + (avgHome - avgAway)),
      sigma: SIGMA[sport],
      total: h.gf + a.ga + a.gf + h.ga - 2 * avg,
      sigmaT: SIGMA_T[league] ?? SIGMA_T[sport],
    };
  }
  const [lh, la] = [avgHome * (h.gf / avg) * (a.ga / avg), avgAway * (a.gf / avg) * (h.ga / avg)];
  const s = LAMBDA_SHRINK[sport] ?? 1, m = (lh + la) / 2;
  return { kind: 'poisson', lh: m + s * (lh - m), la: m + s * (la - m) };
}
