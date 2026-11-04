// Estadio en vivo: presión, calor, rachas y zonas de tiro (public/estadio.js). Sin red ni DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../public/estadio.js';
const P = (o) => ({ id: String(o.seq ?? 1), seq: 1, t: 0, kind: 'other', side: 'home', x: null, y: null, pts: 0, made: null, zone: null, ...o });

test('danger: pesa el tipo y la cercanía al arco rival', () => {
  assert.equal(T.danger(P({ kind: 'goal', x: 90 })), 5 * 1.4);
  assert.equal(T.danger(P({ kind: 'shot-on', side: 'away', x: 10 })), 3 * 1.4); // el visitante ataca hacia 0
  assert.equal(T.danger(P({ kind: 'foul', x: 50 })), 0); // falta lejos del área
  assert.equal(T.danger(P({ kind: 'foul', x: 70 })), 1 * 1.2);
  assert.equal(T.danger(P({ kind: 'corner' })), 1.5); // sin posición: factor 1
  assert.equal(T.danger(P({ kind: 'sub' })), 0);
});

test('momentum: tramos de 5 min con la presión de cada lado', () => {
  const m = T.momentum([P({ seq: 1, t: 100, kind: 'corner' }), P({ seq: 2, t: 400, kind: 'corner', side: 'away' })]);
  assert.equal(m.length, 18);
  assert.deepEqual(m[0], { t0: 0, home: 1.5, away: 0 });
  assert.deepEqual(m[1], { t0: 300, home: 0, away: 1.5 });
});

test('runs: rachas de 8 o más puntos sin respuesta', () => {
  const s = (seq, side, pts) => P({ seq, side, pts, made: true, kind: 'shot' });
  const r = T.runs([s(1, 'home', 2), s(2, 'away', 3), s(3, 'away', 3), s(4, 'away', 2), s(5, 'home', 2)]);
  assert.deepEqual(r, [{ side: 'away', pts: 8, fromSeq: 2, toSeq: 4 }]);
  assert.deepEqual(T.runs([s(1, 'home', 3), s(2, 'home', 3), s(3, 'home', 2)]), [{ side: 'home', pts: 8, fromSeq: 1, toSeq: 3 }]); // racha abierta
});

test('heat: densidad normalizada por lado', () => {
  const g = T.heat([P({ x: 1, y: 1 }), P({ x: 1, y: 1 }), P({ x: 99, y: 99 }), P({ side: 'away', x: 50, y: 50 })], 'home');
  assert.equal(g.length, 8);
  assert.equal(g[0].length, 12);
  assert.equal(g[0][0], 1);
  assert.equal(g[7][11], 0.5);
});

test('bordes: tiempo añadido, datos sin posición o rotos y listas vacías', () => {
  const m = T.momentum([P({ kind: 'corner', t: 5500 }), P({ kind: 'corner', t: 1e12 }), P({ kind: 'corner', t: null }), P({ kind: 'corner', side: null, t: 10 })]);
  assert.equal(m.length, 19); // el tiempo añadido abre un tramo; t roto, nulo o sin lado no
  assert.deepEqual(m[18], { t0: 5400, home: 1.5, away: 0 });
  assert.equal(T.danger(P({ kind: 'foul' })), 0); // falta sin posición: no se sabe si fue cerca del área
  assert.deepEqual(T.runs([P({ side: 'home', pts: 3 }), P({ side: 'away', pts: 2 })]), []);
  assert.deepEqual(T.heat([], 'home').flat().filter(Boolean), []);
  assert.equal(T.heat([P({ x: 100, y: 0 })], 'home')[0][11], 1); // 100 cae en la última celda
  assert.deepEqual(T.newPlays(new Set(), [P({ id: 'a' })], 0), []);
});

test('shotZones y newPlays', () => {
  const z = T.shotZones([P({ kind: 'shot', zone: 'paint', made: true }), P({ kind: 'shot', zone: 'paint', made: false }), P({ kind: 'shot', zone: 'arc3', side: 'away', made: true })], 'home');
  assert.deepEqual(z.paint, { made: 1, att: 2 });
  assert.deepEqual(z.arc3, { made: 0, att: 0 });
  const plays = [1, 2, 3, 4].map((seq) => P({ seq, id: `p${seq}` }));
  assert.deepEqual(T.newPlays(new Set(['p1']), plays, 2).map((p) => p.id), ['p3', 'p4']);
});
