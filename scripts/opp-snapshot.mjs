// Genera data/opp-<liga>.json: por equipo y estadística, lo que permitió (v) frente a lo que esperaban los jugadores que lo
// enfrentaron (e, la media de sus 20 previos), con los game logs de todas las plantillas (temporada vigente y anterior,
// como getGamelog en producción). Uso: node scripts/opp-snapshot.mjs [nba]
// shortcut: se refresca a mano; con la temporada avanzada conviene correrlo cada semana o dos.
import { writeFileSync } from 'node:fs';
import { leagueById } from '../public/leagues.js';
import { fetchJson, getRoster, getGamelog, mapLimit } from '../lib/espn.mjs';
import { OPP, oppEvents, oppTotals } from '../lib/props.mjs';

const league = process.argv[2] ?? 'nba';
const lg = leagueById(league);
const cfg = OPP[league];
if (!lg || !cfg) throw new Error(`Sin factor de rival para ${league}`);
const teams = (await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${lg.sport}/${lg.espn}/teams`))?.sports?.[0]?.leagues?.[0]?.teams ?? [];
const rosters = await mapLimit(teams, 4, (t) => getRoster(league, t.team.id).catch(() => null));
if (rosters.filter(Boolean).length < teams.length * 0.9) throw new Error('ESPN no devolvió las plantillas');
const athletes = rosters.flat().filter(Boolean);
const logs = await mapLimit(athletes, 4, (a) => getGamelog(league, a.id, null, { athlete: a }).catch(() => null));
if (logs.filter(Boolean).length < athletes.length * 0.9) throw new Error('ESPN no devolvió los game logs');
const totals = oppTotals(logs.filter(Boolean).flatMap((l) => oppEvents(l.games, cfg.stats)));
const r1 = (x) => Math.round(x * 10) / 10;
const out = Object.fromEntries(Object.entries(totals).map(([id, st]) => [id, Object.fromEntries(Object.entries(st).map(([s, t]) => [s, { v: r1(t.v), e: r1(t.e) }]))]));
writeFileSync(new URL(`../data/opp-${league}.json`, import.meta.url), `${JSON.stringify({ at: new Date().toISOString(), teams: out })}\n`);
console.log(`${league}: ${athletes.length} jugadores, ${Object.keys(out).length} rivales`);
