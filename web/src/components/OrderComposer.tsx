import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { factionMarchContract, orderBookContract } from '../lib/contracts';
import { creditcoinReadProvider, sepoliaReadProvider } from '../lib/providers';
import { SEPOLIA_CHAIN_ID, TYPICAL_MARCH_TIME_MS } from '../config';
import { describeError } from '../lib/errors';
import { formatCountdown } from '../lib/format';
import { useCountdown } from '../hooks/useCountdown';
import { MAX_UNITS_PER_ORDER } from '../hooks/useDoomedOrders';
import { computeCommitHash, randomSalt, savePendingReveal, type PendingReveal } from '../lib/commitReveal';

export function OrderComposer({
  wallet,
  gameId,
  game,
  myFaction,
}: {
  wallet: ReturnType<typeof useWallet>;
  gameId: bigint | null;
  game: GameData;
  myFaction: number | null;
}) {
  const [zoneId, setZoneId] = useState(0);
  const [units, setUnits] = useState(MAX_UNITS_PER_ORDER);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [orderFeeEth, setOrderFeeEth] = useState<string | null>(null);
  const [availableUnits, setAvailableUnits] = useState<number | null>(null);

  const maxZone = game.zoneCount > 0 ? game.zoneCount - 1 : 0;

  // resolveOrder requires currentState == ACTIVE with no grace period -- the instant the
  // game crosses settleBlock, it's SETTLED forever, and any proof arriving after that
  // reverts with GameNotActive permanently, no retry fixes it. Typical march time is ~9 min
  // (measured, not a hard cap -- can run longer), so committing/revealing this close to the
  // end is genuinely risky, just not *guaranteed* doomed the way an over-cap order is -- a
  // warning, not a hard block.
  const secondsUntilSettle = useCountdown(game.settleBlock, game.ccBlockNumber);
  const settlingSoon = game.state === 1 && secondsUntilSettle > 0 && secondsUntilSettle * 1000 < TYPICAL_MARCH_TIME_MS;

  // Reset the selected zone only when the *game* changes underneath it (e.g. switching to
  // a smaller board) -- not on every keystroke, or a user typing an out-of-range zone would
  // never get to see the validation message below before it snapped back on its own.
  const lastZoneCount = useRef(game.zoneCount);
  useEffect(() => {
    if (game.zoneCount !== lastZoneCount.current) {
      lastZoneCount.current = game.zoneCount;
      if (game.zoneCount > 0 && zoneId > game.zoneCount - 1) setZoneId(0);
    }
  }, [game.zoneCount, zoneId]);

  useEffect(() => {
    let cancelled = false;
    orderBookContract(sepoliaReadProvider)
      .orderFee()
      .then((fee: bigint) => {
        if (!cancelled) setOrderFeeEth(formatEther(fee));
      })
      .catch(() => {
        if (!cancelled) setOrderFeeEth(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live unit-pool balance for this wallet, in this game -- informational only. Unlike the
  // permanent MAX_UNITS_PER_ORDER cap below, "not enough available right now" is temporary:
  // the pool replenishes 1/block, and march time (proofs typically land minutes after being
  // sent) usually provides plenty of catch-up room. So this warns rather than blocks.
  useEffect(() => {
    if (gameId === null || !wallet.address) {
      setAvailableUnits(null);
      return;
    }
    let cancelled = false;
    function poll() {
      factionMarchContract(creditcoinReadProvider)
        .currentUnits(gameId, wallet.address)
        .then((u: bigint) => {
          if (!cancelled) setAvailableUnits(Number(u));
        })
        .catch(() => {
          if (!cancelled) setAvailableUnits(null);
        });
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId, wallet.address]);

  const zoneOutOfRange = game.zoneCount > 0 && (zoneId < 0 || zoneId > maxZone);
  // Sepolia's OrderBook can't see FactionMarch's caps at all (Attestcoin only proves Sepolia
  // -> Creditcoin, never back), so it'll happily mine a request for any number of units for
  // the same flat fee. But a single order can never spend more than MAX_UNITS_PER_ORDER, no
  // matter how large the pool has grown -- above that, resolveOrder is guaranteed to revert
  // with ExceedsMaxUnitsPerOrder forever, no matter when it's proven. Catch it here before
  // real ETH is spent on it.
  const exceedsUnitCap = units > MAX_UNITS_PER_ORDER;
  const insufficientRightNow = availableUnits !== null && !exceedsUnitCap && units > availableUnits;
  const notJoined = wallet.address !== null && (myFaction === null || myFaction === 0);
  // FactionMarch.resolveOrder checks membership live, at proof time -- so an order sent
  // before joining is still fine *if* you join before the window closes. Once the game has
  // left OPEN, though, join() itself starts reverting with GameNotOpen: there is no way to
  // join anymore, so an order from a not-yet-joined wallet at that point can never resolve,
  // ever. This is exactly what stranded two real test orders earlier this session.
  const joinWindowClosed = game.exists && game.state !== 0;
  const doomedByMembership = notJoined && joinWindowClosed;

  async function commitOrder() {
    if (gameId === null || !wallet.address) return;
    if (zoneOutOfRange) {
      setStatus(`Zone ${zoneId + 1} doesn't exist in this game — valid zones are 1–${maxZone + 1}.`);
      return;
    }
    if (exceedsUnitCap) {
      setStatus(`${units} units exceeds the ${MAX_UNITS_PER_ORDER}-unit per-order cap — this could never be proven.`);
      return;
    }
    if (doomedByMembership) {
      setStatus(`You never joined game ${gameId} and its join window is closed — this order could never be proven.`);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (wallet.chainId !== SEPOLIA_CHAIN_ID) await wallet.switchToSepolia();
      const salt = randomSalt();
      const commitHash = computeCommitHash(units, salt);
      const signer = await wallet.getSigner();
      const orderBook = orderBookContract(signer);
      const orderFee: bigint = await orderBookContract(sepoliaReadProvider).orderFee();
      const tx = await orderBook.commitOrder(gameId, zoneId, commitHash, { value: orderFee });
      setStatus(`Sent: ${tx.hash}. Waiting for it to mine on Sepolia…`);
      const receipt = await tx.wait(1);

      const committedEvent = receipt.logs
        .map((log: unknown) => {
          try {
            return orderBook.interface.parseLog(log as { topics: string[]; data: string });
          } catch {
            return null;
          }
        })
        .find((parsed: { name: string } | null) => parsed?.name === 'OrderCommitted');
      if (!committedEvent) throw new Error('OrderCommitted not found in receipt');
      const nonce = (committedEvent.args.nonce as bigint).toString();

      const reveal: PendingReveal = { gameId: gameId.toString(), zoneId, nonce, units, salt, committedAtMs: Date.now() };
      savePendingReveal(wallet.address, reveal);

      setStatus(`Committed (${tx.hash}) — reveal it from the Courier board when you're ready to have it proven.`);
    } catch (err) {
      setStatus(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Dispatch an order</h2>
        <span
          className="panel-eyebrow"
          title="Commit hides your unit count. Reveal moved to the Courier board -- it's the first step of getting an order proven, not a standalone action."
        >
          Sepolia · commit → reveal
        </span>
      </div>
      <div className="field-row">
        <label>
          Zone
          <input
            type="number"
            min={1}
            max={maxZone + 1}
            value={zoneId + 1}
            onChange={(e) => setZoneId(Number(e.target.value) - 1)}
            style={{ width: 60, borderColor: zoneOutOfRange ? 'var(--danger, #d1574a)' : undefined }}
          />
        </label>
        <label>
          Units
          <input
            type="number"
            min={1}
            max={MAX_UNITS_PER_ORDER}
            value={units}
            onChange={(e) => setUnits(Number(e.target.value))}
            style={{
              width: 70,
              borderColor: exceedsUnitCap ? 'var(--danger, #d1574a)' : insufficientRightNow ? 'var(--warn, #c99a3d)' : undefined,
            }}
          />
        </label>
        <button
          onClick={commitOrder}
          disabled={busy || gameId === null || !wallet.address || zoneOutOfRange || exceedsUnitCap || doomedByMembership}
        >
          {busy ? 'Committing…' : 'Commit order'}
        </button>
      </div>
      <p className="muted" title="Flat fee regardless of units; a 500-unit pool refills 1/block.">
        Fee {orderFeeEth ? `${orderFeeEth} ETH` : '…'} · max {MAX_UNITS_PER_ORDER}/order
        {game.zoneCount > 0 && ` · zones 1–${maxZone + 1}`}
        {wallet.address && gameId !== null && !notJoined && ` · ${availableUnits ?? '…'} available`}
      </p>
      {zoneOutOfRange && <p className="error">Zone {zoneId + 1} doesn't exist — pick 1–{maxZone + 1}.</p>}
      {exceedsUnitCap && <p className="error">Max {MAX_UNITS_PER_ORDER} units per order.</p>}
      {!exceedsUnitCap && insufficientRightNow && (
        <p className="muted" title="Refills 1/block — march time usually covers the wait.">
          Only {availableUnits} available right now.
        </p>
      )}
      {doomedByMembership ? (
        <p className="error">Join window closed — this order can't be proven. Wait for the game to settle.</p>
      ) : (
        notJoined && <p className="muted">Join game {gameId} before its window closes.</p>
      )}
      {settlingSoon && (
        <p
          className="warn"
          title="Once the game hits SETTLED, resolveOrder reverts with GameNotActive forever -- no retry fixes it."
        >
          Game ends in {formatCountdown(secondsUntilSettle)} — typical proof time is ~9 min, this order may not
          resolve in time.
        </p>
      )}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
