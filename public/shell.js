// Lógica del shell sin DOM (boleto, enlace compartido, toast), aparte de app.js para probarla con node --test.
import { parlayOdds } from './betmath.js';

export const RG_LINE = '+18. Oddsy no recibe apuestas; juega con responsabilidad.';

// Picks de un enlace: el texto y la cuota los puso quien lo compartió, así que van marcados y aparte.
export function importPicks(current, incoming, max = 50) {
  const have = new Set(current.map((p) => p.id));
  return incoming.filter((p) => !have.has(p.id)).slice(0, Math.max(0, max - have.size))
    .map((p) => ({ ...p, shared: true, addedAt: Date.now() }));
}

// Mercado de un pick según su id. Partidos: 'oddsy:liga:partido:mercado:etiqueta:lado'. Props: propKey (JSON).
function marketOf(id) {
  if (id.startsWith('oddsy:')) {
    if (id.split(':')[3] === 'dc') return null; // doble oportunidad: sus lados se pisan, pueden ganar juntos
    const cut = id.lastIndexOf(':');
    return { m: id.slice(0, cut), side: id.slice(cut + 1) };
  }
  try {
    const k = JSON.parse(decodeURIComponent(id));
    if (k && (k.o === 'Over' || k.o === 'Under') && Number.isFinite(k.l)) return { m: JSON.stringify(['prop', k.a ?? k.p, k.s, k.g]), side: k.o, line: k.l };
  } catch { /* otro formato de id: no se compara */ }
  return null;
}

// Pares de picks que no pueden ganar juntos: lados distintos del mismo mercado, o Más de X con Menos de Y si X ≥ Y.
export function exclusivePairs(picks) {
  const ms = picks.map((p) => marketOf(String(p.id)));
  const out = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = ms[i], b = ms[j];
      if (!a || !b || a.m !== b.m || a.side === b.side) continue;
      if (a.line != null && (a.side === 'Over' ? a.line < b.line : b.line < a.line)) continue; // Más de 20.5 y Menos de 25.5 sí pueden
      out.push([picks[i], picks[j]]);
    }
  }
  return out;
}

export const combinedOdds = (list) => {
  const prices = list.map((p) => p.price).filter((x) => x > 1);
  return prices.length ? parlayOdds(prices) : null;
};

// Lo que muestra el boleto. Los compartidos no entran en la cuota combinada, y si hay picks que se excluyen no hay combinada.
export function slipModel(picks) {
  const shared = picks.filter((p) => p.shared), own = picks.filter((p) => !p.shared);
  const conflicts = exclusivePairs(own);
  return { own, shared, conflicts, total: conflicts.length ? null : combinedOdds(own) };
}

// Texto para WhatsApp del boleto.
export function slipText(picks, url, fmt) {
  const lines = picks.slice(0, 10).map((p) => `• ${p.label} @ ${fmt(p.price)}`);
  return `Mis picks en Oddsy Bet (cuotas del modelo):\n${lines.join('\n')}\n${url}\n${RG_LINE}`;
}

// Mínimo 7 s y más para textos largos (~60 ms por carácter).
export const toastMs = (msg) => Math.max(7000, 60 * String(msg).length);

// ¿La vista tiene algo escrito o elegido por el usuario? Texto no vacío, una casilla marcada o una lista fuera de su primera opción.
export function hasUserInput(root) {
  for (const x of root?.querySelectorAll?.('input, textarea, select') ?? []) {
    const type = (x.type || '').toLowerCase();
    if (x.disabled || ['radio', 'file', 'hidden', 'button', 'submit'].includes(type)) continue;
    if (type === 'checkbox' ? x.checked : x.tagName === 'SELECT' ? x.selectedIndex > 0 : String(x.value ?? '').trim() !== '') return true;
  }
  return false;
}
