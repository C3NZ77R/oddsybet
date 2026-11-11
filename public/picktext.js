// Texto de un pick en palabras («Gana Nacional», «Total de goles 2.5: Más»): lo usan la vista de Mejores apuestas y el asistente.
// "Local o visitante" → "Millonarios o Nacional" (en minúscula o mayúscula); el tenis ya trae los nombres de los jugadores.
const named = (text, g) => String(text).replace(/\blocal\b/gi, g.home?.name ?? 'Local').replace(/\bvisitante\b/gi, g.away?.name ?? 'Visitante');
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const HCP = { spread: 'hándicap', games_hcp: 'hándicap de games' };
export const pickText = (p, g) => named(HCP[p.market] ? `${p.name} ${signed(p.line)} (${HCP[p.market]})`
  : p.market === '1x2' || p.market === 'ml' ? (p.name === 'Empate' ? 'Empate' : `Gana ${p.name}`)
    : `${p.label}: ${p.name}`, g);
