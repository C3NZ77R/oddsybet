// Aprendizaje del registro de picks (lib/learn.mjs): señales por partido, el ajuste logístico y su validación. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fewOf } from '../lib/learn.mjs';

test('fewOf: 1 sin partidos, 0 desde FEW_N (10 en fútbol y básquet, 20 en tenis)', () => {
  assert.equal(fewOf('soccer', 0), 1);
  assert.equal(fewOf('soccer', 5), 0.5);
  assert.equal(fewOf('basketball', 12), 0);
  assert.equal(fewOf('tennis', 10), 0.5);
  assert.equal(fewOf('soccer', undefined), 1);
});

import { applyModel, parseModel, fitSport, learnModel, currentModel } from '../lib/learn.mjs';
import { MAX_P } from '../lib/pricing.mjs';

const NOW = Date.parse('2026-11-03T09:20:00Z');
const logit = (p) => Math.log(p / (1 - p));
const sig = (z) => 1 / (1 + Math.exp(-z));
// PRNG con semilla: los datos sintéticos salen iguales en cada corrida.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// n filas en 60 días hasta NOW; truth(pRaw, row) = la p real de ganar.
function rows(n, { seed = 1, market = 'dc', league = 'laliga', few = () => 0, truth = (p) => p } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const pRaw = 0.55 + 0.35 * r();
    const row = { league: typeof league === 'function' ? league(i) : league, market, pRaw, x: { few: few(i), abs: 0 }, gameStart: new Date(NOW - (60 * 864e5 * (i + 0.5)) / n).toISOString() };
    return { ...row, won: r() < truth(pRaw, row) };
  });
}
const used = (sport, params) => ({ version: 1, sports: { [sport]: { status: 'en_uso', ...params } } });

test('applyModel: sin ajuste en uso devuelve p tal cual', () => {
  const q = { sport: 'soccer', league: 'laliga', market: 'dc', p: 0.8, x: {} };
  assert.equal(applyModel(null, q), 0.8);
  assert.equal(applyModel({ sports: { soccer: { status: 'sin_mejora', markets: { dc: { a: -3, b: 1 } } } } }, q), 0.8);
  assert.equal(applyModel(used('basketball', { markets: { dc: { a: -3, b: 1 } } }), q), 0.8); // otro deporte
});

test('applyModel: a y b del mercado, c de la liga, w de las señales; tope de ±1 en logit y MAX_P', () => {
  const q = { sport: 'soccer', league: 'laliga', market: 'dc', p: 0.8, x: { few: 1, abs: 0 } };
  assert.ok(Math.abs(applyModel(used('soccer', { markets: { dc: { a: 0, b: 0.5 } } }), q) - sig(0.5 * logit(0.8))) < 1e-4);
  assert.ok(Math.abs(applyModel(used('soccer', { leagues: { laliga: -0.4 }, w: { few: -0.3 } }), q) - sig(logit(0.8) - 0.7)) < 1e-4);
  assert.ok(Math.abs(applyModel(used('soccer', { markets: { dc: { a: 5, b: 1 } } }), { ...q, p: 0.7 }) - sig(logit(0.7) + 1)) < 1e-4);
  assert.ok(Math.abs(applyModel(used('soccer', { markets: { dc: { a: -5, b: 1 } } }), { ...q, p: 0.7 }) - sig(logit(0.7) - 1)) < 1e-4);
  assert.equal(applyModel(used('soccer', { markets: { dc: { a: 5, b: 1 } } }), { ...q, p: 0.93 }), MAX_P);
});

test('parseModel: rechaza basura, acepta lo que guarda learnModel', () => {
  for (const bad of [null, 'x', 7, {}, { sports: { soccer: { status: 'x' } } }, used('soccer', { markets: { dc: { a: 0, b: NaN } } }),
    used('soccer', { leagues: { ucl: 'mucho' } }), used('soccer', { w: { few: Infinity } }), used('soccer', { markets: { dc: { a: 1 } } })]) {
    assert.equal(parseModel(bad), null, JSON.stringify(bad));
  }
  const m = learnModel({ soccer: rows(50) }, { now: NOW });
  assert.deepEqual(parseModel(m), m);
});

test('fitSport: con pocas filas no ajusta (pocos_datos)', () => {
  const r = fitSport(rows(50), { now: NOW });
  assert.equal(r.status, 'pocos_datos');
  assert.equal(r.n, 50);
});

test('fitSport: un modelo sobreconfiado (dice 80 %, sale ~70 %) aprende b < 1 y se usa porque acierta mejor en la prueba', () => {
  const r = fitSport(rows(2000, { truth: (p) => sig(0.5 * logit(p)) }), { now: NOW });
  assert.equal(r.status, 'en_uso');
  assert.ok(r.markets.dc.b < 0.8, `b = ${r.markets.dc.b}`);
  assert.ok(r.llModel < r.llBase);
  assert.ok(r.nTest > 400 && r.nTest < 550); // 14 de 60 días
  const p = applyModel({ sports: { soccer: r } }, { sport: 'soccer', league: 'laliga', market: 'dc', p: 0.8, x: {} });
  assert.ok(p > 0.62 && p < 0.74, `p = ${p}`);
});

test('fitSport: un modelo bien calibrado casi no cambia', () => {
  const r = fitSport(rows(2000, { seed: 7 }), { now: NOW });
  if (r.status === 'en_uso') {
    assert.ok(Math.abs(r.markets.dc.b - 1) < 0.25 && Math.abs(r.markets.dc.a) < 0.25, JSON.stringify(r.markets.dc));
  } else assert.equal(r.status, 'sin_mejora');
});

test('fitSport: si con pocos partidos pierde más, w.few < 0; si una liga falla más, su c < 0', () => {
  const few = fitSport(rows(2000, { seed: 3, few: (i) => (i % 3 === 0 ? 1 : 0), truth: (p, row) => sig(logit(p) - 1.2 * row.x.few) }), { now: NOW });
  assert.equal(few.status, 'en_uso');
  assert.ok(few.w.few < -0.6, `w.few = ${few.w.few}`);
  const lg = fitSport(rows(2000, { seed: 5, league: (i) => (i % 4 === 0 ? 'ucl' : 'laliga'), truth: (p, row) => sig(logit(p) - (row.league === 'ucl' ? 1 : 0)) }), { now: NOW });
  assert.equal(lg.status, 'en_uso');
  assert.ok(lg.leagues.ucl < -0.4, `c.ucl = ${lg.leagues.ucl}`);
});

test('fitSport: un mercado con menos de 30 filas no lleva a ni b propios', () => {
  const r = fitSport([...rows(2000, { truth: (p) => sig(0.5 * logit(p)) }), ...rows(20, { seed: 9, market: 'btts' })], { now: NOW });
  assert.equal(r.markets.btts, undefined);
});

test('currentModel: sin base → null; guarda en memoria 10 min; ante error o basura queda el último bueno', async () => {
  assert.equal(await currentModel({ db: null, now: NOW }), null);
  const good = learnModel({ soccer: rows(50) }, { now: NOW });
  let calls = 0, answer = good;
  const db = { latestModel: async () => (calls++, typeof answer === 'function' ? answer() : answer) };
  assert.deepEqual(await currentModel({ db, now: NOW }), good);
  await currentModel({ db, now: NOW + 60_000 });
  assert.equal(calls, 1);
  answer = { sports: { soccer: { status: 'roto' } } };
  assert.deepEqual(await currentModel({ db, now: NOW + 11 * 60_000 }), good);
  answer = () => { throw new Error('caído'); };
  assert.deepEqual(await currentModel({ db, now: NOW + 22 * 60_000 }), good);
});
