// Jugadas de un partido (summary de ESPN) en una lista compacta con posición absoluta en la cancha, 0 a 100
// (x a lo largo, y a lo ancho; el local ataca hacia x = 100). Lo usa /api/plays y la vista Estadio en vivo.
// Todo lo que llega de ESPN es dato no confiable: solo se copian campos conocidos, como texto o número.
import { clockSecs } from '../public/live.js';

export const KIND_ES = {
  goal: 'Gol', 'pen-miss': 'Penal fallado', 'shot-on': 'Remate al arco', 'shot-off': 'Remate desviado', blocked: 'Remate bloqueado',
  post: 'Al palo', corner: 'Córner', foul: 'Falta', offside: 'Fuera de lugar', yellow: 'Amarilla', red: 'Roja', sub: 'Cambio',
  kickoff: 'Saque inicial', shot: 'Tiro', ft: 'Tiro libre', reb: 'Rebote', tov: 'Pérdida', timeout: 'Tiempo muerto',
};

// El primero que coincide gana (Own Goal antes que Goal).
const SOCCER_KINDS = [
  [/Own Goal/, 'goal'], [/^Goal|Penalty - Scored/, 'goal'], [/Penalty - (Saved|Missed)/, 'pen-miss'], [/Shot On Target/, 'shot-on'],
  [/Shot Off Target/, 'shot-off'], [/Shot Blocked/, 'blocked'], [/Woodwork/, 'post'], [/Corner/, 'corner'], [/Foul/, 'foul'],
  [/Offside/, 'offside'], [/Yellow/, 'yellow'], [/Red Card/, 'red'], [/Substitution/, 'sub'], [/Kickoff/, 'kickoff'],
];
const NBA_KINDS = [[/Rebound/, 'reb'], [/Turnover/, 'tov'], [/Foul/, 'foul'], [/Substitution/, 'sub'], [/Timeout/, 'timeout']];

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null || v === '' ? null : String(v));
const iso = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const inside = (v, max) => v != null && v >= 0 && v <= max;

// Siempre con las 20 claves, para que la vista no tenga que adivinar cuáles faltan.
const play = (o) => ({
  id: '', seq: 0, t: null, at: null, period: null, clock: null, kind: 'other', label: '', text: null, who: null, side: null,
  x: null, y: null, tx: null, ty: null, made: null, pts: 0, zone: null, score: null, wp: null, ...o,
});

// Lado de un equipo del play: por id (NBA) o por nombre (el commentary de fútbol solo trae displayName).
function sideFinder(json) {
  const teams = json?.header?.competitions?.[0]?.competitors ?? [];
  return (team) => {
    const c = teams.find((c) => (team?.id != null && String(c.id) === String(team.id)) || (team?.displayName != null && c.team?.displayName === team.displayName));
    return c?.homeAway === 'home' || c?.homeAway === 'away' ? c.homeAway : null;
  };
}

// Campos que comparten los dos deportes.
const common = (p, kind, typeText) => ({
  id: String(p.id),
  kind,
  label: KIND_ES[kind] ?? str(typeText)?.replace(/\s+/g, ' ').trim() ?? 'Jugada',
  text: str(p.text)?.slice(0, 200) ?? null,
  who: str(p.participants?.[0]?.athlete?.displayName),
  at: iso(p.wallclock),
  period: num(p.period?.number),
});

// ---------- fútbol ----------
// La posición viene en el marco del equipo que hace la jugada, atacando hacia x = 100: el visitante se espeja.
const flip = (frame, x, y) => {
  x = num(x);
  y = num(y);
  if (!frame || !inside(x, 100) || !inside(y, 100)) return [null, null];
  return frame === 'home' ? [x, y] : [100 - x, 100 - y];
};

