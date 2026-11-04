// Jugadas de un partido (summary de ESPN) en una lista compacta con posición absoluta en la cancha, 0 a 100
// (x a lo largo, y a lo ancho; el local ataca hacia x = 100). Lo usa /api/plays y la vista Estadio en vivo.
// Todo lo que llega de ESPN es dato no confiable: solo se copian campos conocidos, como texto o número.
import { clockSecs } from '../public/live.js';

export const KIND_ES = {
  goal: 'Gol', 'pen-miss': 'Penal fallado', 'shot-on': 'Remate al arco', 'shot-off': 'Remate desviado', blocked: 'Remate bloqueado',
  post: 'Al palo', corner: 'Córner', foul: 'Falta', 'free-kick': 'Tiro libre', offside: 'Fuera de lugar', yellow: 'Amarilla', red: 'Roja', sub: 'Cambio',
  kickoff: 'Saque inicial', shot: 'Tiro', ft: 'Tiro libre', reb: 'Rebote', tov: 'Pérdida', timeout: 'Tiempo muerto',
};

// El primero que coincide gana (Own Goal antes que Goal).
const SOCCER_KINDS = [
  [/Own Goal/, 'goal'], [/^Goal(?: -|$)|Penalty - Scored/, 'goal'], [/Penalty - (Saved|Missed)/, 'pen-miss'], [/Shot On Target/, 'shot-on'],
  [/Shot Off Target/, 'shot-off'], [/Shot Blocked/, 'blocked'], [/Woodwork/, 'post'], [/Corner/, 'corner'], [/Foul/, 'foul'],
  [/Offside/, 'offside'], [/Yellow/, 'yellow'], [/Red Card/, 'red'], [/Substitution/, 'sub'], [/Kickoff/, 'kickoff'],
];
const NBA_KINDS = [[/Rebound/, 'reb'], [/Turnover/, 'tov'], [/Foul/, 'foul'], [/Substitution/, 'sub'], [/Timeout/, 'timeout']];

// Tipos de ESPN sin kind propio, en español: todo texto visible va en español. Lo que no esté aquí se llama "Jugada"
// y el texto original en inglés queda en `text`.
const OTHER_ES = [
  [/^Halftime/, 'Descanso'], [/^Start 2nd Half/, 'Segundo tiempo'], [/^End Regular Time/, 'Fin del tiempo reglamentario'],
  [/^Start Delay/, 'Pausa'], [/^End Delay/, 'Se reanuda'], [/^VAR/, 'Revisión del VAR'],
  [/^End Period/, 'Fin del periodo'], [/^End Game/, 'Final del partido'], [/^Jumpball/, 'Salto entre dos'],
  [/Challenge/, 'Revisión (challenge)'], [/Violation|Lane/, 'Violación'], [/Ejection/, 'Expulsión'],
];

const arr = (v) => (Array.isArray(v) ? v : []);
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
const between = (v, lo, hi) => v != null && v >= lo && v <= hi;
const r1 = (v) => Math.round(v * 10) / 10; // un decimal: la cancha no pide más y el JSON pesa menos

// Siempre con las 20 claves, para que la vista no tenga que adivinar cuáles faltan.
const play = (o) => ({
  id: '', seq: 0, t: null, at: null, period: null, clock: null, kind: 'other', label: '', text: null, who: null, side: null,
  x: null, y: null, tx: null, ty: null, made: null, pts: 0, zone: null, score: null, wp: null, ...o,
});

// Lado de un equipo del play: por id (NBA) o por nombre (el commentary de fútbol solo trae displayName).
function sideFinder(json) {
  const teams = arr(json?.header?.competitions?.[0]?.competitors);
  return (team) => {
    const c = teams.find((c) => (team?.id != null && String(c.id) === String(team.id)) || (team?.displayName != null && c.team?.displayName === team.displayName));
    return c?.homeAway === 'home' || c?.homeAway === 'away' ? c.homeAway : null;
  };
}

// Campos que comparten los dos deportes. `names` (id → nombre) completa el jugador cuando el play solo trae su id.
const common = (p, kind, typeText, names = new Map()) => {
  // En el tiro libre ESPN lista primero al que cometió la falta: el protagonista es el segundo, el que la recibió.
  const a = p.participants?.[kind === 'free-kick' ? 1 : 0]?.athlete ?? p.participants?.[0]?.athlete;
  return {
    id: String(p.id),
    kind,
    label: KIND_ES[kind] ?? OTHER_ES.find(([re]) => re.test(typeText))?.[1] ?? 'Jugada',
    text: str(p.text)?.slice(0, 200) ?? null,
    who: str(a?.displayName) ?? names.get(String(a?.id)) ?? null,
    at: iso(p.wallclock),
    period: num(p.period?.number),
  };
};

// ---------- fútbol ----------
// La posición viene en el marco del equipo que hace la jugada, atacando hacia x = 100: el visitante se espeja.
const flip = (frame, x, y) => {
  x = num(x);
  y = num(y);
  if (!frame || !between(x, 0, 100) || !between(y, 0, 100)) return [null, null];
  return (frame === 'home' ? [x, y] : [100 - x, 100 - y]).map(r1);
};

