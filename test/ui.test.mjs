import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, esc, raw, fmtOdds, fmtPct, bookInfo, bookChip, hitBar, barChart } from '../public/ui.js';
import { store, encodePicks, decodePicks } from '../public/store.js';

test('fmtOdds: decimal por defecto y americano', () => {
  assert.equal(fmtOdds(2.5, 'american'), '+150');
  assert.equal(fmtOdds(1.5, 'american'), '-200');
  assert.equal(fmtOdds(2, 'american'), '+100');
  assert.equal(fmtOdds(1.909, 'decimal'), '1.91');
  assert.equal(fmtOdds(2.5), '2.50'); // settings.oddsFormat por defecto = decimal
  for (const bad of [null, undefined, 1, 0.5, NaN, 'x']) assert.equal(fmtOdds(bad), '—');
  store.set('settings', { ...store.get('settings'), oddsFormat: 'american' });
  assert.equal(fmtOdds(2.5), '+150');
  store.set('settings', { ...store.get('settings'), oddsFormat: 'decimal' });
});

test('fmtPct', () => {
  assert.equal(fmtPct(0.5), '50.0%');
  assert.equal(fmtPct(0.666, 0), '67%');
  assert.equal(fmtPct(null), '—');
});

test('h escapa los valores, no anida dos veces y une arrays', () => {
  const evil = '<img src=x onerror="alert(1)">';
  assert.equal(String(h`<p>${evil}</p>`), '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
  assert.equal(String(h`<a title="${"' & \""}">`), '<a title="&#39; &amp; &quot;">');
  assert.equal(String(h`<ul>${['<a>', 'b'].map((x) => h`<li>${x}</li>`)}</ul>`), '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
  assert.equal(String(h`${null}${undefined}${false}${0}`), '0');
  assert.equal(String(h`${raw('<b>ok</b>')}`), '<b>ok</b>');
  assert.equal(esc(h`<i>x</i>`), '<i>x</i>'); // un Safe no se vuelve a escapar
});

test('bookInfo normaliza claves y títulos; bookChip escapa casas desconocidas', () => {
  assert.equal(bookInfo('williamhill_us').name, 'Caesars');
  assert.equal(bookInfo('DraftKings').key, 'draftkings');
  assert.equal(bookInfo('LowVig.ag').key, 'lowvig');
  assert.equal(bookInfo('unibet_eu').key, 'unibet');
  assert.equal(bookInfo('').name, 'Sin casa');
  const chip = String(bookChip('<script>'));
  assert.ok(!chip.includes('<script>'));
  assert.ok(chip.includes('&lt;script&gt;'));
});

test('hitBar: 10 segmentos y % de acierto sin contar pushes', () => {
  const s = String(hitBar([true, false, null, true], { label: true }));
  assert.equal((s.match(/<i class=/g) || []).length, 10);
  assert.match(s, /Acierto 67% \(2 de 3\)/);
  assert.match(String(hitBar(0.7)), /Acierto 70%/);
  assert.match(String(hitBar(null)), /Sin datos/);
});

test('barChart: título accesible, línea discontinua y colores por lado', () => {
  const s = String(barChart({ values: [10, 30, 24.5], labels: ['a', 'b', 'c'], line: 24.5, title: 'Puntos <L3>' }));
  assert.match(s, /<title id="[^"]+">Puntos &lt;L3&gt;<\/title>/);
  assert.match(s, /stroke-dasharray/);
  assert.match(s, /fill="var\(--err\)"/);
  assert.match(s, /fill="var\(--pos\)"/);
  assert.match(s, /fill="var\(--muted\)"/); // igual a la línea = push
});

test('compartir: encode/decode ida y vuelta con tildes', () => {
  const picks = [
    { id: 'p1', label: 'Peña Más de 2.5 goles', price: 1.91, book: 'wplay', league: 'colombia', gameId: '123', addedAt: 1 },
    { id: 'p2', label: 'LeBron James Over 24.5', price: 2.1, book: 'fanduel', league: 'nba', gameId: null },
  ];
  const s = encodePicks(picks);
  assert.match(s, /^[A-Za-z0-9_-]+$/); // seguro en una URL
  assert.deepEqual(decodePicks(s), picks.map(({ addedAt, ...p }) => p));
});

test('compartir: decode descarta entradas inválidas', () => {
  const enc = (v) => btoa(JSON.stringify(v));
  assert.deepEqual(decodePicks('%%%no-base64'), []);
  assert.deepEqual(decodePicks(enc({ a: 1 })), []);
  assert.deepEqual(decodePicks(''), []);
  assert.deepEqual(decodePicks(enc([['id', 'label', 'no-num'], ['id2', 'ok', 0.5], [5, 'x', 2], ['id3', 'bien', 3, { x: 1 }]])), [
    { id: 'id3', label: 'bien', price: 3, book: null, league: null, gameId: null },
  ]);
  assert.equal(decodePicks(enc(Array.from({ length: 80 }, (_, i) => [`id${i}`, 'x', 2]))).length, 50);
});

test('compartir: decode ignora ids repetidos (un enlace armado no duplica picks)', () => {
  const enc = (v) => btoa(JSON.stringify(v));
  assert.deepEqual(decodePicks(enc([['a', 'A', 2], ['a', 'A otra vez', 3], ['b', 'B', 2]])).map((p) => [p.id, p.label]), [['a', 'A'], ['b', 'B']]);
});

test('store: track guarda solo los 300 props vistos más recientemente', () => {
  store.set('views', Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { view: 1, add: 0, last: i }])));
  try {
    store.track('nuevo');
    const views = store.get('views');
    assert.equal(Object.keys(views).length, 300);
    assert.ok(views.nuevo && views.k399 && views.k101);
    assert.ok(!views.k100 && !views.k0);
  } finally { store.set('views', {}); }
});

