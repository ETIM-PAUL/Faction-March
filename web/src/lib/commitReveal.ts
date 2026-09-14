import { AbiCoder, keccak256 } from 'ethers';

// Client-side half of OrderBook's commit/reveal split (Phase 14). The salt lives only in the
// committer's own browser -- nobody else, not even a courier, can compute commitHash back
// into (units, salt) without it, which is exactly what keeps units hidden between commit and
// reveal. Losing it (clearing site data, switching browsers) means that specific order can
// never be revealed -- there is no recovery path, by design: a recoverable secret isn't one.

export interface PendingReveal {
  gameId: string; // bigint as string, since JSON can't hold bigint
  zoneId: number;
  nonce: string; // bigint as string
  units: number;
  salt: string; // 0x-prefixed 32-byte hex
  committedAtMs: number;
}

const abiCoder = AbiCoder.defaultAbiCoder();

/** Must exactly match Solidity's `keccak256(abi.encode(units, salt))` in OrderBook.sol. */
export function computeCommitHash(units: number, salt: string): string {
  return keccak256(abiCoder.encode(['uint32', 'bytes32'], [units, salt]));
}

/** crypto.getRandomValues works in any context (unlike crypto.subtle, this isn't restricted
 * to secure contexts), so this is safe to call from a plain http:// LAN dev server too. */
export function randomSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function storageKey(address: string): string {
  return `factionmarch.pendingReveals.${address.toLowerCase()}`;
}

export function loadPendingReveals(address: string): PendingReveal[] {
  try {
    const raw = localStorage.getItem(storageKey(address));
    return raw ? (JSON.parse(raw) as PendingReveal[]) : [];
  } catch {
    return []; // private browsing, blocked storage, etc. -- degrade to "no pending reveals known"
  }
}

export function savePendingReveal(address: string, reveal: PendingReveal): void {
  try {
    localStorage.setItem(storageKey(address), JSON.stringify([...loadPendingReveals(address), reveal]));
  } catch {
    // best-effort -- if storage is unavailable, the commit still succeeded on-chain, but this
    // browser won't remember how to reveal it. Nothing to recover from here client-side.
  }
}

export function removePendingReveal(address: string, nonce: string): void {
  try {
    const remaining = loadPendingReveals(address).filter((r) => r.nonce !== nonce);
    localStorage.setItem(storageKey(address), JSON.stringify(remaining));
  } catch {
    // best-effort, see savePendingReveal
  }
}
