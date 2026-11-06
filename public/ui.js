// Helpers de UI compartidos por todas las vistas.
// Convenciones:
// - Los helpers "de texto" (h, raw, fmt*, hitBar, bookChip, teamLogo, headshot, empty, loading, errorBox,
//   sourceBadge, barChart) devuelven HTML seguro (objeto "Safe": se convierte a string solo, sirve para
//   el.innerHTML = ..., dentro de h`...` y en template literals normales).
// - h`...` escapa TODO valor interpolado salvo otro Safe (h`...` anidado, raw(), helpers de aquí). Los arrays se unen.
// - Los helpers interactivos (dropdown, sortableTable) devuelven un HTMLElement:
//   se insertan con append(), no dentro de h`...`.
import { decimalToAmerican } from './betmath.js';
import { store } from './store.js';
import { leagueById } from './leagues.js';

const SAFE = Symbol.for('oddsy.safe');
class Safe {
  constructor(s) { this.s = s; this[SAFE] = true; }
  toString() { return this.s; }
}
const isSafe = (v) => v != null && v[SAFE] === true;
export const raw = (s) => new Safe(String(s ?? ''));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (isSafe(v) ? v.s : v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));
const part = (v) => (Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(v));

export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}

let seq = 0;
const uid = (p = 'u') => `${p}-${++seq}`;
const safeUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(u) ? u : '');
const hexColor = (c) => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? `#${c.replace('#', '')}` : null);
const initials = (s) => String(s ?? '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// ---------- formato ----------
export function fmtOdds(decimal, format = store.get('settings').oddsFormat) {
  const d = Number(decimal);
  if (!(d > 1) || !Number.isFinite(d)) return '—';
  if (format === 'decimal') return d.toFixed(2);
  const a = decimalToAmerican(d);
  return a > 0 ? `+${a}` : `${a}`;
}
export const fmtPct = (x, d = 1) => (x == null || !Number.isFinite(Number(x)) ? '—' : `${(Number(x) * 100).toFixed(d)}%`);

export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
// "hace 44 minutos"
export function ago(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(s)) return '';
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  for (const [unit, sec] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  return rtf.format(Math.round(s), 'second');
}

// ---------- datos de las vistas ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; // fecha local del API: 20261023
// api.* devuelve el cuerpo { source, data }; se acepta también el dato suelto.
export const dataOf = (r) => (r && typeof r === 'object' && !Array.isArray(r) && 'data' in r ? r.data : r);
// Clave de un prop: URL del detalle (#/liga/props/<clave>), id del pick y clave de "Populares".
export const propKey = (p) => encodeURIComponent(JSON.stringify({ a: p.athleteId ?? null, p: p.player, s: p.stat, l: p.line ?? null, o: p.side, g: p.gameId ?? null }));

// ---------- casas ----------
// Colores aproximados de marca + iniciales; oddsy = nuestro modelo.
export const BOOKS = {
  oddsy: { name: 'Oddsy', color: '#22c55e', ini: 'CF' },
  pinnacle: { name: 'Pinnacle', color: '#f47a20', ini: 'PIN' },
  draftkings: { name: 'DraftKings', color: '#53d337', ini: 'DK' },
  fanduel: { name: 'FanDuel', color: '#1493ff', ini: 'FD' },
  betmgm: { name: 'BetMGM', color: '#c0a46b', ini: 'MGM' },
  caesars: { name: 'Caesars', color: '#1d5c4d', ini: 'CZR' },
  fanatics: { name: 'Fanatics', color: '#d11f2e', ini: 'FAN' },
  espnbet: { name: 'ESPN BET', color: '#e41b23', ini: 'ESPN' },
  betrivers: { name: 'BetRivers', color: '#1b4f9c', ini: 'BR' },
  bovada: { name: 'Bovada', color: '#cc0000', ini: 'BOV' },
  betonlineag: { name: 'BetOnline', color: '#b3121f', ini: 'BOL' },
  mybookieag: { name: 'MyBookie', color: '#f68b1f', ini: 'MYB' },
  lowvig: { name: 'LowVig', color: '#3db54a', ini: 'LV' },
  betsson: { name: 'Betsson', color: '#ff6600', ini: 'BSN' },
  unibet: { name: 'Unibet', color: '#147b45', ini: 'UNI' },
  williamhill: { name: 'William Hill', color: '#1c3f7a', ini: 'WH' },
  codere: { name: 'Codere', color: '#78be20', ini: 'COD' },
  wplay: { name: 'Wplay', color: '#e30613', ini: 'WP' },
  rushbet: { name: 'Rushbet', color: '#f7a600', ini: 'RB' },
  betplay: { name: 'BetPlay', color: '#00a14b', ini: 'BP' },
  kalshi: { name: 'Kalshi', color: '#00d395', ini: 'K' },
  polymarket: { name: 'Polymarket', color: '#2e5cff', ini: 'PM' },
  prizepicks: { name: 'PrizePicks', color: '#7b3fe4', ini: 'PP' },
  underdog: { name: 'Underdog', color: '#f9c80e', ini: 'UD' },
  novig: { name: 'Novig', color: '#6d5cff', ini: 'NV' },
  prophetx: { name: 'ProphetX', color: '#00b2e3', ini: 'PX' },
};
const ALIAS = { williamhillus: 'caesars', espn: 'espnbet', betonline: 'betonlineag', mybookie: 'mybookieag', lowvigag: 'lowvig', mgm: 'betmgm' };
const textOn = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#05080a' : '#ffffff';
};

