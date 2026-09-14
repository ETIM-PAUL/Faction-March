import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { factionMarchContract, orderBookContract } from '../lib/contracts';
import { creditcoinReadProvider, sepoliaReadProvider } from '../lib/providers';
import { SEPOLIA_CHAIN_ID } from '../config';
import { describeError } from '../lib/errors';
import { MAX_UNITS_PER_ORDER } from '../hooks/useDoomedOrders';
import {
  computeCommitHash,
  loadPendingReveals,
  randomSalt,
  removePendingReveal,
  savePendingReveal,
  type PendingReveal,
} from '../lib/commitReveal';

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
  const [pendingReveals, setPendingReveals] = useState<PendingReveal[]>([]);
  const [revealBusyNonce, setRevealBusyNonce] = useState<string | null>(null);

  const maxZone = game.zoneCount > 0 ? game.zoneCount - 1 : 0;

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

  // Pending reveals are pure local state (the salt only ever lives in this browser) -- reload
  // whenever the connected wallet changes, since they're stored per-address.
  useEffect(() => {
    setPendingReveals(wallet.address ? loadPendingReveals(wallet.address) : []);
  }, [wallet.address]);

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
      setStatus(`Zone ${zoneId} doesn't exist in this game — valid zones are 0–${maxZone}.`);
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
      setPendingReveals(loadPendingReveals(wallet.address));

      setStatus(
        `Committed on Sepolia (${tx.hash}) — units are hidden until you reveal. Reveal whenever you're ready below; ` +
          `a courier can only prove it after that.`
      );
    } catch (err) {
      setStatus(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revealOrder(reveal: PendingReveal) {
    if (!wallet.address) return;
    setRevealBusyNonce(reveal.nonce);
    setStatus(null);
    try {
      if (wallet.chainId !== SEPOLIA_CHAIN_ID) await wallet.switchToSepolia();
      const signer = await wallet.getSigner();
      const orderBook = orderBookContract(signer);
      const tx = await orderBook.revealOrder(reveal.nonce, reveal.units, reveal.salt);
      setStatus(`Revealing: ${tx.hash}. Waiting for it to mine on Sepolia…`);
      await tx.wait(1);
      removePendingReveal(wallet.address, reveal.nonce);
      setPendingReveals(loadPendingReveals(wallet.address));
      setStatus(
        `Revealed on Sepolia (${tx.hash}) — now in flight, see the panel below. This can take several minutes to prove; that wait is the mechanic, not a bug.`
      );
    } catch (err) {
      setStatus(describeError(err));
    } finally {
      setRevealBusyNonce(null);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Dispatch an order</h2>
        <span className="panel-eyebrow">Sepolia</span>
      </div>
      <p className="muted">
        Two steps, on purpose: <strong>commit</strong> locks in a zone and pays the fee without exposing how many
        units you're sending; <strong>reveal</strong>, whenever you choose, exposes the real count and makes it
        provable. Nobody — not an opponent, not a courier — can see your units until you reveal them.
      </p>
      <div className="field-row">
        <label>
          Zone
          <input
            type="number"
            min={0}
            max={maxZone}
            value={zoneId}
            onChange={(e) => setZoneId(Number(e.target.value))}
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
      <p className="muted">
        Fixed fee: {orderFeeEth ? `${orderFeeEth} ETH` : '…'} on Sepolia — flat regardless of units; combat power is
        rationed by a {MAX_UNITS_PER_ORDER}-unit-per-order cap (and a slower-regenerating 500-unit total pool), not
        by how much you pay.
        {game.zoneCount > 0 && ` This game has zones 0–${maxZone}.`}
        {wallet.address && gameId !== null && !notJoined && (
          <> You currently have {availableUnits ?? '…'} unit{availableUnits === 1 ? '' : 's'} available.</>
        )}
      </p>
      {zoneOutOfRange && <p className="error">Zone {zoneId} doesn't exist — pick 0–{maxZone}.</p>}
      {exceedsUnitCap && (
        <p className="error">
          {units} exceeds the {MAX_UNITS_PER_ORDER}-unit per-order cap — no wait ever raises that ceiling, so this
          could never be proven. Split it into multiple orders of {MAX_UNITS_PER_ORDER} or fewer instead.
        </p>
      )}
      {!exceedsUnitCap && insufficientRightNow && (
        <p className="muted">
          Only {availableUnits} available right now — this specific order won't resolve until your pool catches up
          (1/block). March time (~9 min typical) usually covers that, but if the proof lands sooner than your pool
          regenerates, it will revert.
        </p>
      )}
      {doomedByMembership ? (
        <p className="error">
          You haven't joined game {gameId} and its join window is closed — this order could never be proven. Wait
          for it to settle, then join a fresh game before it goes active.
        </p>
      ) : (
        notJoined && (
          <p className="muted">
            You haven't joined game {gameId} yet — join before its window closes or this order won't be provable.
          </p>
        )
      )}
      {status && <p className="muted">{status}</p>}

      {pendingReveals.length > 0 && (
        <div className="section-gap">
          <h3 style={{ margin: '0 0 6px' }}>Your commits awaiting reveal</h3>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            Stored only in this browser — the salt never left your device, so only you can reveal these. Clearing
            site data loses them permanently; there's no recovery.
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Zone</th>
                  <th>Units</th>
                  <th>Committed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pendingReveals.map((r) => (
                  <tr key={r.nonce}>
                    <td className="num">{r.gameId}</td>
                    <td className="num">{r.zoneId}</td>
                    <td className="num">{r.units}</td>
                    <td className="muted">{new Date(r.committedAtMs).toLocaleTimeString()}</td>
                    <td>
                      <button onClick={() => revealOrder(r)} disabled={revealBusyNonce === r.nonce || !wallet.address}>
                        {revealBusyNonce === r.nonce ? 'Revealing…' : 'Reveal'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
