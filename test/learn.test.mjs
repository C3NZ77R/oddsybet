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
