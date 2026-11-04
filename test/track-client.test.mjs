// Seguimiento: cliente del navegador (public/track.js) y armado de la apuesta en la vista (public/views/seguir.js). Sin DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushSupport, b64ToBytes } from '../public/track.js';
import { rowsOf, payloadOf, listFailed } from '../public/views/seguir.js';

test('pushSupport: iPhone sin instalar, permiso negado y navegadores sin push', () => {
  assert.equal(pushSupport({ standalone: false, hasPush: true, ios: true, permission: 'default' }), 'ios-install');
  assert.equal(pushSupport({ standalone: false, hasPush: false, ios: true, permission: 'default' }), 'ios-install');
  assert.equal(pushSupport({ standalone: true, hasPush: true, ios: true, permission: 'default' }), 'ok');
  assert.equal(pushSupport({ standalone: false, hasPush: true, ios: false, permission: 'denied' }), 'denied');
  assert.equal(pushSupport({ standalone: false, hasPush: false, ios: false, permission: 'default' }), 'unsupported');
  assert.equal(pushSupport({ standalone: false, hasPush: true, ios: false, permission: 'granted' }), 'ok');
});

test('b64ToBytes: llave VAPID pública de 65 bytes que empieza en 4', () => {
  const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  const bytes = b64ToBytes(key);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
});

test('rowsOf y payloadOf: del borrador leído a lo que se manda al servidor', () => {
  const draft = [
    { gameId: '401', market: 'prop', stat: 'pts', athleteId: '3112335', athleteName: 'Nikola Jokić', side: 'Over', line: 24.5, odds: 1.85, label: 'Jokić · Más de 24.5 puntos', tracked: true, reason: null },
    { gameId: '401', market: 'prop', stat: 'reb', athleteId: null, athleteName: 'J. Green', side: 'Over', line: 6.5, odds: null, label: 'J. Green Más de 6,5 reb', tracked: false, reason: 'Hay varios jugadores con ese nombre' },
    { gameId: null, market: 'other', stat: null, side: null, line: null, odds: null, label: 'Primer cuarto: Nuggets', tracked: false, reason: 'Mercado que Oddsy no sigue' },
  ];
  const rows = rowsOf(draft);
  assert.equal(rows[0].fixed, false);
  assert.equal(rows[1].fixed, false); // se puede corregir eligiendo el jugador
  assert.equal(rows[1].reason, 'Hay varios jugadores con ese nombre');
  assert.equal(rows[2].fixed, true); // no se sigue: se ve con su motivo

  rows[1].athleteId = 'g2';
  rows[1].line = '6,5';
  rows[1].odds = '-110';
  const out = payloadOf(rows);
  assert.deepEqual(out[0], { market: 'prop', gameId: '401', stat: 'pts', athleteId: '3112335', side: 'Over', line: 24.5, odds: 1.85 });
  assert.deepEqual(out[1], { market: 'prop', gameId: '401', stat: 'reb', athleteId: 'g2', side: 'Over', line: 6.5, odds: '-110' });
  assert.deepEqual(out[2], { market: 'other', label: 'Primer cuarto: Nuggets', status: 'no_seguida' });

  const ml = payloadOf([{ ...rowsOf([{ gameId: '401', market: 'ml', side: 'away', line: null, odds: '2,10', tracked: true }])[0] }]);
  assert.deepEqual(ml[0], { market: 'ml', gameId: '401', side: 'away', odds: '2,10' });
});

test('payloadOf: línea vacía no se manda como 0; Sí/No va con 0.5', () => {
  const row = (o) => rowsOf([{ gameId: '401', market: 'prop', stat: 'pts', athleteId: '9', side: 'Over', line: null, odds: null, tracked: true, ...o }])[0];
  assert.equal(payloadOf([row()])[0].line, null);
  assert.equal(payloadOf([{ ...row(), line: '  ' }])[0].line, null);
  assert.equal(payloadOf([{ ...row(), line: '0' }])[0].line, 0);
  assert.equal(payloadOf([{ ...row({ stat: 'dd' }), line: '' }])[0].line, 0.5);
});

test('listFailed: con lista ya pintada la conserva y avisa una sola vez; sin lista muestra el error', () => {
  const box = (hasList) => {
    const b = { innerHTML: '', textContent: '', notes: 0, err: false };
    const title = { insertAdjacentHTML: (pos, html) => { assert.equal(pos, 'afterend'); assert.match(html, /data-listerr/); b.notes++; b.err = true; } };
    b.querySelector = (sel) => (sel === '#sgListTitle' ? (hasList ? title : null) : sel === '[data-listerr]' && b.err ? {} : null);
    return b;
  };
  const kept = box(true);
  kept.innerHTML = 'lista';
  listFailed(kept, new Error('Sin conexión'));
  listFailed(kept, new Error('Sin conexión'));
  assert.equal(kept.innerHTML, 'lista');
  assert.equal(kept.notes, 1);

  const none = box(false);
  listFailed(none, new Error('Sin <conexión>'));
  assert.match(String(none.innerHTML), /role="alert">Sin &lt;conexión&gt;</);
});

test('trackApi: una petición colgada se corta a los 30 s con un error claro', async (t) => {
  const { trackApi } = await import('../public/track.js');
  const real = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))));
  try {
    const p = trackApi.listBets();
    t.mock.timers.tick(30_000);
    await assert.rejects(p, /tardó demasiado/);
  } finally { globalThis.fetch = real; }
});
