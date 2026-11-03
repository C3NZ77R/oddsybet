// Seguimiento: leer el ticket con Gemini (fetch simulado) y cruzar las selecciones con ESPN (lib/ticket.mjs). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL, TICKET_SCHEMA, readTicket, norm, parseNum, matchLegs } from '../lib/ticket.mjs';

const reply = (status, body) => async (url, init) => {
  reply.last = { url, init, body: JSON.parse(init.body) };
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};
const gemini = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('readTicket: arma la petición a Gemini y devuelve el JSON', async () => {
  const out = { book: 'Betplay', odds: '3,40', legs: [{ text: 'Jokić Más de 24,5 puntos', sport: 'basketball', teams: [], market: 'prop' }] };
  const r = await readTicket({ image: 'QUJD' }, { key: 'k1', fetch: reply(200, gemini(JSON.stringify(out))) });
  assert.deepEqual(r, out);
  const { url, init, body } = reply.last;
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
  assert.equal(init.headers['x-goog-api-key'], 'k1');
  assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, TICKET_SCHEMA);

  await readTicket({ text: 'Jokić +24.5' }, { key: 'k1', fetch: reply(200, gemini(JSON.stringify(out))) });
  assert.ok(reply.last.body.contents[0].parts[1].text.includes('Jokić +24.5'));
});

test('readTicket: cuota agotada → 429; respuesta rara → 502', async () => {
  await assert.rejects(readTicket({ text: 'x' }, { key: 'k', fetch: reply(429, { error: { status: 'RESOURCE_EXHAUSTED' } }) }), (e) => e.status === 429);
  await assert.rejects(readTicket({ text: 'x' }, { key: 'k', fetch: reply(200, gemini('no es json')) }), (e) => e.status === 502);
  await assert.rejects(readTicket({ text: 'x' }, { key: 'k', fetch: reply(500, 'caído') }), (e) => e.status === 502);
  await assert.rejects(readTicket({ text: 'x' }, { key: 'k', fetch: async () => { throw new Error('red'); } }), (e) => e.status === 502);
});

test('norm y parseNum', () => {
  assert.equal(norm('  N. Jokić '), 'n jokic');
  assert.equal(parseNum('24,5'), 24.5);
  assert.equal(parseNum('Más de 24,5'), 24.5);
  assert.equal(parseNum('−110'), -110);
  assert.equal(parseNum(8.5), 8.5);
  assert.equal(parseNum(null), null);
});

// Partido de hoy: Lakers (visitante) en Denver.
const game = (state = 'pre') => ({ id: '401', start: '2026-11-03T02:00:00Z', status: { state }, home: { id: '7', abbr: 'DEN', name: 'Denver Nuggets' }, away: { id: '13', abbr: 'LAL', name: 'Los Angeles Lakers' } });
const rosters = new Map([
  ['7', [{ id: '3112335', name: 'Nikola Jokić', short: 'N. Jokić', teamId: '7' }, { id: 'g1', name: 'Jeff Green', short: 'J. Green', teamId: '7' }]],
  ['13', [{ id: '1966', name: 'LeBron James', short: 'L. James', teamId: '13' }, { id: 'g2', name: 'Jalen Green', short: 'J. Green', teamId: '13' }]],
]);
const raw = (o) => ({ text: 'ticket', sport: 'basketball', teams: ['Nuggets', 'Lakers'], team: null, player: null, market: 'prop', stat: 'pts', side: 'Over', line: '24,5', odds: '1,85', ...o });
const one = (o, state) => matchLegs([raw(o)], [game(state)], rosters)[0];

test('matchLegs: prop de jugador con inicial o nombre completo', () => {
  for (const player of ['N. Jokic', 'Nikola Jokić']) {
    const d = one({ player });
    assert.equal(d.tracked, true, d.reason);
    assert.equal(d.athleteId, '3112335');
    assert.equal(d.gameId, '401');
    assert.equal(d.line, 24.5);
    assert.equal(d.odds, 1.85);
    assert.equal(d.label, 'Jokić · Más de 24.5 puntos');
  }
  const dd = one({ player: 'Jokic', stat: 'dd', line: 0.5, teams: [] });
  assert.equal(dd.tracked, true, dd.reason);
  assert.equal(dd.label, 'Jokić · Doble-doble: Sí');
});

test('matchLegs: motivos de no seguir', () => {
  assert.equal(one({ sport: 'other' }).reason, 'No es de la NBA');
  assert.equal(one({ market: 'other' }).reason, 'Mercado que Oddsy no sigue');
  assert.equal(one({ player: 'Jokic', teams: ['Celtics', 'Knicks'] }).reason, 'No encontré el partido');
  assert.equal(one({ player: 'Michael Jordan' }).reason, 'No encontré al jugador');
  const twins = one({ player: 'J. Green' });
  assert.equal(twins.reason, 'Hay varios jugadores con ese nombre');
  assert.equal(twins.candidates.length, 2);
  assert.equal(twins.tracked, false);
  assert.equal(one({ player: 'Jokic' }, 'post').reason, 'El partido ya terminó');
  assert.equal(one({ player: 'Jokic' }, 'in').tracked, true); // en vivo sí se puede registrar
});

test('matchLegs: ganador, hándicap y total', () => {
  const ml = one({ market: 'ml', stat: null, side: null, line: null, team: 'Lakers' });
  assert.equal(ml.tracked, true, ml.reason);
  assert.equal(ml.side, 'away');
  assert.equal(ml.label, 'Gana Lakers');
  const sp = one({ market: 'spread', stat: null, side: null, line: '-5,5', team: 'DEN' });
  assert.equal(sp.side, 'home');
  assert.equal(sp.line, -5.5);
  assert.equal(sp.label, 'Nuggets -5.5');
  const tot = one({ market: 'total', stat: null, side: 'Under', line: '221,5', teams: ['LA Lakers', 'Denver'] });
  assert.equal(tot.tracked, true, tot.reason);
  assert.equal(tot.label, 'Menos de 221.5 puntos en Lakers vs Nuggets');
});

test('matchLegs: apellidos con Jr. o III y dos partidos entre los mismos equipos', () => {
  const r2 = new Map([['7', [{ id: 'j1', name: 'Jaren Jackson Jr.', short: 'J. Jackson Jr.', teamId: '7' }]], ['13', []]]);
  for (const player of ['Jaren Jackson', 'J. Jackson', 'Jaren Jackson Jr.', 'J. Jackson Jr.']) {
    const d = matchLegs([raw({ player })], [game()], r2)[0];
    assert.equal(d.athleteId, 'j1', player);
    assert.equal(d.label, 'Jackson · Más de 24.5 puntos');
  }
  const ended = { ...game('post'), id: '300', start: '2026-11-01T02:00:00Z' };
  const next = { ...game('pre'), id: '402', start: '2026-11-05T02:00:00Z' };
  const later = { ...game('pre'), id: '403', start: '2026-11-07T02:00:00Z' };
  assert.equal(matchLegs([raw({ player: 'Jokic' })], [ended, later, next], rosters)[0].gameId, '402'); // el próximo sin terminar
  assert.equal(matchLegs([raw({ player: 'Jokic' })], [ended], rosters)[0].reason, 'El partido ya terminó'); // solo hay uno y ya terminó
});