// Normaliza clave o título de casa ("williamhill_us", "BetMGM", "LowVig.ag") a { key, name, color, ini, fg }.
export function bookInfo(keyOrTitle) {
  const n = String(keyOrTitle ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return { key: '', name: 'Sin casa', color: '#3a434c', ini: '?', fg: '#ffffff' };
  const key = BOOKS[n] ? n : ALIAS[n] ?? (BOOKS[n.replace(/(us|eu|uk|au|ag)\d*$/, '')] ? n.replace(/(us|eu|uk|au|ag)\d*$/, '') : null);
  if (key) return { key, ...BOOKS[key], fg: textOn(BOOKS[key].color) };
  return { key: n, name: String(keyOrTitle), color: '#3a434c', ini: initials(keyOrTitle).slice(0, 3), fg: '#ffffff' };
}

export function bookChip(keyOrTitle, { name = true } = {}) {
  const b = bookInfo(keyOrTitle);
  return h`<span class="book" title="${b.name}"${name ? '' : raw(` aria-label="${esc(b.name)}" role="img"`)}><i class="book-i" style="--bk:${b.color};--bk-fg:${b.fg}" aria-hidden="true">${b.ini}</i>${name ? h`<span class="book-n">${b.name}</span>` : ''}</span>`;
}

// ---------- imágenes con respaldo de iniciales ----------
function avatar(url, ini, size, cls, color) {
  const u = safeUrl(url);
  const bg = hexColor(color) ?? '#1f262d';
  if (!u) return h`<span class="avatar ${cls}" style="--sz:${size}px;--av:${bg}" aria-hidden="true">${ini}</span>`;
  return h`<img class="${cls}" src="${u}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" data-fallback="${ini}" data-av="${bg}">`;
}
export const teamLogo = (team, { size = 24 } = {}) => avatar(team?.logo, (team?.abbr || initials(team?.name)).slice(0, 4), size, 'team-logo', team?.color);
// Sin foto en los datos, se arma la de ESPN con el id del jugador (si falla, quedan las iniciales).
const espnFace = (id, league) => { const sp = leagueById(league)?.sport; return id && sp ? `https://a.espncdn.com/i/headshots/${league === 'wnba' ? 'wnba' : sp === 'basketball' ? 'nba' : sp}/players/full/${id}.png` : null; };
export const headshot = (athlete, { size = 40, league } = {}) => avatar(athlete?.headshot ?? espnFace(athlete?.id, league), initials(athlete?.name), size, 'headshot');

if (typeof document !== 'undefined') {
  // Si la imagen externa falla, se cambia por un círculo con iniciales.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fallback == null) return;
    const s = document.createElement('span');
    s.className = `avatar ${img.className}`;
    s.setAttribute('aria-hidden', 'true');
    s.style.setProperty('--sz', `${img.getAttribute('width')}px`);
    s.style.setProperty('--av', img.dataset.av || '#1f262d');
    s.textContent = img.dataset.fallback;
    img.replaceWith(s);
  }, true);
}