test('store: addPick reemplaza por id, removePick y track', () => {
  store.set('picks', []);
  store.addPick({ id: 'a', label: 'A', price: 2 });
  store.addPick({ id: 'a', label: 'A2', price: 2.2 });
  assert.equal(store.get('picks').length, 1);
  assert.equal(store.get('picks')[0].label, 'A2');
  assert.ok(store.hasPick('a'));
  let seen = null;
  const off = store.on('picks', (v) => { seen = v; });
  store.removePick('a');
  off();
  assert.deepEqual(seen, []);
  store.track('k1', 'view');
  store.track('k1', 'add');
  store.track('k1', 'view');
  assert.equal(store.get('views').k1.view, 2);
  assert.equal(store.get('views').k1.add, 1);
});

test('ficha de tenis: encabezado con nombre y Elo; marcador, games y % de más de X games', async () => {
  const { normScoreboard, eloFrom } = await import('../lib/tennis.mjs');
  const { headHtml, perspective, hitsHtml } = await import('../public/views/tennis-player.js');
  const { readFileSync } = await import('node:fs');
  const matches = normScoreboard(JSON.parse(readFileSync(new URL('./fixtures/atp-month.json', import.meta.url), 'utf8')));
  const id = '2375';
  const mine = matches.filter((m) => m.a.id === id || m.b.id === id);
  const player = { id, name: 'Alexander <Zverev>', country: 'Germany', flag: null };
  const s = String(headHtml({ player, rank: 2, points: 9720, elo: eloFrom(matches).get(id) }));
  assert.match(s, /Alexander &lt;Zverev&gt;/);
  assert.match(s, /Elo/);
  assert.match(s, /#2/);
  const final = perspective(matches.find((m) => m.id === '182677'), '9250'); // Shelton perdió la final 3-6 6-7 7-5 2-6
  assert.equal(final.score, '3-6 6-7(2) 7-5 2-6');
  assert.equal(final.sets, '1-3');
  assert.deepEqual([final.total_games, final.games_won, final.sets_won], [42, 18, 1]);
  assert.equal(final.won, false);
  const rows = mine.map((m) => perspective(m, id));
  const valid = rows.filter((r) => !r.retired);
  for (const [stat, line] of [['total_games', 22.5], ['games_won', 12.5], ['sets_won', 1.5]]) {
    const k = valid.slice(0, 5).filter((r) => r[stat] > line).length;
    assert.match(String(hitsHtml(rows, stat, line)), new RegExp(`${k} de ${Math.min(5, valid.length)}`), stat);
  }
});

test('Partidos: la tabla de mercados muestra probabilidad, Justa y Oddsy de cada selección', async () => {
  const { marketTables } = await import('../public/views/games.js');
  const { marketsFor } = await import('../lib/markets.mjs');
  const markets = marketsFor('basketball', { kind: 'normal', mu: 3, sigma: 14, total: 220, sigmaT: 19.4 });
  const d = { id: '1', home: { abbr: 'DET', name: 'Pistons' }, away: { abbr: 'BOS', name: 'Celtics' } };
  const ctx = { picks: [], store, league: 'nba' };
  const html = marketTables(d, { data: { markets }, accuracy: { n: 616, brier: 0.2159, baseline: { brier: 0.2475 } } }, ctx);
  assert.match(html, /Justa/);
  assert.match(html, /Oddsy/);
  const [home] = markets.find((m) => m.key === 'ml').selections;
  assert.ok(html.includes(`DET`) && html.includes(fmtOdds(home.fair)) && html.includes(fmtOdds(home.oddsy)));
  assert.match(html, /Brier 0\.216 en 616 partidos/);
  // Cada mercado explica qué se apuesta y marca la opción más probable.
  const t = markets.find((m) => m.key === 'ou').selections[0].line;
  assert.ok(html.includes(`Se cuentan los puntos de los dos equipos. Más ${t} gana si hay ${Math.ceil(t)} o más`));
  assert.match(html, /A DET se le (restan|suman) \d/);
  assert.equal(html.match(/Más probable/g).length, markets.length);
  assert.equal(ctx.picks.length, markets.flatMap((m) => m.selections).length);
  assert.ok(ctx.picks.every((p) => p.book === 'oddsy'));
});

test('Mejores apuestas: si falla un día se muestran los otros; si falla todo, error', async () => {
  const { default: view } = await import('../public/views/picks.js');
  const game = { id: 'g1', start: '2099-01-01T00:00:00Z', status: { state: 'pre' }, home: { name: 'Millonarios' }, away: { name: 'Nacional' } };
  const fakeApi = (okDays) => {
    const seen = [];
    const day = (d) => (seen.includes(d) || seen.push(d), seen.indexOf(d));
    const fail = () => Promise.reject(new Error('caído'));
    return {
      games: async (lg, d) => (okDays.includes(day(d)) ? { data: [game] } : fail()),
      get: async (path, { date }) => (okDays.includes(day(date)) ? { accuracy: { publish: true }, data: [{ gameId: 'g1', picks: [{ market: 'ml', name: 'Local', p: 0.6, minOdds: 1.8 }] }] } : fail()),
    };
  };
  const el = {};
  await view.render(el, { api: fakeApi([0]), leagueInfo: { id: 'colombia', title: 'Liga BetPlay' } });
  assert.match(String(el.innerHTML), /Gana Millonarios/);
  await assert.rejects(view.render({}, { api: fakeApi([]), leagueInfo: { id: 'colombia', title: 'Liga BetPlay' } }), /caído/);
});

test('Tendencias: el rango de cuotas acepta «−» (U+2212) y «+» al inicio', async () => {
  const { americanIn } = await import('../public/views/insights.js');
  assert.equal(americanIn('−300'), -300);
  assert.equal(americanIn('+200'), 200);
  assert.equal(americanIn(' -150 '), -150);
  for (const blank of ['', '  ', null, '-', 'abc']) assert.equal(americanIn(blank), null);
});

test('Props: la línea por defecto del detalle es la misma que la del servidor (propLine)', async () => {
  const { medianLine } = await import('../public/views/props.js');
  const { propLine } = await import('../lib/props.mjs');
  // Del más reciente al más viejo: los 10 primeros bajos y los 15 siguientes altos (la mediana de 10 y la de 20 difieren).
  const vals = [...Array(10).fill(3), ...Array(15).fill(20)];
  assert.equal(medianLine(vals), propLine(vals).line);
  for (const v of [[7, 9, 8, 12, 5, 6, 11, 10], [0, 0, 1, 0, 2, 0, 0, 1, 0]]) assert.equal(medianLine(v), propLine(v).line);
  assert.equal(medianLine([]), 0.5);
});

test('picks del día: dayText resume las apuestas más probables para WhatsApp', async () => {
  const { dayText } = await import('../public/views/picks.js');
  const g = { home: { name: 'Millonarios' }, away: { name: 'Nacional' } };
  const rows = [[g, [{ market: '1x2', name: 'Millonarios', p: 0.55, minOdds: 1.85 }, { market: 'total', label: 'Total', name: 'Más de 2.5', p: 0.6, minOdds: 1.7 }]]];
  const t = dayText('Liga BetPlay', rows);
  assert.match(t, /Liga BetPlay/);
  assert.ok(t.indexOf('Más de 2.5') < t.indexOf('Gana Millonarios')); // la más probable primero
});
