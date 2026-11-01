// Backtest contra el mercado: línea de la casa del summary, filas del modelo sin devoluciones y ROI por regla. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimal, bookLines, marketRows, marketEntry } from '../scripts/market-backtest.mjs';
import { normalOver } from '../lib/pricing.mjs';

const summary = {
  header: { id: '1', league: { slug: 'nba' } },
  pickcenter: [{
    provider: { name: 'DraftKings' }, spread: -4.5, overUnder: 228.5, overOdds: -110, underOdds: -110,
    homeTeamOdds: { moneyLine: -200, spreadOdds: -110 }, awayTeamOdds: { moneyLine: 150, spreadOdds: -110 },
  }],
};

test('decimal y bookLines: americano a decimal, del lado local y del Más', () => {
  assert.equal(decimal(150), 2.5);
  assert.equal(decimal(-200), 1.5);
  const l = bookLines(summary);
  assert.deepEqual(l, { provider: 'DraftKings', ml: [1.5, 2.5], spread: { line: -4.5, odds: [decimal(-110), decimal(-110)] }, total: { line: 228.5, odds: [decimal(-110), decimal(-110)] } });
  assert.equal(bookLines({}), null);
  assert.deepEqual(Object.keys(bookLines({ pickcenter: [{ homeTeamOdds: {}, awayTeamOdds: {} }] })), ['provider']);
});

test('marketRows: p del modelo en la línea de la casa, casa sin margen y sin devoluciones', () => {
  const model = { mu: 6, sigma: 12, total: 230, sigmaT: 19 };
  const rows = marketRows({ id: '1', margin: 5, points: 228.5, model }, bookLines(summary));
  assert.deepEqual(rows.map((r) => r.market), ['ml', 'spread']); // el total cayó justo en la línea
  const [ml, sp] = rows;
  assert.ok(Math.abs(ml.book - (1 / 1.5) / (1 / 1.5 + 1 / 2.5)) < 1e-12);
  assert.ok(Math.abs(sp.p - normalOver(6, 12, 4.5)) < 1e-12);
  assert.equal(ml.won, true);
  assert.equal(sp.won, true); // 5 − 4.5 > 0
  assert.equal(marketRows({ id: '1', margin: 4.5, points: 0, model }, { spread: { line: -4.5, odds: [1.9, 1.9] } }).length, 0);
});

test('marketEntry: ROI de cada regla a la cuota de la casa y peso de la mezcla', () => {
  const r = (p, book, won) => ({ game: String(Math.random()), market: 'ml', p, book, odds: [1 / book, 1 / (1 - book)], won });
  // El modelo da 0.7 al local, la casa 0.5: probable y ev apuestan al local a 2.0; gana uno de dos.
  const e = marketEntry([r(0.7, 0.5, true), r(0.7, 0.5, false)]);
  assert.deepEqual(e.ml.roi.probable, { n: 2, hit: 0.5, roi: 0 });
  assert.deepEqual(e.ml.roi.ev5, e.ml.roi.probable);
  assert.deepEqual(e.all.roi, e.ml.roi);
  assert.equal(e.ml.blendWeight, 0); // con un acierto y un fallo, 0.5 de la casa es lo mejor
  assert.ok(e.ml.vsBook.diff > 0);
  // Sin valor por ningún lado (modelo = casa con margen cero): ev no apuesta.
  assert.deepEqual(marketEntry([r(0.5, 0.5, true)]).ml.roi.ev0, { n: 0 });
});