// ---------- barras de acierto ----------
// results: booleans (true acierto, false fallo, null push) en el orden en que se muestran, o un % (0-1).
// { label: true } añade el % al lado (por defecto no, cada vista pone su etiqueta).
export function hitBar(results, { label = false } = {}) {
  let segs, pct, aria;
  if (Array.isArray(results)) {
    const r = results.slice(0, 10);
    const decided = r.filter((x) => x != null);
    const hits = decided.filter(Boolean).length;
    pct = decided.length ? hits / decided.length : null;
    segs = Array.from({ length: 10 }, (_, i) => (i >= r.length ? 'none' : r[i] == null ? 'push' : r[i] ? 'hit' : 'miss'));
    aria = pct == null ? 'Sin datos de acierto' : `Acierto ${fmtPct(pct, 0)} (${hits} de ${decided.length})`;
  } else if (Number.isFinite(results)) {
    pct = Math.min(1, Math.max(0, results));
    const on = Math.round(pct * 10);
    segs = Array.from({ length: 10 }, (_, i) => (i < on ? 'hit' : 'miss'));
    aria = `Acierto ${fmtPct(pct, 0)}`;
  } else {
    pct = null;
    segs = Array(10).fill('none');
    aria = 'Sin datos de acierto';
  }
  const tone = pct == null ? 'na' : pct >= 0.7 ? 'hi' : pct >= 0.5 ? 'mid' : 'lo';
  return h`<span class="hitbar hb-${tone}" role="img" aria-label="${aria}"><span class="hb-segs">${raw(segs.map((s) => `<i class="${s}"></i>`).join(''))}</span>${label ? h`<b class="hb-pct">${fmtPct(pct, 0)}</b>` : ''}</span>`;
}

// Estado de lesión de ESPN (en inglés) en palabras simples.
export const INJURY = { Out: 'Fuera', Questionable: 'Duda', Doubtful: 'Dudoso', 'Day-To-Day': 'Día a día', Probable: 'Probable', Suspension: 'Suspendido' };

// ---------- estados ----------
export const empty = (msg = 'No hay resultados.') => h`<p class="empty">${msg}</p>`;
export const loading = (rows = 5) => raw(`<div class="skeleton" role="status"><span class="sr-only">Cargando…</span>${'<i></i>'.repeat(rows)}</div>`);
// El botón Reintentar lo atiende app.js (data-retry vuelve a montar la vista).
export const errorBox = (err) => h`<div class="error-box" role="alert"><b>No se pudo cargar</b><p>${err?.message ?? String(err ?? 'Error desconocido')}</p><button type="button" class="btn" data-retry>Reintentar</button></div>`;

export function sourceBadge(source, remaining) {
  if (source && typeof source === 'object') ({ source, remaining } = source);
  const M = { oddsy: ['Modelo Oddsy', 'Cuotas que calcula Oddsy con datos de ESPN'], espn: ['ESPN', 'Datos públicos de ESPN'] };
  const [txt, tip] = M[source] ?? ['Fuente desconocida', ''];
  const extra = remaining != null && remaining !== '' ? ` · ${remaining} créditos` : '';
  return h`<span class="src-badge src-${M[source] ? source : 'na'}" title="${tip}">${txt}${extra}</span>`;
}

// ---------- gráfico de barras (SVG con anchos en %, alto fijo: no deforma el texto) ----------
const COLORS = { pos: 'var(--pos)', neg: 'var(--err)', push: 'var(--muted)' };
export function barChart({ values = [], labels = [], line = null, colorFn, title = 'Gráfico de barras', height = 200, format = (v) => String(Math.round(v * 10) / 10) } = {}) {
  const n = values.length;
  if (!n) return empty('Sin datos para el gráfico.');
  const nums = values.map((v) => (Number.isFinite(v) ? v : 0));
  const hasLine = Number.isFinite(line);
  const top = 20, bottom = labels.length ? 34 : 8, plot = height - top - bottom;
  const max = Math.max(...nums, hasLine ? line : 0, 1) * 1.1;
  const y = (v) => top + plot - (Math.max(v, 0) / max) * plot;
  const slot = 100 / n, gap = slot * 0.16;
  const r2 = (x) => Math.round(x * 100) / 100;
  const color = (v, i) => {
    const c = colorFn ? colorFn(v, i) : !hasLine ? 'var(--teal)' : v > line ? 'pos' : v < line ? 'neg' : 'push';
    return COLORS[c] ?? c;
  };
  const tId = uid('chart'), dId = uid('chart');
  const desc = nums.map((v, i) => `${String(labels[i] ?? i + 1).replace(/\n/g, ' ')}: ${format(v)}`).join('; ') + (hasLine ? `. Línea: ${line}` : '');
  const bars = nums.map((v, i) => {
    const hgt = r2(Math.max(top + plot - y(v), 2)), cx = `${r2((i + 0.5) * slot)}%`;
    const lab = String(labels[i] ?? '').split('\n');
    return h`<rect x="${r2(i * slot + gap)}%" y="${r2(top + plot - hgt)}" width="${r2(slot - 2 * gap)}%" height="${hgt}" rx="3" fill="${color(v, i)}"></rect>
      <text x="${cx}" y="${r2(top + plot - hgt - 5)}" class="bc-val" text-anchor="middle">${format(values[i] ?? 0)}</text>
      ${labels.length ? h`<text x="${cx}" y="${top + plot + 14}" class="bc-lab" text-anchor="middle">${lab.map((t, j) => h`<tspan x="${cx}" dy="${j ? 12 : 0}">${t}</tspan>`)}</text>` : ''}`;
  });
  const yl = hasLine ? r2(y(line)) : 0;
  return h`<div class="chart-scroll"><svg class="bar-chart" width="100%" height="${height}" style="min-width:${n * 26}px" role="img" aria-labelledby="${tId} ${dId}">
    <title id="${tId}">${title}</title><desc id="${dId}">${desc}</desc>
    <line x1="0" x2="100%" y1="${top + plot}" y2="${top + plot}" class="bc-axis"></line>
    ${bars}
    ${hasLine ? h`<line x1="0" x2="100%" y1="${yl}" y2="${yl}" class="bc-line" stroke-dasharray="6 5"></line><text x="100%" y="${yl - 5}" class="bc-line-lab" text-anchor="end">${line}</text>` : ''}
  </svg></div>`;
}

