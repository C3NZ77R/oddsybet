// Shell: boleto, enlace compartido y toast (public/shell.js). Sin DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RG_LINE, importPicks, exclusivePairs, slipModel, slipText, toastMs, hasUserInput } from '../public/shell.js';
import { propKey } from '../public/ui.js';

const game = (side, key = 'ml', label = 'Ganador') => ({ id: `oddsy:nba:401:${key}:${label}:${side}`, label: `${side} (${label})`, price: 1.9, book: 'oddsy' });
const prop = (o, l, player = 'Jokić') => ({ id: propKey({ athleteId: player === 'Jokić' ? 1 : 2, player, stat: 'pts', line: l, side: o, gameId: '401' }), label: `${player} ${o} ${l}`, price: 1.8, book: 'oddsy' });

test('importPicks: los picks del enlace quedan marcados como compartidos y no repiten ni pasan el tope', () => {
  const add = importPicks([{ id: 'a' }], [{ id: 'a', label: 'x', price: 2 }, { id: 'b', label: 'Fija 100%', price: 25 }, { id: 'c', label: 'y', price: 3 }], 2);
  assert.deepEqual(add.map((p) => [p.id, p.shared]), [['b', true]]);
});

test('exclusivePairs: lados del mismo mercado, Más y Menos incompatibles; la doble oportunidad no', () => {
  assert.equal(exclusivePairs([game('Local'), game('Visitante')]).length, 1);
  assert.equal(exclusivePairs([game('Local'), game('Más', 'ou', 'Total de puntos 226.5')]).length, 0);
  assert.equal(exclusivePairs([game('Local o empate', 'dc', 'Doble oportunidad'), game('Empate o visitante', 'dc', 'Doble oportunidad')]).length, 0);
  assert.equal(exclusivePairs([prop('Over', 24.5), prop('Under', 24.5)]).length, 1);
  assert.equal(exclusivePairs([prop('Over', 25.5), prop('Under', 20.5)]).length, 1);
  assert.equal(exclusivePairs([prop('Over', 20.5), prop('Under', 25.5)]).length, 0); // 21 a 25 gana las dos
  assert.equal(exclusivePairs([prop('Over', 24.5), prop('Under', 24.5, 'Murray')]).length, 0);
});

test('slipModel: los compartidos no entran en la combinada y dos picks excluyentes la anulan', () => {
  const shared = { ...game('Visitante', 'spread', 'Hándicap local -5.5'), price: 50, shared: true };
  const m = slipModel([game('Local'), shared]);
  assert.equal(m.own.length, 1);
  assert.equal(m.shared.length, 1);
  assert.equal(m.total, 1.9);
  const bad = slipModel([game('Local'), game('Visitante')]);
  assert.equal(bad.conflicts.length, 1);
  assert.equal(bad.total, null);
});

test('slipText: lleva el enlace y la línea de juego responsable', () => {
  const t = slipText([game('Local')], 'https://x/#/share?p=1', (x) => x.toFixed(2));
  assert.match(t, /Local \(Ganador\) @ 1\.90/);
  assert.ok(t.includes('https://x/#/share?p=1'));
  assert.ok(t.endsWith(RG_LINE));
  assert.match(RG_LINE, /^\+18\./);
});

test('toastMs: mínimo 7 s y más tiempo para textos largos', () => {
  assert.equal(toastMs('Enlace copiado.'), 7000);
  assert.equal(toastMs('x'.repeat(200)), 12000);
});

test('hasUserInput: texto, casilla o lista cambiada cuentan; vacío, radios y deshabilitados no', () => {
  const root = (...els) => ({ querySelectorAll: () => els });
  assert.equal(hasUserInput(root({ type: 'text', value: '  ' }, { type: 'radio', checked: true }, { tagName: 'SELECT', selectedIndex: 0 }, { type: 'checkbox', checked: false })), false);
  assert.equal(hasUserInput(root({ type: 'text', value: '1.85', disabled: true })), false);
  assert.equal(hasUserInput(root({ type: 'text', value: '-110' })), true);
  assert.equal(hasUserInput(root({ tagName: 'TEXTAREA', value: 'Ticket' })), true);
  assert.equal(hasUserInput(root({ tagName: 'SELECT', selectedIndex: 2 })), true);
  assert.equal(hasUserInput(root({ type: 'checkbox', checked: true })), true);
  assert.equal(hasUserInput(null), false);
});

test('exclusivePairs: en un mercado de varias líneas (tarjetas) la línea va en el id: Más 3.5 y Menos 5.5 pueden ganar juntas', () => {
  const card = (side, l) => game(side, 'cards_ou', `Tarjetas: total ${l}`);
  assert.equal(exclusivePairs([card('Más', 3.5), card('Menos', 5.5)]).length, 0); // 4 o 5 tarjetas ganan las dos
  assert.equal(exclusivePairs([card('Más', 3.5), card('Menos', 3.5)]).length, 1);
  assert.notEqual(card('Más', 3.5).id, card('Más', 4.5).id); // tocar Más 4.5 no quita Más 3.5 del boleto
});
