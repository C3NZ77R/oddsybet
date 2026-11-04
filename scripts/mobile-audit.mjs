// Auditoría móvil de Oddsy Bet: recorre las vistas con perfiles de iPhone (WebKit, el motor de Safari) y Android (Chrome)
// y mide desbordes, tablas que hay que deslizar, texto cortado, botones chicos, letra chica y lo que tapa el botón del boleto.
// Uso: PW=/ruta/a/playwright-core node scripts/mobile-audit.mjs [https://oddsybet.vercel.app] [carpeta-de-salida]
// ONLY='iPhone 15,Pixel 7' limita los teléfonos y ROUTES='nba-picks,tennis-player' las vistas.
// playwright-core no es dependencia del proyecto: se pasa la ruta de una instalación (WebKit y Chrome ya descargados).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const { webkit, chromium, devices } = createRequire(import.meta.url)(process.env.PW ?? 'playwright-core');
const BASE = process.argv[2] ?? 'https://oddsybet.vercel.app';
const OUT = process.argv[3] ?? 'mobile-audit-out';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const ONLY = process.env.ONLY?.split(',');

const DEVICES = [
  ['iPhone SE (3rd gen)', webkit],
  ['iPhone 15', webkit],
  ['iPhone 15 Pro Max', webkit],
  ['Galaxy S24', chromium],
  ['Pixel 7', chromium],
].filter(([d]) => !ONLY || ONLY.includes(d));
const ONLY_ROUTES = process.env.ROUTES?.split(',');

// Rutas; las de detalle salen del primer enlace de su lista (from + sel).
const ROUTES = [
  { id: 'nba-props', hash: '#/nba/props' },
  { id: 'nba-prop-detalle', from: 'nba-props', sel: 'a.pp-pl' },
  { id: 'nba-games', hash: '#/nba/games' },
  { id: 'nba-game-detalle', from: 'nba-games', sel: 'a.gm-more[href*="/games/"]' },
  { id: 'nba-live', hash: '#/nba/live' },
  { id: 'nba-picks', hash: '#/nba/picks' },
  { id: 'nba-insights', hash: '#/nba/insights' },
  { id: 'nba-popular', hash: '#/nba/popular' },
  { id: 'nba-seguir', hash: '#/nba/seguir' },
  { id: 'colombia-props', hash: '#/colombia/props' },
  { id: 'colombia-games', hash: '#/colombia/games' },
  { id: 'colombia-game-detalle', from: 'colombia-games', sel: 'a.gm-more[href*="/games/"]' },
  { id: 'colombia-picks', hash: '#/colombia/picks' },
  { id: 'laliga-game-detalle', from: 'laliga-games', sel: 'a.gm-more[href*="/games/"]', hash0: '#/laliga/games' },
  { id: 'atp-games', hash: '#/atp/games' },
  { id: 'atp-game-detalle', from: 'atp-games', sel: 'a.gm-more[href*="/games/"]' },
  { id: 'atp-picks', hash: '#/atp/picks' },
  { id: 'tennis-rankings', hash: '#/tennis-rankings' },
  { id: 'tennis-player', from: 'tennis-rankings', sel: 'a[href*="tennis-player"]' },
  { id: 'boleto-abierto', hash: '#/nba/games', slip: true },
].filter((r, _, all) => !ONLY_ROUTES || ONLY_ROUTES.includes(r.id) || all.some((x) => x.from === r.id && ONLY_ROUTES.includes(x.id)));

