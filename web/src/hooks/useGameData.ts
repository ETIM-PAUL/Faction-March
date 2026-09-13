import { useEffect, useState } from 'react';
import { creditcoinReadProvider } from '../lib/providers';
import { factionMarchContract, warChestContract } from '../lib/contracts';

export interface ZoneInfo {
  zoneId: number;
  owner: number;
  garrison: bigint;
}

export interface FactionStat {
  faction: number;
  headcount: bigint;
  territory: number;
  chestShareBps: number;
  creditLimit: bigint;
  availableCredit: bigint;
  discountBps: bigint;
  borrowed: bigint;
  repaidCount: bigint;
  defaultCount: bigint;
  dueBlock: bigint;
  inDefault: boolean;
}

export interface GameData {
  exists: boolean;
  zoneCount: number;
  state: number; // 0 OPEN, 1 ACTIVE, 2 SETTLED
  activeStartBlock: bigint;
  settleBlock: bigint;
  zones: ZoneInfo[];
  factions: FactionStat[];
  chestBalance: bigint;
  ccBlockNumber: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: GameData = {
  exists: false,
  zoneCount: 0,
  state: 0,
  activeStartBlock: 0n,
  settleBlock: 0n,
  zones: [],
  factions: [],
  chestBalance: 0n,
  ccBlockNumber: 0,
  loading: true,
  error: null,
};

/** Polls FactionMarch + WarChest for one game every `intervalMs`. Read-only, no wallet
 * required — this is what makes the board visible to a judge within seconds of loading. */
export function useGameData(gameId: bigint | null, intervalMs = 5000): GameData {
  const [data, setData] = useState<GameData>(EMPTY);

  useEffect(() => {
    if (gameId === null) {
      setData(EMPTY);
      return;
    }

    let cancelled = false;
    const march = factionMarchContract(creditcoinReadProvider);
    const chest = warChestContract(creditcoinReadProvider);

    async function poll() {
      try {
        const config = await march.games(gameId);
        if (!config.exists) {
          if (!cancelled) setData({ ...EMPTY, loading: false, error: `Game ${gameId} does not exist` });
          return;
        }
        const zoneCount = Number(config.zoneCount);
        const state = Number(await march.currentState(gameId));

        const zones: ZoneInfo[] = await Promise.all(
          Array.from({ length: zoneCount }, async (_, zoneId) => {
            const z = await march.zones(gameId, zoneId);
            return { zoneId, owner: Number(z.owner), garrison: z.garrison as bigint };
          })
        );

        const factions: FactionStat[] = await Promise.all(
          [1, 2, 3].map(async (faction) => {
            const [headcount, creditLimit, availableCredit, discountBps, credit] = await Promise.all([
              march.factionHeadcount(gameId, faction),
              chest.creditLimit(gameId, faction),
              chest.availableCredit(gameId, faction),
              chest.discountBps(gameId, faction),
              chest.factionCredit(gameId, faction),
            ]);
            const territory = zones.filter((z) => z.owner === faction).length;
            const inDefault: boolean = await chest.isInDefault(gameId, faction);
            return {
              faction,
              headcount,
              territory,
              chestShareBps: 0,
              creditLimit,
              availableCredit,
              discountBps,
              borrowed: credit.borrowed,
              repaidCount: credit.repaidCount,
              defaultCount: credit.defaultCount,
              dueBlock: credit.dueBlock,
              inDefault,
            };
          })
        );

        const totalTerritory = factions.reduce((sum, f) => sum + f.territory, 0);
        for (const f of factions) {
          f.chestShareBps = totalTerritory > 0 ? Math.round((f.territory / totalTerritory) * 10000) : 0;
        }

        const chestBalance: bigint = await chest.chestBalance(gameId);
        const ccBlockNumber = await creditcoinReadProvider.getBlockNumber();

        if (!cancelled) {
          setData({
            exists: true,
            zoneCount,
            state,
            activeStartBlock: config.activeStartBlock,
            settleBlock: config.settleBlock,
            zones,
            factions,
            chestBalance,
            ccBlockNumber,
            loading: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) setData((d) => ({ ...d, loading: false, error: err instanceof Error ? err.message : String(err) }));
      }
    }

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId, intervalMs]);

  return data;
}