// ---------- componentes interactivos (devuelven HTMLElement) ----------
const norm = (o) => (o && typeof o === 'object'
  ? { value: o.value ?? o.id ?? o.key, label: o.label ?? o.title ?? o.name ?? String(o.value ?? o.id ?? o.key) }
  : { value: o, label: String(o) });
const node = (tag, cls) => Object.assign(document.createElement(tag), cls ? { className: cls } : {});

// Menú desplegable. multi=true usa casillas y onChange recibe un array (vacío = "Todos").
export function dropdown({ label = '', options = [], value, multi = false, onChange, placeholder = 'Todos' } = {}) {
  const opts = options.map(norm);
  let sel = multi ? new Set([].concat(value ?? []).map(String)) : value;
  const root = node('div', 'dd');
  const menuId = uid('dd');
  root.innerHTML = h`<button type="button" class="dd-btn" aria-haspopup="true" aria-expanded="false" aria-controls="${menuId}"></button><div class="dd-menu" id="${menuId}" role="group" aria-label="${label}" hidden></div>`;
  const btn = root.firstElementChild, menu = root.lastElementChild;
  const summary = () => {
    if (!multi) return opts.find((o) => String(o.value) === String(sel))?.label ?? placeholder;
    const chosen = opts.filter((o) => sel.has(String(o.value)));
    return chosen.length === 0 ? placeholder : chosen.length === 1 ? chosen[0].label : `${chosen.length} seleccionados`;
  };
  const paint = () => {
    btn.innerHTML = h`${label ? h`<span class="dd-label">${label}</span> ` : ''}<span class="dd-val">${summary()}</span><span class="dd-caret" aria-hidden="true">▾</span>`;
    menu.innerHTML = multi
      ? h`${opts.map((o, i) => h`<label class="dd-opt"><input type="checkbox" data-i="${i}"${sel.has(String(o.value)) ? raw(' checked') : ''}> <span>${o.label}</span></label>`)}
         ${sel.size ? h`<button type="button" class="dd-clear" data-clear>Limpiar</button>` : ''}`
      : h`${opts.map((o, i) => h`<button type="button" class="dd-opt" data-i="${i}" aria-pressed="${String(o.value) === String(sel)}">${o.label}</button>`)}`;
  };
  const onDoc = (e) => { if (!root.contains(e.target)) close(); };
  function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.addEventListener('click', onDoc); }
  function close(focus) {
    menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', onDoc);
    if (focus) btn.focus();
  }
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(true); } });
  root.addEventListener('focusout', (e) => { if (e.relatedTarget && !root.contains(e.relatedTarget)) close(); });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear]')) { sel.clear(); paint(); onChange?.([]); return; }
    if (multi) return;
    const b = e.target.closest('[data-i]');
    if (!b) return;
    sel = opts[b.dataset.i].value;
    paint(); close(true); onChange?.(sel);
  });
  menu.addEventListener('change', (e) => {
    const o = opts[e.target.dataset.i];
    if (!o) return;
    e.target.checked ? sel.add(String(o.value)) : sel.delete(String(o.value));
    btn.querySelector('.dd-val').textContent = summary();
    onChange?.(opts.filter((x) => sel.has(String(x.value))).map((x) => x.value));
  });
  paint();
  return root;
}

