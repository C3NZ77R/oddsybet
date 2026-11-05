import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poissonPmf } from '../public/betmath.js';
import { price, MARGIN, MAX_P, halfLine, negBinPmf, scoreGrid, normalOver, countOver, powerOdds, marginOf } from '../lib/pricing.mjs';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const close = (a, b) => near(a, b, 1e-12);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('price: cuota justa y con margen, acotadas', () => {
  const r = price(0.5);
  assert.equal(r.fair, 2);
  assert.equal(r.oddsy, 1.9);
  assert.equal(price(0.999).fair, 1.01);
  assert.equal(price(0.001).fair, 101);
});

test('price: la cuota Oddsy nunca deja valor al apostador hasta MAX_P (1.01 con margen)', () => {
  close(MAX_P, 1 / (1.01 * (1 + MARGIN)));
  for (let p = 0.01; p <= MAX_P; p += 0.0007) assert.ok(p * price(p).oddsy < 1 / (1 + MARGIN) + 1e-9, `p ${p}: oddsy ${price(p).oddsy}`);
  assert.ok(MAX_P * price(MAX_P).oddsy < 1 / (1 + MARGIN) + 1e-9);
  assert.equal(price(1 / (1.13 * (1 + MARGIN))).oddsy, 1.13); // truncar no le quita un centavo a una cuota exacta
  assert.equal(price(0.9909).fair, 1.01); // más allá de MAX_P la cuota ya no puede bajar: no se publica
});

test('halfLine', () => {
  assert.equal(halfLine(7.2), 7.5);
  assert.equal(halfLine(6.9), 6.5);
  assert.equal(halfLine(7), 7.5);
});

test('scoreGrid suma 1 y aplica Dixon-Coles', () => {
  const g = scoreGrid(1.4, 1.1);
  near(sum(g.flat()), 1, 1e-9);
  const g0 = scoreGrid(1.4, 1.1, { rho: 0 });
  near(g0[0][0], poissonPmf(0, 1.4) * poissonPmf(0, 1.1), 1e-4);
  assert.ok(g[0][0] > g0[0][0]);
});

test('normalOver y countOver', () => {
  near(normalOver(7, 13.5, 0), 0.685, 0.002); // línea entera: P(X >= 0.5)
  near(normalOver(7, 13.5, 0.5), 0.685, 0.002);
  near(countOver([0.2, 0.3, 0.5], 0.5), 0.8);
  near(countOver([0.2, 0.3, 0.5], 1), 0.5);
});

test('negBinPmf suma 1; sin sobredispersión usa Poisson', () => {
  near(sum(Array.from({ length: 61 }, (_, k) => negBinPmf(k, 5, 9))), 1, 1e-6);
  near(negBinPmf(2, 5, 4), poissonPmf(2, 5), 1e-12);
});

test('powerOdds: el mercado suma 1 + margen y el no favorito carga más (1X2 de Betano, Medellín–Alianza)', () => {
  const ps = [0.6297, 0.2217, 0.1486]; // justas de 1.55 / 4.15 / 6.00 sin el margen
  const odds = powerOdds(ps, 0.05);
  near(sum(odds.map((o) => 1 / o)), 1.05, 0.01);
  const carga = odds.map((o, i) => 1 / (o * ps[i]) - 1);
  assert.ok(carga[0] < carga[1] && carga[1] < carga[2], `${carga}`);
  assert.equal(marginOf('1x2'), 0.05);
  assert.equal(marginOf('btts'), 0.07);
  assert.equal(marginOf('cards_1x2'), 0.09);
});