function soccerPlays(json, sideOf) {
  return (Array.isArray(json.commentary) ? json.commentary : []).flatMap((c) => {
    const p = c?.play, seq = num(c?.sequence);
    if (!p || seq == null || p.id == null) return [];
    const typeText = String(p.type?.text ?? '');
    const kind = SOCCER_KINDS.find(([re]) => re.test(typeText))?.[1] ?? 'other';
    const frame = sideOf(p.team);
    const [x, y] = flip(frame, p.fieldPositionX, p.fieldPositionY);
    const [tx, ty] = flip(frame, p.fieldPosition2X, p.fieldPosition2Y);
    // Un autogol suma para el rival, pero ocurre en el arco de quien lo metió.
    const side = frame && /Own Goal/.test(typeText) ? (frame === 'home' ? 'away' : 'home') : frame;
    return [play({ ...common(p, kind, typeText), seq, t: num(p.clock?.value), clock: str(p.clock?.displayValue), side, x, y, tx, ty })];
  });
}

// ---------- básquet ----------
// shortcut: largos de la NBA (12 min y prórrogas de 5); WNBA o universitario necesitarían la liga.
const periodStart = (n) => (n <= 4 ? (n - 1) * 720 : 2880 + (n - 5) * 300);
const periodLen = (n) => (n <= 4 ? 720 : 300);

// ESPN marca "sin coordenadas" con -214748340: cualquier número razonable es real.
const real = (v) => v != null && Math.abs(v) < 1000;

function zoneOf(pts, x, y) {
  if (pts === 3) return y <= 14 ? 'corner3' : 'arc3';
  if (pts === 2) return Math.abs(x - 25) <= 8 && y <= 19 ? 'paint' : 'mid';
  return null;
}

function basketballPlays(json, sideOf) {
  const wp = new Map((Array.isArray(json.winprobability) ? json.winprobability : []).map((w) => [String(w?.playId), num(w?.homeWinPercentage)]));
  return (Array.isArray(json.plays) ? json.plays : []).flatMap((p) => {
    const seq = num(p?.sequenceNumber);
    if (seq == null || p.id == null) return [];
    const typeText = String(p.type?.text ?? '');
    const kind = p.shootingPlay ? (/Free Throw/.test(typeText) ? 'ft' : 'shot') : NBA_KINDS.find(([re]) => re.test(typeText))?.[1] ?? 'other';
    const side = sideOf(p.team);
    // Media cancha en pies: cx a lo ancho (0 a 50), cy desde la línea de fondo (0 a 47). El local ataca la canasta derecha.
    const cx = num(p.coordinate?.x), cy = num(p.coordinate?.y);
    const valid = side && inside(cx, 50) && inside(cy, 47);
    const [x, y] = !valid ? [null, null] : side === 'home' ? [100 - (cy * 100) / 94, cx * 2] : [(cy * 100) / 94, 100 - cx * 2];
    // La zona no exige posición válida: dos triples de esquina vienen con y = -3 (detrás de la línea de fondo).
    const zone = kind === 'shot' && real(cx) && real(cy) ? zoneOf(num(p.pointsAttempted), cx, cy) : null;
    const left = clockSecs(p.clock?.displayValue), n = num(p.period?.number);
    const awayScore = num(p.awayScore), homeScore = num(p.homeScore);
    return [play({
      ...common(p, kind, typeText), seq, clock: str(p.clock?.displayValue), side, x, y, zone,
      t: left == null || n == null || n < 1 ? null : periodStart(n) + periodLen(n) - left,
      made: p.scoringPlay == null ? null : !!p.scoringPlay,
      pts: num(p.scoreValue) ?? 0,
      score: awayScore == null || homeScore == null ? null : [awayScore, homeScore],
      wp: wp.get(String(p.id)) ?? null,
    })];
  });
}

// sport: 'soccer' | 'basketball'. Sin jugadas (partido sin empezar, deporte sin summary) devuelve [].
export function normPlays(json, sport) {
  if (!json || typeof json !== 'object') return [];
  const sideOf = sideFinder(json);
  const plays = sport === 'soccer' ? soccerPlays(json, sideOf) : sport === 'basketball' ? basketballPlays(json, sideOf) : [];
  return plays.sort((a, b) => a.seq - b.seq);
}
