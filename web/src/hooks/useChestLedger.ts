import { useEffect, useState } from 'react';
import { Interface } from 'ethers';
import { creditcoinReadProvider } from '../lib/providers';
import { ADDRESSES } from '../config';
import WarChestAbi from '../abis/WarChest.json';

const chestIface = new Interface(WarChestAbi);
const LOOKBACK_BLOCKS = 5000;

export interface ChestLedger {
  depositedByUsers: bigint;
  depositedByProofs: bigint;
  borrowedTotal: bigint;
  repaidTotal: bigint;
  loading: boolean;
}

const EMPTY: ChestLedger = { depositedByUsers: 0n, depositedByProofs: 0n, borrowedTotal: 0n, repaidTotal: 0n, loading: true };

/** Sums WarChest's own event trail for one game so the chest balance on screen has real
 * provenance instead of being just a number. ChestFunded splits by funder: ProofGate calls
 * depositToChest on a courier's behalf (see ProofGate.submitOrderProof), so funder ==
 * ADDRESSES.proofGate means "a courier's per-order fee," anything else means a direct
 * deposit. Numbers are a lookback-window sum, not a full-history total -- same tradeoff
 * ZoneMap's ownership history already makes, for the same reason (no indexer here). */
export function useChestLedger(gameId: bigint | null): ChestLedger {
  const [ledger, setLedger] = useState<ChestLedger>(EMPTY);

  useEffect(() => {
    if (gameId === null) {
      setLedger(EMPTY);
      return;
    }
    let cancelled = false;
    const gameIdTopic = '0x' + gameId.toString(16).padStart(64, '0');
    const proofGate = ADDRESSES.proofGate.toLowerCase();

    async function load() {
      try {
        const current = await creditcoinReadProvider.getBlockNumber();
        const from = Math.max(0, current - LOOKBACK_BLOCKS);
        const [fundedLogs, borrowedLogs, repaidLogs] = await Promise.all([
          creditcoinReadProvider.getLogs({
            address: ADDRESSES.warChest,
            topics: [chestIface.getEvent('ChestFunded')!.topicHash, gameIdTopic],
            fromBlock: from,
            toBlock: current,
          }),
          creditcoinReadProvider.getLogs({
            address: ADDRESSES.warChest,
            topics: [chestIface.getEvent('CreditBorrowed')!.topicHash, gameIdTopic],
            fromBlock: from,
            toBlock: current,
          }),
          creditcoinReadProvider.getLogs({
            address: ADDRESSES.warChest,
            topics: [chestIface.getEvent('CreditRepaid')!.topicHash, gameIdTopic],
            fromBlock: from,
            toBlock: current,
          }),
        ]);
        if (cancelled) return;

        let depositedByUsers = 0n;
        let depositedByProofs = 0n;
        for (const log of fundedLogs) {
          const parsed = chestIface.parseLog(log);
          if (!parsed) continue;
          const funder = (parsed.args.funder as string).toLowerCase();
          const amount = parsed.args.amount as bigint;
          if (funder === proofGate) depositedByProofs += amount;
          else depositedByUsers += amount;
        }

        let borrowedTotal = 0n;
        for (const log of borrowedLogs) {
          const parsed = chestIface.parseLog(log);
          if (parsed) borrowedTotal += parsed.args.amount as bigint;
        }

        let repaidTotal = 0n;
        for (const log of repaidLogs) {
          const parsed = chestIface.parseLog(log);
          if (parsed) repaidTotal += parsed.args.amount as bigint;
        }

        setLedger({ depositedByUsers, depositedByProofs, borrowedTotal, repaidTotal, loading: false });
      } catch {
        if (!cancelled) setLedger((l) => ({ ...l, loading: false }));
      }
    }

    load();
    const id = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId]);

  return ledger;
}
