import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { useDoomedOrders, MAX_UNITS_PER_ORDER } from '../hooks/useDoomedOrders';
import { useChestLedger } from '../hooks/useChestLedger';
import { getAttestedHeight, getBatchProof, getProofForTx } from '../lib/proofBuilder';
import { proofGateContract, factionMarchContract, warChestContract, orderBookContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';
import { CREDITCOIN_CHAIN_ID, SEPOLIA_CHAIN_ID, TYPICAL_MARCH_TIME_MS } from '../config';
import { shortAddress, formatCtc, factionName, factionColor, formatCountdown } from '../lib/format';
import { describeError } from '../lib/errors';
import { loadPendingReveals, removePendingReveal, type PendingReveal } from '../lib/commitReveal';
import { useCountdown } from '../hooks/useCountdown';

const BATCH_RANGE_BLOCKS = 1000; // matches the precompile's MAX_BATCH_RANGE
const MAX_BATCH_SIZE = 10; // matches ProofGate.MAX_BATCH_SIZE
const PAGE_SIZE = 10;

export function CourierBoard({
  wallet,
  orders,
  game,
  gameId,
}: {
  wallet: ReturnType<typeof useWallet>;
  orders: TrackedOrder[];
  game: GameData;
  gameId: bigint | null;
}) {
  const [attestedHeight, setAttestedHeight] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusByKey, setStatusByKey] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [chestFeePerOrder, setChestFeePerOrder] = useState<bigint | null>(null);
  const [pendingReveals, setPendingReveals] = useState<PendingReveal[]>([]);
  const [revealBusyNonce, setRevealBusyNonce] = useState<string | null>(null);
  const [revealStatus, setRevealStatus] = useState<string | null>(null);
  const ledger = useChestLedger(gameId);

  // Revealing is what starts the provability clock (ProofGate only accepts proofs of
  // OrderRevealed, never the commit -- Attestcoin can't attest to something that hasn't
  // happened yet), and resolveOrder has no grace period past settleBlock. So the "am I
  // cutting it close" warning belongs here, at reveal time, not back at commit time in the
  // order composer -- a commit can sit unrevealed indefinitely with no clock running at all.
  const secondsUntilSettle = useCountdown(game.settleBlock, game.ccBlockNumber);
  const revealSettlingSoon = game.state === 1 && secondsUntilSettle > 0 && secondsUntilSettle * 1000 < TYPICAL_MARCH_TIME_MS;

  // CHEST_FEE_PER_ORDER is immutable -- fetch once, not on every poll tick.
  useEffect(() => {
    proofGateContract(creditcoinReadProvider)
      .CHEST_FEE_PER_ORDER()
      .then((v: bigint) => setChestFeePerOrder(v))
      .catch(() => setChestFeePerOrder(null));
  }, []);

  // Reveal now lives here rather than as a standalone action in the order composer -- it's
  // presented as the first step of getting an order proven, not a free-floating choice made
  // well ahead of (and disconnected from) attestation. Pure local state (the salt only ever
  // lives in this browser), reloaded whenever the connected wallet changes.
  useEffect(() => {
    setPendingReveals(wallet.address ? loadPendingReveals(wallet.address) : []);
  }, [wallet.address]);

  // Only the original committer's own wallet can call OrderBook.revealOrder (commitments are
  // keyed per-address on-chain) -- so this only ever shows the connected wallet's own
  // commits, never another commander's. Once mined, useOrders' own Sepolia log scan picks up
  // the resulting OrderRevealed event within one poll and the order joins the table below on
  // its own, waiting for attestation like any other.
  async function revealOrder(reveal: PendingReveal) {
    if (!wallet.address) return;
    setRevealBusyNonce(reveal.nonce);
    setRevealStatus(null);
    try {
      if (wallet.chainId !== SEPOLIA_CHAIN_ID) await wallet.switchToSepolia();
      const signer = await wallet.getSigner();
      const orderBook = orderBookContract(signer);
      const tx = await orderBook.revealOrder(reveal.nonce, reveal.units, reveal.salt);
      setRevealStatus(`Revealing: ${tx.hash}. Waiting for it to mine on Sepolia…`);
      await tx.wait(1);
      removePendingReveal(wallet.address, reveal.nonce);
      setPendingReveals(loadPendingReveals(wallet.address));
      setRevealStatus(`Revealed (${tx.hash}) — it'll appear below once attested, ready to submit for proof.`);
    } catch (err) {
      setRevealStatus(describeError(err));
    } finally {
      setRevealBusyNonce(null);
    }
  }

  const pending = orders.filter((o) => !o.resolved);
  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
  // Clamp rather than reset to 0 -- avoids yanking the page back under someone mid-review
  // just because a page at the end emptied out (e.g. its last order got resolved).
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = pending.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
  const doomed = useDoomedOrders(pending, game, gameId);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const height = await getAttestedHeight();
        if (!cancelled) setAttestedHeight(height);
      } catch {
        // leave attestedHeight as-is; try again next tick
      }
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ProofGate now requires msg.value to match the *discounted* fee exactly -- flat
  // CHEST_FEE_PER_ORDER only holds when the order's own commander has zero territory.
  // Discount is keyed on that commander's faction, read live (it can change zone to zone,
  // order to order -- there's no single "the" discount for a courier proving mixed orders).
  async function discountedFeeFor(order: TrackedOrder): Promise<bigint> {
    if (!chestFeePerOrder || chestFeePerOrder === 0n || gameId === null) return 0n;
    const march = factionMarchContract(creditcoinReadProvider);
    const chest = warChestContract(creditcoinReadProvider);
    const faction: bigint = await march.commanderFaction(gameId, order.commander);
    const discountBps: bigint = await chest.discountBps(gameId, faction);
    return chestFeePerOrder - (chestFeePerOrder * discountBps) / 10000n;
  }

  async function claim(order: TrackedOrder) {
    setBusyKey(order.key);
    setStatusByKey((s) => ({ ...s, [order.key]: 'Fetching proof…' }));
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const [proof, fee] = await Promise.all([getProofForTx(order.sepoliaTxHash), discountedFeeFor(order)]);
      setStatusByKey((s) => ({ ...s, [order.key]: 'Submitting to ProofGate…' }));
      const signer = await wallet.getSigner();
      const gate = proofGateContract(signer);
      const tx = await gate.submitOrderProof(
        proof.headerNumber,
        proof.txBytes,
        proof.merkleProof.root,
        proof.merkleProof.siblings,
        proof.continuityProof.lowerEndpointDigest,
        proof.continuityProof.roots,
        { value: fee }
      );
      setStatusByKey((s) => ({ ...s, [order.key]: `Submitted ${tx.hash}, waiting…` }));
      await tx.wait();
      setStatusByKey((s) => ({ ...s, [order.key]: 'Resolved — bounty paid if the pool had funds.' }));
    } catch (err) {
      setStatusByKey((s) => ({ ...s, [order.key]: describeError(err) }));
    } finally {
      setBusyKey(null);
    }
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < MAX_BATCH_SIZE) {
        next.add(key);
      }
      return next;
    });
  }

  async function claimBatch() {
    const batch = pending.filter((o) => selected.has(o.key));
    if (batch.length === 0) return;
    setBatchBusy(true);
    setBatchStatus(`Fetching shared batch proof for ${batch.length} orders…`);
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const proof = await getBatchProof(batch.map((o) => o.sepoliaTxHash));
      setBatchStatus('Submitting batch to ProofGate…');
      const signer = await wallet.getSigner();
      const gate = proofGateContract(signer);
      // Each order's commander can sit in a different discount tier, so the batch fee is a
      // per-order sum, not fee-per-order times count — must match ProofGate's own sum exactly.
      const fees = await Promise.all(batch.map((o) => discountedFeeFor(o)));
      const totalFee = fees.reduce((a, b) => a + b, 0n);
      const tx = await gate.submitOrderProofBatch(
        proof.heights,
        proof.encodedTxs,
        proof.merkleRoots,
        proof.siblingsPerOrder,
        proof.continuityProof.lowerEndpointDigest,
        proof.continuityProof.roots,
        { value: totalFee }
      );
      setBatchStatus(`Submitted ${tx.hash}, waiting…`);
      await tx.wait();
      setBatchStatus(`Batch resolved — ${batch.length} orders, one transaction.`);
      setSelected(new Set());
    } catch (err) {
      setBatchStatus(describeError(err));
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Courier board</h2>
        <span className="panel-eyebrow">no privileged role — anyone can carry a proof</span>
      </div>
      {chestFeePerOrder !== null && chestFeePerOrder > 0n && (
        <div className="field-row">
          <span className="pill mono" title="Nets against the bounty — a successful proof still leaves you ahead">
            proof fee {formatCtc(chestFeePerOrder)} CTC/order
          </span>
          <span className="pill mono" title="Total raised for this game's war chest by couriers proving orders">
            raised via proofs {formatCtc(ledger.depositedByProofs)} CTC
          </span>
        </div>
      )}
      {chestFeePerOrder !== null && chestFeePerOrder > 0n && game.factions.length > 0 && (
        <div className="field-row" title="Zones held by an order's own commander discount that order's proof fee, applied live at submission — 3/6/9 zones held -> 5%/10%/20% off">
          {game.factions.map((f) => (
            <span key={f.faction} className="pill mono" style={{ color: factionColor(f.faction) }}>
              {factionName(f.faction)} {f.territory} zone{f.territory === 1 ? '' : 's'}
              {f.discountBps > 0n ? ` → ${Number(f.discountBps) / 100}% off` : ' → no discount yet'}
            </span>
          ))}
        </div>
      )}
      {pendingReveals.length > 0 && (
        <div className="section-gap">
          <h3
            style={{ margin: '0 0 6px' }}
            title="Only the connected wallet's own commits show here — only the original committer can reveal them. Units stay hidden until you choose to reveal, right before getting the order proven."
          >
            Your commits awaiting reveal
          </h3>
          {revealSettlingSoon && (
            <p
              className="warn"
              title="ProofGate only accepts proofs of the reveal, never the commit, and resolveOrder has no grace period past settleBlock -- reveal now and there may not be enough active time left for the ~9 min attestation lag plus submitting proof."
            >
              Game ends in {formatCountdown(secondsUntilSettle)} — typical proof time is ~9 min after reveal, revealing
              now may not resolve in time.
            </p>
          )}
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
                    <td className="num">{r.zoneId + 1}</td>
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
          {revealStatus && <p className="muted">{revealStatus}</p>}
        </div>
      )}
      {pending.length === 0 ? (
        <p className="muted">Nothing waiting on a courier.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Commander</th>
                <th>Zone</th>
                <th>Sepolia block</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((o) => {
                const attested = attestedHeight !== null && attestedHeight >= o.sepoliaBlock;
                const doomReason = doomed[o.key];
                const isDoomed = doomReason !== null && doomReason !== undefined;
                const eligibleForBatch = attested && !isDoomed;
                const batchable = pending.filter(
                  (other) => other.key !== o.key && Math.abs(other.sepoliaBlock - o.sepoliaBlock) <= BATCH_RANGE_BLOCKS
                ).length;
                return (
                  <tr key={o.key} style={{ opacity: isDoomed ? 0.5 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(o.key)}
                        onChange={() => toggleSelect(o.key)}
                        disabled={!eligibleForBatch || (!selected.has(o.key) && selected.size >= MAX_BATCH_SIZE)}
                        title={eligibleForBatch ? 'Select for batch submission' : 'Not eligible for batching yet'}
                      />
                    </td>
                    <td className="mono">{shortAddress(o.commander)}</td>
                    <td className="num">{o.zoneId + 1}</td>
                    <td className="num">{o.sepoliaBlock}</td>
                    <td>
                      {doomReason === 'invalid-zone' ? (
                        <span className="pill error" title={`Zone ${o.zoneId + 1} doesn't exist (1–${game.zoneCount})`}>
                          invalid zone
                        </span>
                      ) : doomReason === 'exceeds-unit-cap' ? (
                        <span className="pill error" title={`${o.units} exceeds the ${MAX_UNITS_PER_ORDER}-per-order cap`}>
                          exceeds unit cap
                        </span>
                      ) : doomReason === 'not-joined' ? (
                        <span className="pill error">commander not joined</span>
                      ) : attested ? (
                        <span className="pill attested">attested</span>
                      ) : (
                        <span className="pill waiting">waiting for attestation</span>
                      )}
                      {!isDoomed && batchable > 0 && (
                        <span className="muted" title="Select checkboxes to submit together in one batch">
                          {' '}
                          · batchable ×{batchable}
                        </span>
                      )}
                      {statusByKey[o.key] && <div className="muted">{statusByKey[o.key]}</div>}
                    </td>
                    <td>
                      <button onClick={() => claim(o)} disabled={isDoomed || !attested || busyKey === o.key || !wallet.address}>
                        {busyKey === o.key ? 'Working…' : 'Submit proof'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <div className="field-row">
          <button className="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>
            ← Prev
          </button>
          <span className="muted">
            Page {clampedPage + 1} of {pageCount} ({pending.length} pending)
          </span>
          <button className="ghost" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={clampedPage === pageCount - 1}>
            Next →
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <div className="field-row section-gap">
          <span className="muted">
            {selected.size === 0 ? `Select up to ${MAX_BATCH_SIZE} to batch.` : `${selected.size} selected.`}
          </span>
          <button onClick={claimBatch} disabled={selected.size === 0 || batchBusy || !wallet.address}>
            {batchBusy ? 'Working…' : `Submit batch (${selected.size})`}
          </button>
        </div>
      )}
      {batchStatus && <p className="muted">{batchStatus}</p>}
    </div>
  );
}