// Se evalúa dentro de la página. Devuelve solo números y textos (JSON).
function measure(vw) {
  // vw = ancho real del teléfono: si algo se sale, Chrome agranda innerWidth y la página se puede arrastrar de lado.
  const cs = (el) => getComputedStyle(el);
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`${s}#${e.id}`); break; }
      const c = [...e.classList].slice(0, 2).join('.');
      parts.unshift(c ? `${s}.${c}` : s);
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = cs(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0 && !el.closest('[hidden], details:not([open]) > :not(summary)');
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const r0 = (x) => Math.round(x);

  // 1. La página entera se corre de lado.
  const page = { device: vw, innerWidth, scrollWidth: document.documentElement.scrollWidth, extra: document.documentElement.scrollWidth - vw };

  // 2. Cajas que se salen de la pantalla sin un contenedor que las recorte (se ven cortadas o empujan la página).
  const contained = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (cs(a).overflowX !== 'visible') return true;
    return false;
  };
  const off = all.filter((el) => { const r = el.getBoundingClientRect(); return r.right > 0 && (r.right > vw + 1 || r.left < -1) && !contained(el); }); // right <= 0: escondido a propósito (enlace de salto)
  const offSet = new Set(off);
  const offenders = off.filter((el) => !offSet.has(el.parentElement)).map((el) => {
    const r = el.getBoundingClientRect();
    el.dataset.auditOff = '';
    return { path: pathOf(el), left: r0(r.left), right: r0(r.right), width: r0(r.width), text: label(el).slice(0, 50) };
  });

  // 3. Contenedores que hay que deslizar con el dedo.
  const scrollers = all.filter((el) => /(auto|scroll)/.test(cs(el).overflowX) && el.scrollWidth > el.clientWidth + 2).map((el) => {
    const t = el.querySelector('table');
    if (t) el.dataset.auditTable = '';
    const r = el.getBoundingClientRect();
    let cols = 0, colsVisible = 0, sticky = 0, headers = [];
    if (t?.rows[0]) {
      const cells = [...(t.tHead?.rows[0] ?? t.rows[0]).cells];
      cols = cells.length;
      headers = cells.map((c) => c.innerText.trim().replace(/\s+/g, ' ').slice(0, 14));
      for (const c of cells) {
        const cr = c.getBoundingClientRect();
        if (cr.right <= r.right + 1 && cr.left >= r.left - 1) colsVisible++;
        if (cs(c).position === 'sticky' && cs(c).left !== 'auto') sticky++; // columna fija al deslizar
      }
    }
    return {
      path: pathOf(el), kind: t ? 'tabla' : el.querySelector('svg') && !el.querySelector('button, a') ? 'gráfico' : 'fila de botones',
      client: el.clientWidth, scroll: el.scrollWidth, hiddenPct: r0(100 * (1 - el.clientWidth / el.scrollWidth)),
      cols, colsVisible, sticky, headers, rows: t ? t.tBodies[0]?.rows.length ?? 0 : 0, y: r0(r.top + scrollY),
    };
  });

  // 4. Texto cortado con "…".
  const truncated = all.filter((el) => cs(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ path: pathOf(el), shown: el.clientWidth, needs: el.scrollWidth, text: label(el) }));

  // 5. Zonas táctiles: WCAG 2.2 (24 px), Apple (44 pt) y Android (48 dp); 1 px CSS = 1 pt = 1 dp en estos perfiles.
  const TAP = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=checkbox], [role=switch]';
  const taps = all.filter((el) => el.matches(TAP) && !(cs(el).display === 'inline' && el.closest('p'))).map((el) => {
    const r = el.getBoundingClientRect();
    return { path: pathOf(el), w: r0(r.width), h: r0(r.height), text: label(el).slice(0, 40) };
  });
  const minSide = (t) => Math.min(t.w, t.h);
  const tap = {
    total: taps.length,
    under24: taps.filter((t) => minSide(t) < 24).length,
    under44: taps.filter((t) => minSide(t) < 44).length,
    under48: taps.filter((t) => minSide(t) < 48).length,
    worst: [...new Map(taps.filter((t) => minSide(t) < 44).sort((a, b) => minSide(a) - minSide(b)).map((t) => [t.path + t.text, t])).values()].slice(0, 12),
  };

  // 6. Letra chica (texto visible bajo 12 px).
  const sizes = {};
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    if (!n.data.trim() || !n.parentElement || !visible(n.parentElement)) continue;
    const fs = parseFloat(cs(n.parentElement).fontSize);
    if (fs >= 12) continue;
    const k = String(fs);
    (sizes[k] ??= { count: 0, samples: [] }).count++;
    if (sizes[k].samples.length < 4) sizes[k].samples.push({ path: pathOf(n.parentElement), text: n.data.trim().slice(0, 40) });
  }

  // 7. Campos con letra < 16 px: Safari en iPhone acerca la página al tocarlos.
  const zoomInputs = all.filter((el) => el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select, textarea') && parseFloat(cs(el).fontSize) < 16)
    .map((el) => ({ path: pathOf(el), fontSize: parseFloat(cs(el).fontSize), text: label(el).slice(0, 30) }));

  // 8. Lo fijo en pantalla (cabecera, barra inferior, botón del boleto) y cuánto alto le deja al contenido.
  const fixed = all.filter((el) => ['fixed', 'sticky'].includes(cs(el).position) && el.getBoundingClientRect().height > 30 && !el.closest('table'))
    .map((el) => { const r = el.getBoundingClientRect(); return { path: pathOf(el), position: cs(el).position, top: r0(r.top), bottom: r0(r.bottom), h: r0(r.height), w: r0(r.width) }; });

  return { page, offenders, scrollers, truncated, tap, smallText: sizes, zoomInputs, fixed, viewportMeta: document.querySelector('meta[name=viewport]')?.content };
}

