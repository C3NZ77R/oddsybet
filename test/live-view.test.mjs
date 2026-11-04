// Vista En vivo (public/views/live.js): texto de la calculadora y orden estable entre refrescos. Sin DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcText, keepOrder, sigSort } from '../public/views/live.js';

// Con la línea ya superada el modelo da «Más de» al 100 %: el valor esperado queda fijo por la cuota.
const sig = (side) => ({ kind: 'normal', current: 70, rem: { mean: 10, variance: 20 }, side });

test('calcText: habla del modelo, avisa del atraso y no promete ganancias', () => {
  assert.match(calcText(sig('Over'), {}), /Escribe la línea/);
  const plain = calcText(sig('Over'), { line: '68.5' });
  assert.match(plain, /^Según el modelo de Oddsy/);
  assert.doesNotMatch(plain, /valor esperado/);

  const up = calcText(sig('Over'), { line: '68.5', odds: '2' });
  assert.match(up, /valor esperado con esa cuota es de \+100 %/);
  assert.match(up, /atrasados y el modelo se puede equivocar/);
  assert.doesNotMatch(up, /colchón/);

  const down = calcText(sig('Under'), { line: '68.5', odds: '2' });
  assert.match(down, /es de -100 %/);
  for (const t of [up, down]) assert.doesNotMatch(t, /ganarías|perderías|no conviene/);

  // Entre 0 y 5 % queda dentro del colchón que usa Mejores apuestas.
  assert.match(calcText(sig('Over'), { line: '68.5', odds: '1.03' }), /\+3 %\. Es menos que el colchón del 5 %/);
});

test('keepOrder: lo que ya estaba no se mueve; lo nuevo entra al final según la regla', () => {
  const byLevel = (a, b) => b.level - a.level;
  const sortIds = (prev, xs) => [...xs].sort(keepOrder(prev, (x) => x.id, byLevel)).map((x) => x.id);
  const xs = [{ id: 'a', level: 1 }, { id: 'b', level: 3 }, { id: 'c', level: 2 }];
  assert.deepEqual(sortIds([], xs), ['b', 'c', 'a']); // primera vez: la regla
  const moved = xs.map((x) => (x.id === 'a' ? { ...x, level: 9 } : x));
  assert.deepEqual(sortIds(['b', 'c', 'a'], moved), ['b', 'c', 'a']); // cambió el nivel, no el lugar
  assert.deepEqual(sortIds(['b', 'c', 'a'], [...moved, { id: 'd', level: 0 }, { id: 'e', level: 5 }]), ['b', 'c', 'a', 'e', 'd']);
  assert.deepEqual(sortIds(['b', 'c', 'a'], moved.filter((x) => x.id !== 'c')), ['b', 'a']); // uno terminó
});

test('sigSort: una señal que sube de nivel conserva su lugar; las nuevas van después, por nivel y fuerza', () => {
  const ids = (prev, xs) => [...xs].sort(sigSort(prev)).map((x) => x.id);
  const xs = [{ id: 'a', level: 1, z: 1 }, { id: 'b', level: 2, z: 1 }, { id: 'c', level: 2, z: 3 }];
  const first = ids([], xs);
  assert.deepEqual(first, ['c', 'b', 'a']);
  const up = xs.map((x) => (x.id === 'a' ? { ...x, level: 3 } : x)); // «temprana» pasa a «fuerte»
  assert.deepEqual(ids(first, [...up, { id: 'd', level: 3, z: 1 }, { id: 'e', level: 3, z: 2 }]), ['c', 'b', 'a', 'e', 'd']);
});
