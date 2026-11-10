// La línea de la casa como insumo del modelo (lib/book.mjs): lectura de las odds de ESPN, parámetros implícitos y mezcla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineOf, lineFrom, impliedNormal, impliedPoisson, anchor } from '../lib/book.mjs';
import { normalOver, scoreGrid } from '../lib/pricing.mjs';
import { marketsFor } from '../lib/markets.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const dec = (am) => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const fair2 = (a, b) => (1 / dec(a)) / (1 / dec(a) + 1 / dec(b));

test('lineOf: scoreboard de la NBA (solo open/close anidados) y summary con campos planos', () => {
  const board = lineFrom(fx('scoreboard-nba.json').events[0].competitions[0].odds);
  close(board.ml[0], fair2(-108, -112));
  assert.equal(board.spread.line, 1.5); // del local
  close(board.spread.p, fair2(-118, -102));
  assert.equal(board.total.line, 222.5);
  close(board.total.p, fair2(-105, -115));
  const open = lineFrom(fx('scoreboard-nba.json').events[0].competitions[0].odds, { open: true });
  assert.equal(open.spread.line, -2.5); // abrió con el local favorito
  const sum = lineFrom(fx('summary-nba-post.json').pickcenter);
  close(sum.ml[0], fair2(-192, 160));
  assert.equal(sum.spread.line, -4.5);
});

test('lineOf: fútbol con empate; en juego usa la última previa, nunca la cuota en vivo (current)', () => {
  const live = lineFrom(fx('scoreboard-laliga.json').events[0].competitions[0].odds);
  assert.equal(live.ml.length, 3);
  const [h, d, a] = [120, 210, 265].map((x) => 1 / dec(x)); // close; current es −20000 / +1900 / +9000
  close(live.ml[0], h / (h + d + a));
  close(live.ml[1], d / (h + d + a));
  close(live.total.p, fair2(150, -185));
  assert.equal(lineFrom(fx('summary-laliga.json').pickcenter).ml.length, 3);
});

test('lineOf: sin cuotas o con basura, null', () => {
  assert.equal(lineOf(null), null);
  assert.equal(lineOf({ details: 'BOS -1.5' }), null);
  assert.equal(lineOf({ homeTeamOdds: { moneyLine: 'x' }, awayTeamOdds: { moneyLine: -110 } }), null);
  assert.equal(lineFrom(undefined), null);
});

test('impliedNormal: el mu y el total que salen reproducen la línea', () => {
  const line = { spread: { line: -6.5, p: 0.52 }, total: { line: 221.5, p: 0.47 } };
  const { mu, total } = impliedNormal(line, { sigma: 12.5, sigmaT: 19.2 });
  close(normalOver(mu, 12.5, 6.5), 0.52);
  close(normalOver(total, 19.2, 221.5), 0.47);
  assert.ok(mu > 6 && mu < 8 && total > 220 && total < 222);
  // Sin hándicap, del ganador; sin nada, null.
  // Línea entera: la devolución no cuenta, como en la cuota sin margen (sin empate en el ganador, ±7 con push en 7).
  const ml = impliedNormal({ ml: [0.7, 0.3] }, { sigma: 12.5, sigmaT: 19.2 });
  const [o, u] = [normalOver(ml.mu, 12.5, 0), 1 - normalOver(ml.mu, 12.5, -1)];
  close(o / (o + u), 0.7);
  close(impliedNormal({ spread: { line: -7, p: 0.5 } }, { sigma: 12.5, sigmaT: 19.2 }).mu, 7, 1e-6);
  assert.deepEqual(impliedNormal({}, { sigma: 12.5, sigmaT: 19.2 }), { mu: null, total: null });
});

test('impliedPoisson: recupera las λ de una grilla de Dixon-Coles desde su 1X2 y su total', () => {
  const g = scoreGrid(1.7, 0.9);
  let H = 0, D = 0, over = 0;
  g.forEach((row, i) => row.forEach((p, j) => { if (i > j) H += p; else if (i === j) D += p; if (i + j > 2.5) over += p; }));
  const { lh, la } = impliedPoisson({ ml: [H, D, 1 - H - D], total: { line: 2.5, p: over } });
  close(lh, 1.7, 0.01);
  close(la, 0.9, 0.01);
  assert.equal(impliedPoisson({ ml: [0.6, 0.4] }), null); // sin empate no es fútbol
});

test('anchor: peso 0 = la línea, peso 1 = el modelo; sin línea, el modelo', () => {
  const nba = { kind: 'normal', mu: 2, sigma: 12.5, total: 230, sigmaT: 19.2 };
  const line = { spread: { line: -7, p: 0.5 }, total: { line: 220, p: 0.5 } };
  const m0 = anchor('basketball', nba, line, { mu: 0, total: 0 });
  close(m0.mu, 7, 1e-3);
  close(m0.total, 220, 1e-3);
  assert.deepEqual(anchor('basketball', nba, line, { mu: 1, total: 1 }), nba);
  close(anchor('basketball', nba, line, { mu: 0.5, total: 0.2 }).total, 0.2 * 230 + 0.8 * 220, 1e-3);
  assert.equal(anchor('basketball', nba, null), nba);
  // Fútbol: con peso 0 el 1X2 publicado es el de la línea sin margen.
  const soc = anchor('soccer', { kind: 'poisson', lh: 1.1, la: 1.1 }, { ml: [0.55, 0.25, 0.2], total: { line: 2.5, p: 0.55 } }, 0);
  const x = marketsFor('soccer', soc).find((m) => m.key === '1x2').selections.map((s) => s.p);
  close(x[0], 0.55, 0.01);
  close(x[2], 0.2, 0.01);
});