function soccerPlays(json, sideOf) {
  return arr(json.commentary).flatMap((c) => {
    const p = c?.play, seq = num(c?.sequence);
    if (!p || seq == null || p.id == null) return [];
    const typeText = String(p.type?.text ?? '');
    // ESPN publica cada falta dos veces, las dos con el equipo que la cometió: "Foul by …" queda falta y "… wins a free kick" es el tiro libre del rival.
    const freeKick = /wins a free kick/i.test(String(c.text ?? p.text ?? ''));
    const kind = freeKick ? 'free-kick' : SOCCER_KINDS.find(([re]) => re.test(typeText))?.[1] ?? 'other';
    const frame = sideOf(p.team);
    const [x, y] = flip(frame, p.fieldPositionX, p.fieldPositionY);
    const [tx, ty] = flip(frame, p.fieldPosition2X, p.fieldPosition2Y);
    // Un autogol suma para el rival, pero ocurre en el arco de quien lo metió; el tiro libre es del rival de quien cometió la falta, con la posición de la falta.
    const side = frame && (freeKick || /Own Goal/.test(typeText)) ? (frame === 'home' ? 'away' : 'home') : frame;
    return [play({ ...common(p, kind, typeText), seq, t: num(p.clock?.value), clock: str(p.clock?.displayValue), side, x, y, tx, ty })];
  });
}

// ---------- básquet ----------
function zoneOf(pts, x, y) {
  if (pts === 3) return y <= 14 ? 'corner3' : 'arc3';
  if (pts === 2) return Math.abs(x - 25) <= 8 && y <= 19 ? 'paint' : 'mid';
  return null;
}

function basketballPlays(json, sideOf, league) {
  const wp = new Map(arr(json.winprobability).map((w) => [String(w?.playId), num(w?.homeWinPercentage)]));
  // El play de la NBA solo trae el id del jugador; los nombres están en el boxscore del summary.
  const names = new Map(arr(json.boxscore?.players).flatMap((t) => arr(t?.statistics).flatMap((s) => arr(s?.athletes)))
    .map((a) => a?.athlete).filter((a) => a?.id != null && a.displayName).map((a) => [String(a.id), String(a.displayName)]));
  const quarter = league === 'wnba' ? 600 : 720; // la NBA juega cuartos de 12 min, la WNBA de 10; prórroga de 5 en las dos
  const endOf = (n) => (n <= 4 ? n * quarter : 4 * quarter + (n - 4) * 300); // segundos jugados al terminar el periodo n
  return arr(json.plays).flatMap((p) => {
    const seq = num(p?.sequenceNumber);
    if (seq == null || p.id == null) return [];
    const typeText = String(p.type?.text ?? '');
    const kind = p.shootingPlay ? (/Free Throw/.test(typeText) ? 'ft' : 'shot') : NBA_KINDS.find(([re]) => re.test(typeText))?.[1] ?? 'other';
    const side = sideOf(p.team);
    // Media cancha en pies: cx a lo ancho (0 a 50), cy desde la línea de fondo (0 a 47). ESPN pone algunos triples de esquina
    // en y = -3 (detrás de la línea de fondo) y usa -214748340 para "sin coordenadas", que queda fuera. El local ataca la canasta derecha.
    const cx = num(p.coordinate?.x), cy = num(p.coordinate?.y);
    const inCourt = between(cx, 0, 50) && between(cy, -5, 47);
    const dy = Math.max(0, cy ?? 0);
    const [x, y] = side && inCourt ? (side === 'home' ? [100 - (dy * 100) / 94, cx * 2] : [(dy * 100) / 94, 100 - cx * 2]).map(r1) : [null, null];
    const left = clockSecs(p.clock?.displayValue), n = num(p.period?.number);
    const awayScore = num(p.awayScore), homeScore = num(p.homeScore);
    return [play({
      ...common(p, kind, typeText, names), seq, clock: str(p.clock?.displayValue), side, x, y,
      zone: kind === 'shot' && inCourt ? zoneOf(num(p.pointsAttempted), cx, cy) : null,
      t: left == null || n == null || n < 1 ? null : endOf(n) - left,
      made: (kind === 'shot' || kind === 'ft') && p.scoringPlay != null ? !!p.scoringPlay : null,
      pts: num(p.scoreValue) ?? 0,
      score: awayScore == null || homeScore == null ? null : [awayScore, homeScore],
      wp: wp.get(String(p.id)) ?? null,
    })];
  });
}

// sport: 'soccer' | 'basketball'; league ('wnba' cambia el largo de los cuartos). Sin jugadas (partido sin empezar,
// deporte sin summary) devuelve [].
export function normPlays(json, sport, league) {
  if (!json || typeof json !== 'object') return [];
  const sideOf = sideFinder(json);
  const plays = sport === 'soccer' ? soccerPlays(json, sideOf) : sport === 'basketball' ? basketballPlays(json, sideOf, league) : [];
  return plays.sort((a, b) => a.seq - b.seq);
}
