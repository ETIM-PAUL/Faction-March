import { useEffect, useState } from 'react';
import type { TrackedOrder } from './useOrders';
import type { GameData } from './useGameData';
import { factionMarchContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';

export type DoomReason = 'invalid-zone' | 'not-joined' | null;

/** Cross-references pending orders against live FactionMarch state to flag the two ways an
 * order can be permanently unprovable, not just "running long":
 *   - the zone doesn't exist in this game (resolveOrder always reverts with InvalidZone)
 *   - the commander never joined before the game left OPEN, and join() itself starts
 *     reverting with GameNotOpen once it does -- there is no way to join after the fact, so
 *     a not-yet-joined commander at that point can never resolve, ever.
 * Shared by CourierBoard (don't let anyone waste gas proving it) and InFlightPanel (don't
 * imply it's still just taking a while). */
export function useDoomedOrders(pending: TrackedOrder[], game: GameData, gameId: bigint | null): Record<string, DoomReason> {
  const [joined, setJoined] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (gameId === null) {
      setJoined({});
      return;
    }
    let cancelled = false;
    async function poll() {
      const commanders = Array.from(new Set(pending.map((o) => o.commander.toLowerCase())));
      const march = factionMarchContract(creditcoinReadProvider);
      const results = await Promise.all(
        commanders.map(async (c) => {
          try {
            const faction: bigint = await march.commanderFaction(gameId, c);
            return [c, faction !== 0n] as const;
          } catch {
            return [c, true] as const; // unknown -- don't flag on a failed read
          }
        })
      );
      if (!cancelled) setJoined(Object.fromEntries(results));
    }
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, pending.map((o) => o.commander).join(',')]);

  const joinWindowClosed = game.exists && game.state !== 0;

  const result: Record<string, DoomReason> = {};
  for (const o of pending) {
    const invalidZone = game.zoneCount > 0 && o.zoneId >= game.zoneCount;
    const notJoined = joinWindowClosed && joined[o.commander.toLowerCase()] === false;
    result[o.key] = invalidZone ? 'invalid-zone' : notJoined ? 'not-joined' : null;
  }
  return result;
}
