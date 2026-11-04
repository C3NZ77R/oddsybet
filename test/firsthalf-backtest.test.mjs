// Backtest de primer tiempo: goles por minuto del scoreboard, P(Más) de la grilla escalada y el corte en dos mitades. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalMinutes, pOver, evaluate } from '../scripts/firsthalf-backtest.mjs';
import { scoreGrid } from '../lib/pricing.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const goal = (clock, extra = {}) => ({ scoringPlay: true, clock: { displayValue: clock }, ...extra });

test('goalMinutes: minuto de cada gol, el añadido cuenta en su tiempo; null si no suman el final', () => {
  const comp = { details: [{ scoringPlay: false, clock: { displayValue: "12'" } }, goal("45'+2'"), goal("90'+3'"), goal("5'", { shootout: true })] };
  assert.deepEqual(goalMinutes(comp, 2), [45, 90]);
  assert.equal(goalMinutes(comp, 3), null); // falta un gol
  assert.equal(goalMinutes(undefined, 0), null); // el scoreboard no trajo el partido
  assert.deepEqual(goalMinutes({ details: [] }, 0), []); // 0-0
});

test('pOver: Más de 0.5 es 1 − P(0-0) de la grilla con las medias escaladas', () => {
  near(pOver(1.5, 1.1, 0.45, 0.5), 1 - scoreGrid(1.5 * 0.45, 1.1 * 0.45)[0][0]);
  near(pOver(1.5, 1.1, 0, 0.5), 0);
  assert.ok(pOver(1.5, 1.1, 0.45, 1.5) < pOver(1.5, 1.1, 0.45, 0.5));
});

test('evaluate: share y referencia con la primera mitad, medición con la segunda', () => {
  const g = (...mins) => ({ lh: 1.4, la: 1.1, mins });
  const rows = [g(10, 60), g(), g(30, 40, 80, 85), g(50), g(3), g(20, 70), g(), g(44)];
  const e = evaluate(rows);
  near(e.share, 3 / 7); // primera mitad: 10, 30, 40 de 7 goles
  const [over05] = e.pre;
  near(over05.freq, 0.5); // 2 de 4 con gol antes del descanso
  assert.equal(over05.n, 4);
  near(over05.hit, 0.75); // segunda mitad: 3', 20' y 44' sí; el 0-0 no
  const [at7] = e.live;
  assert.equal(at7.n, 3); // el gol al 3' deja fuera ese partido
  near(at7.hit, 2 / 3);
});
