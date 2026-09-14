import { useEffect, useState } from 'react';
import type { TrackedOrder } from './useOrders';
import type { GameData } from './useGameData';
import { factionMarchContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';

export type DoomReason = 'invalid-zone' | 'exceeds-unit-cap' | 'not-joined' | null;

// Matches FactionMarch.MAX_UNITS_PER_ORDER -- a single order can never spend more than this,
// no matter how large the commander's pool (MAX_UNIT_POOL, 500) has grown, and no matter how
// long anyone waits. An order requesting more than this can never resolve, no matter when
// it's proven: Sepolia's OrderBook has no way to see FactionMarch's caps at all (Attestcoin
// only proves Sepolia -> Creditcoin, never the other direction), so it happily mines a
// request for any number of units for the same flat fee -- resolveOrder is what actually
// enforces this, via ExceedsMaxUnitsPerOrder.
export const MAX_UNITS_PER_ORDER = 10;

/** Cross-references pending orders against live FactionMarch state to flag the three ways an
 * order can be permanently unprovable, not just "running long":
 *   - the zone doesn't exist in this game (resolveOrder always reverts with InvalidZone)
 *   - the order asks for more units than a single order can ever spend, MAX_UNITS_PER_ORDER
 *     (always reverts with ExceedsMaxUnitsPerOrder -- unlike a merely-depleted pool, which
 *     recovers over time via InsufficientUnits, this ceiling can never be waited out)
 *   - the commander never joined before the game left OPEN, and join() itself starts
 *     reverting with GameNotOpen once it does -- there is no way to join after the fact, so
 *     a not-yet-joined commander at that point can never resolve, ever.
 * Shared by CourierBoard (don't let anyone waste gas proving it), InFlightPanel (don't imply
 * it's still just taking a while), and OrderComposer (don't let anyone send it in the first
 * place). */
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
    const exceedsUnitCap = o.units > MAX_UNITS_PER_ORDER;
    const notJoined = joinWindowClosed && joined[o.commander.toLowerCase()] === false;
    result[o.key] = invalidZone ? 'invalid-zone' : exceedsUnitCap ? 'exceeds-unit-cap' : notJoined ? 'not-joined' : null;
  }
  return result;
}
