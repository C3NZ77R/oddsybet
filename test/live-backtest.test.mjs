// Backtest en vivo: marcador por cuarto, P(Más) igual que la vista, calibración, niveles de señal y comparación pareada. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutTotals, overAt, calibration, levels, paired } from '../scripts/live-backtest.mjs';
import { totalSignal } from '../public/live.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const comp = (...teams) => ({ competitors: teams.map((qs) => ({ linescores: qs.map((value) => ({ value })) })) });

test('cutTotals: puntos acumulados al final de cada cuarto; null si los linescores no cuadran', () => {
  const ot = comp([7, 10, 3, 7], [0, 14, 7, 3, 6]); // 27-30 en prórroga
  assert.deepEqual(cutTotals(ot, 57), [7, 31, 41]);
  assert.equal(cutTotals(ot, 54), null); // no suma el final
  assert.equal(cutTotals(comp([7, 10, 3], [0, 14, 7]), 41), null); // faltan cuartos
  assert.equal(cutTotals(undefined, 0), null); // el scoreboard no trajo el partido
});

test('overAt: la misma P(Más) que muestra totalSignal con PRIOR.total', () => {
  const live = { id: 'g', progress: 0.5, home: { score: 65 }, away: { score: 65 } };
  const s = totalSignal(live, 224.5, 'basketball');
  near(overAt('basketball', { current: 130, f: 0.5, line: 224.5 }, 8), s.pOver); // 8 = PRIOR.total de public/live.js
});

test('calibration: Brier, log-loss (p = 1 que falla no da Infinity) y tramos de 10 en 10', () => {
  const m = calibration([{ p: 0.75, won: true }, { p: 0.75, won: false }, { p: 0.1, won: false }, { p: 1, won: false }]);
  assert.equal(m.n, 4);
  near(m.brier, (0.0625 + 0.5625 + 0.01 + 1) / 4);
  near(m.logloss, -(Math.log(0.75) + Math.log(0.25) + Math.log(0.9) + Math.log(1e-12)) / 4);
  assert.deepEqual(m.bins, [{ from: 10, n: 1, said: 0.1, hit: 0 }, { from: 70, n: 2, said: 0.75, hit: 0.5 }, { from: 90, n: 1, said: 1, hit: 0 }]);
});

test('levels: cuenta señales por nivel y si acierta su lado', () => {
  // NBA a la mitad con línea 224.5: se esperan 112.25 con desvío √(19.2² · 0.5) ≈ 13.58.
  const rows = [{ current: 140, f: 0.5, line: 224.5, won: true }, { current: 112, f: 0.5, line: 224.5, won: false }, { current: 95, f: 0.5, line: 224.5, won: true }];
  assert.deepEqual(levels('basketball', rows), [
    { level: 1, n: 1, hit: 0, share: 1 / 3 }, // z ≈ −1.3 → Menos, pero terminó en Más
    { level: 2, n: 0, hit: null, share: 0 },
    { level: 3, n: 1, hit: 1, share: 1 / 3 }, // z ≈ 2.0 → Más, acertó
  ]);
});

test('paired: diferencia de log-loss por corte con el error entre partidos', () => {
  const rows = ['a', 'b'].flatMap((game, i) => [0.25, 0.5, 0.75].map((f) => ({ game, f, current: Math.round(f * (200 + 50 * i)), line: 224.5, won: i === 1 })));
  const loss = (r, prior) => -Math.log(r.won ? overAt('basketball', r, prior) : 1 - overAt('basketball', r, prior));
  const d = ['a', 'b'].map((g) => rows.filter((r) => r.game === g).reduce((s, r) => s + loss(r, 1) - loss(r, 8), 0) / 3);
  const m = (d[0] + d[1]) / 2;
  const p = paired('basketball', rows, 1, 8);
  near(p.diff, m);
  near(p.se, Math.sqrt(((d[0] - m) ** 2 + (d[1] - m) ** 2) / 2));
  near(paired('basketball', rows, 8, 1).diff, -m);
});
