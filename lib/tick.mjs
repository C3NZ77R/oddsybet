// Seguimiento: un ciclo de revisión (lo dispara pg_cron cada 30 s con POST /api/track/tick). Candado → apuestas activas
// → summary de ESPN por partido → estado nuevo → guardar → push. Guarda antes de avisar: si el push falla se pierde un
// aviso, pero nunca se repite.
import { mapLimit } from './espn.mjs';
import { updateBet, ACTIVE } from './track.mjs';

const LEASE_S = 55; // menos que los 60 s de Vercel
const SOON_MS = 10 * 60_000; // partidos que empiezan en menos de 10 min o ya empezaron

const changed = (a, b) => a.status !== b.status || a.current !== b.current || JSON.stringify(a.state) !== JSON.stringify(b.state);

export async function runTick({ db, push, liveGame, now = Date.now() }) {
  const out = { bets: 0, pushes: 0, skippedGames: 0 };
  if (!(await db.takeLease(LEASE_S))) return out;
  try {
    const bets = await db.activeBets();
    const ids = [...new Set(bets.flatMap((b) => b.selections.filter((s) => ACTIVE.has(s.status) && s.gameId && Date.parse(s.gameStart) - now < SOON_MS).map((s) => s.gameId)))];
    const games = new Map();
    // Un partido que falla en ESPN queda fuera del Map: sus selecciones no se tocan (nunca un "fallada" falso).
    await mapLimit(ids, 6, async (id) => {
      try {
        games.set(id, await liveGame(id));
      } catch {
        out.skippedGames++;
      }
    });
    const gone = new Set();
    for (const bet of bets) {
      if (!bet.selections.some((s) => games.has(s.gameId))) continue;
      out.bets++;
      const r = updateBet(bet, games, now);
      try {
        const sels = r.selections.filter((s, i) => changed(s, bet.selections[i]));
        if (sels.length) await db.saveSelections(sels);
        if (sels.length || r.status !== bet.status || JSON.stringify(r.notified) !== JSON.stringify(bet.notified)) {
          await db.saveBet({ id: bet.id, status: r.status, notified: r.notified, settledAt: ACTIVE.has(r.status) ? undefined : new Date(now).toISOString() });
        }
      } catch (err) {
        console.error('tick: no se guardó la apuesta', bet.id, err.message);
        continue; // sin guardar no se avisa: el próximo tick lo intenta de nuevo
      }
      if (!r.push || gone.has(bet.device.id)) continue;
      try {
        const res = await push.send(bet.device.subscription, r.push);
        if (res.ok) out.pushes++;
        if (res.gone) {
          gone.add(bet.device.id);
          await db.deleteDevice(bet.device.id);
        }
      } catch (err) {
        console.error('tick: push falló', bet.id, err.message);
      }
    }
    return out;
  } finally {
    await db.releaseLease();
  }
}
