import { useEffect, useRef, useState } from 'react';
import { Interface } from 'ethers';
import { sepoliaReadProvider, creditcoinReadProvider } from '../lib/providers';
import OrderBookAbi from '../abis/OrderBook.json';
import ProofGateAbi from '../abis/ProofGate.json';
import { ADDRESSES } from '../config';

export interface TrackedOrder {
  key: string; // commander|zoneId|nonce
  commander: string;
  zoneId: number;
  units: number;
  nonce: bigint;
  sepoliaTxHash: string;
  sepoliaBlock: number;
  sentAtMs: number; // Sepolia block timestamp, ms
  resolved: boolean;
  resolvedAtMs: number | null;
}

const orderBookIface = new Interface(OrderBookAbi);
const proofGateIface = new Interface(ProofGateAbi);

// How far back to look on first load, and how big a chunk to request per eth_getLogs call
// (public RPCs commonly cap the range of a single request).
const LOOKBACK_BLOCKS = 3000;
const CHUNK_SIZE = 500;

async function queryLogsChunked(
  provider: typeof sepoliaReadProvider,
  address: string,
  topics: (string | null)[],
  fromBlock: number,
  toBlock: number
) {
  const results = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
    try {
      const logs = await provider.getLogs({ address, topics, fromBlock: start, toBlock: end });
      results.push(...logs);
    } catch {
      // Skip a chunk the RPC refuses rather than failing the whole poll.
    }
  }
  return results;
}

/** Tracks OrderRevealed (Sepolia) vs OrderArrived (Creditcoin) for one game, matched by
 * (commander, zoneId, nonce). An order only enters this tracker once its commander reveals
 * it -- OrderBook's commit/reveal split (Phase 14) keeps units hidden before that, and a
 * committed-but-unrevealed order isn't provable yet anyway, so there's nothing for this
 * hook (or the courier board, or the in-flight panel) to do with it until then. This is the
 * data behind the in-flight panel and courier board — the single most important screen, per
 * the build plan: it's what makes "march time" visible instead of implying instant
 * resolution. */
export function useOrders(gameId: bigint | null, intervalMs = 10000) {
  const [orders, setOrders] = useState<Map<string, TrackedOrder>>(new Map());
  const lastSepoliaBlock = useRef<number | null>(null);
  const lastCreditcoinBlock = useRef<number | null>(null);

  useEffect(() => {
    // Reset on every gameId change, not just null -- switching from one real game straight
    // to another (e.g. starting a fresh game right after the last one settles) previously
    // left the old game's orders sitting in state and its lookback cursors pointed at
    // blocks that don't apply to the new game's topic filter, so stale in-flight/courier
    // rows lingered until a manual page refresh.
    setOrders(new Map());
    lastSepoliaBlock.current = null;
    lastCreditcoinBlock.current = null;
    if (gameId === null) return;

    let cancelled = false;
    const gameIdTopic = '0x' + gameId.toString(16).padStart(64, '0');

    async function poll() {
      try {
        const currentSepoliaBlock = await sepoliaReadProvider.getBlockNumber();
        const fromSepolia = lastSepoliaBlock.current ?? Math.max(0, currentSepoliaBlock - LOOKBACK_BLOCKS);
        const revealedLogs = await queryLogsChunked(
          sepoliaReadProvider,
          ADDRESSES.orderBook,
          [orderBookIface.getEvent('OrderRevealed')!.topicHash, null, gameIdTopic],
          fromSepolia,
          currentSepoliaBlock
        );
        lastSepoliaBlock.current = currentSepoliaBlock + 1;

        const currentCcBlock = await creditcoinReadProvider.getBlockNumber();
        const fromCc = lastCreditcoinBlock.current ?? Math.max(0, currentCcBlock - LOOKBACK_BLOCKS);
        const arrivedLogs = await queryLogsChunked(
          creditcoinReadProvider,
          ADDRESSES.proofGate,
          [proofGateIface.getEvent('OrderArrived')!.topicHash, null, gameIdTopic],
          fromCc,
          currentCcBlock
        );
        lastCreditcoinBlock.current = currentCcBlock + 1;

        if (cancelled) return;

        setOrders((prev) => {
          const next = new Map(prev);

          for (const log of revealedLogs) {
            const parsed = orderBookIface.parseLog(log);
            if (!parsed) continue;
            const commander = parsed.args.commander as string;
            const zoneId = Number(parsed.args.zoneId);
            const nonce = parsed.args.nonce as bigint;
            const key = `${commander.toLowerCase()}|${zoneId}|${nonce}`;
            if (next.has(key)) continue;
            next.set(key, {
              key,
              commander,
              zoneId,
              units: Number(parsed.args.units),
              nonce,
              sepoliaTxHash: log.transactionHash,
              sepoliaBlock: log.blockNumber,
              sentAtMs: 0, // filled in below once we have the block timestamp
              resolved: false,
              resolvedAtMs: null,
            });
          }

          for (const log of arrivedLogs) {
            const parsed = proofGateIface.parseLog(log);
            if (!parsed) continue;
            const commander = parsed.args.commander as string;
            const zoneId = Number(parsed.args.zoneId);
            const nonce = parsed.args.nonce as bigint;
            const key = `${commander.toLowerCase()}|${zoneId}|${nonce}`;
            const existing = next.get(key);
            if (existing) {
              existing.resolved = true;
              if (existing.resolvedAtMs === null) existing.resolvedAtMs = Date.now();
            }
          }

          return next;
        });

        // Backfill Sepolia block timestamps for any newly-seen orders (best-effort, one
        // lookup per distinct block rather than per order).
        const blocksNeeded = new Set(revealedLogs.map((l) => l.blockNumber));
        const timestamps = new Map<number, number>();
        await Promise.all(
          Array.from(blocksNeeded).map(async (blockNumber) => {
            const block = await sepoliaReadProvider.getBlock(blockNumber);
            if (block) timestamps.set(blockNumber, block.timestamp * 1000);
          })
        );
        if (timestamps.size > 0 && !cancelled) {
          setOrders((prev) => {
            const next = new Map(prev);
            for (const order of next.values()) {
              if (order.sentAtMs === 0 && timestamps.has(order.sepoliaBlock)) {
                order.sentAtMs = timestamps.get(order.sepoliaBlock)!;
              }
            }
            return next;
          });
        }
      } catch {
        // A failed poll just tries again next interval.
      }
    }

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId, intervalMs]);

  return Array.from(orders.values()).sort((a, b) => b.sepoliaBlock - a.sepoliaBlock);
}