// Tabla ordenable. columns: [{ key, label, render?(row) → Safe|texto, sort?(row) → valor, align?, className?, sortable?, defaultDir? }]
// render debe devolver h`...` para HTML (un string normal se escapa). Devuelve el contenedor con .setRows(rows).
export function sortableTable({ columns = [], rows = [], sortKey = null, sortDir = 'desc', onRowClick, pageSize = 100, emptyText = 'No hay resultados.', caption = '' } = {}) {
  const wrap = node('div', 'table-wrap');
  let data = rows, key = sortKey, dir = sortDir, limit = pageSize, shown = [];
  const valueOf = (c, r) => (c.sort ? c.sort(r) : r?.[c.key]);
  const blank = (v) => v == null || (typeof v === 'number' && Number.isNaN(v));
  const cmp = (a, b) => (blank(a) ? (blank(b) ? 0 : 1) : blank(b) ? -1 : 0);
  function sorted() {
    const c = columns.find((x) => x.key === key);
    if (!c) return data;
    const m = dir === 'asc' ? 1 : -1;
    return [...data].sort((ra, rb) => {
      const a = valueOf(c, ra), b = valueOf(c, rb);
      return cmp(a, b) || (blank(a) ? 0 : typeof a === 'number' && typeof b === 'number' ? (a - b) * m : String(a).localeCompare(String(b), 'es') * m);
    });
  }
  const cell = (c, r) => {
    const v = c.render ? c.render(r) : r?.[c.key];
    return v == null || v === '' ? '—' : v;
  };
  function draw(focusKey) {
    const all = sorted();
    shown = all.slice(0, limit);
    wrap.innerHTML = h`<table class="tbl">${caption ? h`<caption class="sr-only">${caption}</caption>` : ''}
      <thead><tr>${columns.map((c) => h`<th scope="col" class="${[c.className, c.align && `al-${c.align}`].filter(Boolean).join(' ')}"${c.key === key ? raw(` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"`) : ''}>${c.sortable === false
        ? c.label
        : h`<button type="button" class="th-sort" data-key="${c.key}">${c.label}<span class="sort-ind" aria-hidden="true">${c.key === key ? (dir === 'asc' ? '▲' : '▼') : ''}</span></button>`}</th>`)}</tr></thead>
      <tbody>${shown.length
        ? shown.map((r, i) => h`<tr data-i="${i}"${onRowClick ? raw(' class="clickable" tabindex="0"') : ''}>${columns.map((c) => h`<td class="${[c.className, c.align && `al-${c.align}`].filter(Boolean).join(' ')}">${cell(c, r)}</td>`)}</tr>`)
        : h`<tr><td colspan="${columns.length}" class="tbl-empty">${emptyText}</td></tr>`}</tbody></table>
      ${all.length > limit ? h`<button type="button" class="btn tbl-more" data-more>Mostrar más (${all.length - limit} restantes)</button>` : ''}`;
    if (focusKey) wrap.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
  const rowFrom = (e) => {
    if (!onRowClick || e.target.closest('button, a, input, select, label, textarea')) return null;
    const tr = e.target.closest('tr[data-i]');
    return tr ? shown[+tr.dataset.i] : null;
  };
  wrap.addEventListener('click', (e) => {
    const th = e.target.closest('.th-sort');
    if (th) {
      const c = columns.find((x) => x.key === th.dataset.key);
      if (key === c.key) dir = dir === 'asc' ? 'desc' : 'asc';
      else { key = c.key; dir = c.defaultDir ?? 'desc'; }
      draw(c.key);
      return;
    }
    if (e.target.closest('[data-more]')) { limit += pageSize; draw(); return; }
    const r = rowFrom(e);
    if (r) onRowClick(r, e);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'TR') return;
    const r = rowFrom(e);
    if (r) onRowClick(r, e);
  });
  wrap.setRows = (r) => { data = r; limit = pageSize; draw(); };
  draw();
  return wrap;
}

export const ui = { INJURY, esc, h, raw, fmtOdds, fmtPct, when, ago, hitBar, bookChip, bookInfo, BOOKS, teamLogo, headshot, dropdown, sortableTable, empty, loading, errorBox, sourceBadge, barChart };
export default ui;