// Al final de la página: qué queda debajo del botón flotante del boleto y de la barra inferior.
function underFloating() {
  scrollTo(0, document.documentElement.scrollHeight);
  const fab = document.querySelector('.slip-fab');
  const nav = document.querySelector('nav.side');
  const res = { fab: null, lastContentBottom: null, navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null };
  const view = document.querySelector('#view');
  const last = view && [...view.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 0).pop();
  if (last) res.lastContentBottom = Math.round(last.getBoundingClientRect().bottom);
  if (fab && fab.getBoundingClientRect().width) {
    const r = fab.getBoundingClientRect();
    const hits = new Set();
    for (const [x, y] of [[r.left + 4, r.top + r.height / 2], [r.left + r.width / 2, r.top + 4], [r.left + r.width / 2, r.bottom - 4], [r.right - 4, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 2]]) {
      const under = document.elementsFromPoint(x, y).find((e) => !fab.contains(e) && e.closest('#view'));
      if (under) hits.add(`${under.tagName.toLowerCase()}${under.className ? '.' + String(under.className).split(' ')[0] : ''}: ${(under.innerText || under.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    res.fab = { top: Math.round(r.top), bottom: Math.round(r.bottom), over: [...hits] };
  }
  return res;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#view .skeleton, #view .pp-skel, #view [aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

await mkdir(path.join(OUT, 'shots'), { recursive: true });
const results = [];
for (const [name, type] of DEVICES) {
  const browser = await type.launch(type === chromium ? { executablePath: CHROME } : {});
  const dev = devices[name];
  const ctx = await browser.newContext({ ...dev, locale: 'es-CO', timezoneId: 'America/Bogota' });
  const page = await ctx.newPage();
  const links = {};
  const slug = name.replace(/\W+/g, '-').replace(/-$/, '');
  for (const r of ROUTES) {
    let hash = r.hash;
    if (r.from) {
      if (!links[r.from] && r.hash0) {
        await page.goto(BASE + r.hash0); await settle(page);
        links[r.from] = await page.$eval(r.sel, (a) => a.getAttribute('href')).catch(() => null);
      }
      hash = links[r.from];
      if (!hash) { results.push({ device: name, route: r.id, skipped: 'sin enlace de detalle' }); continue; }
    }
    const t0 = Date.now();
    await page.goto('about:blank');
    await page.goto(BASE + '/' + hash);
    await settle(page);
    const ms = Date.now() - t0;
    if (r.slip) {
      const sel = await page.$('#view [data-pick]');
      if (sel) { await sel.click(); await page.waitForTimeout(300); }
      const fab = await page.$('.slip-fab');
      if (fab && await fab.isVisible()) { await fab.click(); await page.waitForTimeout(500); }
    }
    for (const n of ROUTES.filter((x) => x.from === r.id)) links[r.id] = await page.$eval(n.sel, (a) => a.getAttribute('href')).catch(() => null);
    const m = await page.evaluate(measure, dev.viewport.width);
    await page.screenshot({ path: path.join(OUT, 'shots', `${slug}__${r.id}.png`), scale: 'css' });
    // Captura de cada tabla que hay que deslizar (hasta 2 por vista).
    for (const [i, h] of (await page.$$('[data-audit-off]')).slice(0, 2).entries()) {
      await h.screenshot({ path: path.join(OUT, 'shots', `${slug}__${r.id}__fuera${i + 1}.png`), scale: 'css' }).catch(() => {});
    }
    const tables = await page.$$('[data-audit-table]');
    for (const [i, h] of tables.slice(0, 2).entries()) {
      await h.screenshot({ path: path.join(OUT, 'shots', `${slug}__${r.id}__tabla${i + 1}.png`), scale: 'css' }).catch(() => {});
    }
    const floating = r.slip ? null : await page.evaluate(underFloating);
    results.push({ device: name, engine: type.name(), viewport: dev.viewport, route: r.id, hash, ms, ...m, floating });
    console.log(`${name} · ${r.id}: ${ms} ms, desborde ${m.page.extra}px, ${m.offenders.length} fuera, ${m.scrollers.length} deslizables, ${m.truncated.length} cortados, ${m.tap.under44}/${m.tap.total} bajo 44`);
  }
  await browser.close();
}
await writeFile(path.join(OUT, 'results.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 1));
