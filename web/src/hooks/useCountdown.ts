import { useEffect, useRef, useState } from 'react';

const CC3_BLOCK_TIME_MS = 15000; // measured directly from real block timestamps, see spikes/FINDINGS.md

/** Ticks down in real time (once a second) to a target CC3 block, given the most recently
 * polled current block. Resyncs to an absolute wall-clock target whenever currentBlock
 * updates, so it tracks on-chain truth rather than free-running, but still updates every
 * second in between polls instead of visibly jumping every 5s. */
export function useCountdown(targetBlock: bigint | number, currentBlock: number): number {
  const targetTimestampRef = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const blocksRemaining = Number(targetBlock) - currentBlock;
    targetTimestampRef.current = Date.now() + blocksRemaining * CC3_BLOCK_TIME_MS;
  }, [targetBlock, currentBlock]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (targetTimestampRef.current === null) return 0;
  return Math.max(0, Math.round((targetTimestampRef.current - now) / 1000));
}
