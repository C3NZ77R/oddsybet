import test from 'node:test';
import assert from 'node:assert/strict';
import { findPicks, filterPicks, normName, verdictOf, oddsNote } from '../lib/predict.mjs';

const game = (id, home, away, state = 'pre') => ({ id, start: '2026-11-11T20:00:00Z', status: { state }, home: { name: home }, away: { name: away } });
const pick = (p, extra = {}) => ({ market: '1x2', label: '1X2', name: 'Local', line: null, side: 0, raw: p, p, fair: +(1 / p).toFixed(2), minOdds: Math.ceil(Math.round(10500 / p) / 100) / 100, record: { hit: 0.8, n: 40 }, ...extra });
const picksOf = async (league) => ({ data: league === 'colombia'
  ? [{ gameId: 'c1', x: {}, picks: [pick(0.82, { featured: true }), pick(0.55, { market: 'ou', label: 'Total de goles 2.5', name: 'Más', line: 2.5 })] }, { gameId: 'c2', x: {}, picks: [pick(0.9)] }]
  : [] });
const gamesOf = async (league) => (league === 'colombia' ? [game('c1', 'Atlético Nacional', 'Millonarios'), game('c2', 'Junior', 'Cali', 'in')] : []);

test('findPicks une nombres, texto del pick y ordena por probabilidad', async () => {
  const r = await findPicks({ league: 'colombia' }, { picksOf, gamesOf });
  assert.deepEqual(r.leagues, ['colombia']);
  assert.equal(r.picks.length, 1); // c2 ya empezó: fuera; de c1 solo el pick más probable
  assert.equal(r.picks[0].game, 'Atlético Nacional vs Millonarios');
  assert.equal(r.picks[0].verdict, 'segura');
  assert.equal(r.picks[0].pick, 'Gana Atlético Nacional');
  assert.deepEqual([r.picks[0].p, r.picks[0].minOdds, r.picks[0].fair, r.picks[0].record.n], [0.82, 1.29, 1.22, 40]);
  const ou = await findPicks({ league: 'colombia', market: 'ou' }, { picksOf, gamesOf });
  assert.equal(ou.picks[0].pick, 'Total de goles 2.5: Más'); // la etiqueta del mercado ya trae la línea
  assert.equal(ou.picks[0].verdict, 'arriesgada');
});

test('findPicks filtra por probabilidad (acepta 80 o 0.8), equipo sin tildes y mercado', async () => {
  assert.equal((await findPicks({ league: 'colombia', minP: 80 }, { picksOf, gamesOf })).picks.length, 1);
  assert.equal((await findPicks({ league: 'colombia', minP: 0.8 }, { picksOf, gamesOf })).picks.length, 1);
  assert.equal((await findPicks({ league: 'colombia', team: 'nacional' }, { picksOf, gamesOf })).picks.length, 1);
  assert.equal((await findPicks({ league: 'colombia', team: 'Millos' }, { picksOf, gamesOf })).picks.length, 0);
  assert.equal((await findPicks({ league: 'colombia', market: 'ou' }, { picksOf, gamesOf })).picks[0].market, 'ou');
});

test('findPicks consulta todas las ligas, ignora la que falla y devuelve vacío sin partidos', async () => {
  const failing = async (league) => { if (league === 'nba') throw new Error('403'); return picksOf(league); };
  const r = await findPicks({}, { picksOf: failing, gamesOf });
  assert.ok(!r.leagues.includes('nba'));
  assert.ok(r.leagues.includes('colombia'));
  assert.equal(r.picks.length, 1);
  assert.equal(r.day.length, 10);
  assert.deepEqual((await findPicks({ league: 'epl' }, { picksOf, gamesOf })).picks, []);
});

test('findPicks recorta a MAX_PICKS y pasa el día y el modelo', async () => {
  let seen;
  const many = async (league, opts) => { seen = opts; return { data: Array.from({ length: 12 }, (_, i) => ({ gameId: `g${i}`, x: {}, picks: [pick(0.6 + i / 100)] })) }; };
  const games = async () => Array.from({ length: 12 }, (_, i) => game(`g${i}`, `A${i}`, `B${i}`));
  const r = await findPicks({ league: 'epl', day: 'mañana' }, { picksOf: many, gamesOf: games, model: { x: 1 }, now: Date.parse('2026-11-11T12:00:00-05:00') });
  assert.equal(r.picks.length, 8);
  assert.equal(seen.date, '20261112');
  assert.deepEqual(seen.model, { x: 1 });
});

test('normName y filterPicks son puros', () => {
  assert.equal(normName('  Atlético  NACIONAL '), 'atletico nacional');
  assert.equal(filterPicks([{ p: 0.5, game: 'A vs B', market: 'ou' }], { minP: 0.6 }).length, 0);
});

test('verdictOf y oddsNote: umbrales fijos y aviso cuando la cuota pedida supera la justa', () => {
  assert.deepEqual([verdictOf(0.8), verdictOf(0.79), verdictOf(0.6), verdictOf(0.59)], ['segura', 'posible', 'posible', 'arriesgada']);
  assert.equal(oddsNote([{ p: 0.82, fair: 1.22 }], 1.7), 'Ningún pick llega a la cuota 1.70 con su probabilidad: a 82 % la cuota justa ronda 1.22. Una casa rara vez paga más que la justa.');
  assert.equal(oddsNote([{ p: 0.82, fair: 1.22 }], 1.2), '');
  assert.equal(oddsNote([], 1.7), '');
  const r = findPicks({ league: 'colombia', odds: 1.7 }, { picksOf, gamesOf });
  return r.then((x) => assert.match(x.note, /cuota justa ronda 1.22/));
});

test('findPicks con sport consulta solo las ligas de ese deporte', async () => {
  const asked = [];
  const spy = async (league) => (asked.push(league), picksOf(league));
  await findPicks({ sport: 'tennis' }, { picksOf: spy, gamesOf });
  assert.deepEqual(asked, ['atp', 'challenger']);
});
