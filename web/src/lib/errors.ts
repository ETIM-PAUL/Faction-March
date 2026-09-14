import { Interface, formatEther } from 'ethers';
import OrderBookAbi from '../abis/OrderBook.json';
import FactionMarchAbi from '../abis/FactionMarch.json';
import ProofGateAbi from '../abis/ProofGate.json';
import WarChestAbi from '../abis/WarChest.json';

// Every contract's custom errors, decoded into plain English. ethers surfaces an unhandled
// custom error as "execution reverted (unknown custom error)" with the raw ABI-encoded
// revert data attached -- this tries every ABI in the system against that data (a revert
// from FactionMarch can bubble up through a ProofGate call, so it's not enough to only
// check the ABI of the contract the user directly called) and falls back gracefully if
// nothing matches.

const interfaces = [
  new Interface(OrderBookAbi),
  new Interface(FactionMarchAbi),
  new Interface(ProofGateAbi),
  new Interface(WarChestAbi),
];

function extractRevertData(err: unknown): string | null {
  const e = err as Record<string, unknown> | null;
  if (!e) return null;
  const candidates = [e.data, (e.info as Record<string, unknown> | undefined)?.error, (e.error as Record<string, unknown> | undefined)?.data];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('0x') && c.length >= 10) return c;
    if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).data === 'string') {
      const inner = (c as Record<string, unknown>).data as string;
      if (inner.startsWith('0x') && inner.length >= 10) return inner;
    }
  }
  return null;
}

function friendlyMessage(name: string, args: ReadonlyArray<unknown>): string | null {
  const a = args as (bigint | number | string)[];
  switch (name) {
    case 'GameNotOpen':
      return `Game ${a[0]} is no longer open for joining — its join window already closed. Create a new game instead.`;
    case 'PreviousGameNotSettled': {
      const stateName = ['still open for joining', 'still active', 'settled'][Number(a[1])] ?? 'unsettled';
      return `Only one game can be in progress at a time — game ${a[0]} is ${stateName}. Wait for it to settle (or switch to it) before creating a new one.`;
    }
    case 'GameDoesNotExist':
      return `Game ${a[0]} doesn't exist.`;
    case 'AlreadyJoined':
      return `You've already joined this game.`;
    case 'GameNotActive':
      return `Game ${a[0]} isn't active (still open, or already settled).`;
    case 'InvalidZone':
      return `Zone ${a[0]} doesn't exist in this game — valid zones are 0–${Number(a[1]) - 1}.`;
    case 'InvalidZoneCount':
      return `Zone count must be between 1 and 100.`;
    case 'InvalidDuration':
      return `Open/active durations must be greater than zero blocks.`;
    case 'ZeroUnits':
      return `Units must be greater than zero.`;
    case 'InsufficientUnits':
      // A request this size always passes the MAX_UNITS_PER_ORDER check first (see below), so
      // reaching this error means the amount itself was valid -- just not replenished yet.
      return `You need ${a[0]} units but only have ${a[1]} available right now — units replenish over time, try again shortly.`;
    case 'ExceedsMaxUnitsPerOrder':
      return `A single order can request at most ${a[1]} units (asked for ${a[0]}) — no wait ever raises that ceiling, so this could never resolve. Split it into multiple orders instead.`;
    case 'NotJoined':
      return `You haven't joined this game yet.`;
    case 'IncorrectFee':
      return `Incorrect fee: sent ${formatEther(a[0])} ETH, needs to be exactly ${formatEther(a[1])} ETH.`;
    case 'UnknownCommitment':
      return `No commitment found for that order — it may already be revealed, or from a different wallet.`;
    case 'AlreadyRevealed':
      return `This order was already revealed.`;
    case 'CommitmentMismatch':
      return `Those units/salt don't match what you committed to — this is a client bug (wrong local data), not something you did wrong.`;
    case 'ForgedEmitter':
      return `This proof's log wasn't emitted by the real OrderBook contract.`;
    case 'WrongTopic0':
    case 'WrongTopicCount':
      return `This proof isn't shaped like a genuine order.`;
    case 'OrderAlreadyProcessed':
      return `This order has already been proven by someone else.`;
    case 'OrderStale':
      return `Too stale to prove now — expired safely, no state changed.`;
    case 'TransactionDidNotSucceed':
      return `The original Sepolia transaction reverted, so there's nothing valid to prove.`;
    case 'ProofVerificationFailed':
      return `The block-prover precompile rejected this proof — it doesn't chain back to an attested Creditcoin checkpoint.`;
    case 'BountyTransferFailed':
      return `The order resolved, but paying out the bounty failed (the recipient may be a contract that rejects plain transfers).`;
    case 'InvalidBatchSize':
      return `Got ${a[0]} orders, but a batch must contain between 1 and 10 (ProofGate.MAX_BATCH_SIZE).`;
    case 'BatchLengthMismatch':
      return `Batch arrays are out of sync with each other — this is a client bug, not something you did wrong.`;
    case 'IncorrectChestFee':
      return `Sent ${formatEther(a[0])} CTC, but this needs exactly ${formatEther(a[1])} CTC — the courier fee that funds this game's chest.`;
    case 'NotFactionMember':
      return `Only members of that faction can act on its credit line.`;
    case 'CreditLineInDefault':
      return `This faction's credit line is in default — repay the outstanding debt before borrowing again.`;
    case 'ExceedsAvailableCredit':
      return `Requested ${formatEther(a[0])} CTC, but only ${formatEther(a[1])} CTC is available on this credit line.`;
    case 'ExceedsPerDrawCap':
      return `Requested ${formatEther(a[0])} CTC, but a single draw can't exceed ${formatEther(a[1])} CTC (20% of the chest's current balance).`;
    case 'InsufficientChestBalance':
      return `Requested ${formatEther(a[0])} CTC, but the chest only holds ${formatEther(a[1])} CTC.`;
    case 'NotProofGate':
    case 'OnlyDeployer':
    case 'ProofGateAlreadySet':
    case 'ZeroAddress':
      return `This action isn't available right now (${name}).`;
    default:
      return null;
  }
}

/** Turns any thrown error from a contract call into a human-readable message, decoding
 * custom errors from any of the four contracts in the system rather than showing raw
 * "execution reverted (unknown custom error)" hex to the user. */
export function describeError(err: unknown): string {
  const data = extractRevertData(err);
  if (data && data !== '0x') {
    for (const iface of interfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          return friendlyMessage(parsed.name, parsed.args) ?? `${parsed.name}(${parsed.args.map(String).join(', ')})`;
        }
      } catch {
        // not this contract's error set -- try the next one
      }
    }
  }
  const e = err as { shortMessage?: string; reason?: string; message?: string } | null;
  if (e?.shortMessage) return e.shortMessage;
  if (e?.reason) return e.reason;
  if (e?.message) return e.message;
  return String(err);
}
