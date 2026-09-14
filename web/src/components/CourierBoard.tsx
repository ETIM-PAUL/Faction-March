import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { useDoomedOrders, MAX_UNITS_PER_ORDER } from '../hooks/useDoomedOrders';
import { getAttestedHeight, getBatchProof, getProofForTx } from '../lib/proofBuilder';
import { proofGateContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { shortAddress, formatCtc } from '../lib/format';
import { describeError } from '../lib/errors';

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

  // CHEST_FEE_PER_ORDER is immutable -- fetch once, not on every poll tick.
  useEffect(() => {
    proofGateContract(creditcoinReadProvider)
      .CHEST_FEE_PER_ORDER()
      .then((v: bigint) => setChestFeePerOrder(v))
      .catch(() => setChestFeePerOrder(null));
  }, []);

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

  async function claim(order: TrackedOrder) {
    setBusyKey(order.key);
    setStatusByKey((s) => ({ ...s, [order.key]: 'Fetching proof…' }));
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const proof = await getProofForTx(order.sepoliaTxHash);
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
        { value: chestFeePerOrder ?? 0n }
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
      const totalFee = (chestFeePerOrder ?? 0n) * BigInt(batch.length);
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
      setBatchStatus(`Batch resolved — ${batch.length} orders in one CC3 transaction, one shared continuity proof.`);
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
        <p className="muted">
          Each proof costs {formatCtc(chestFeePerOrder)} CTC, deposited straight into that order's game's war chest —
          real funds, moved by a real action, growing the chest in lockstep with actual play. Nets against the
          bounty, so a successful proof still leaves you ahead overall.
        </p>
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
                    <td className="num">{o.zoneId}</td>
                    <td className="num">{o.sepoliaBlock}</td>
                    <td>
                      {doomReason === 'invalid-zone' ? (
                        <span className="pill error">
                          zone {o.zoneId} doesn't exist (0–{game.zoneCount - 1}) — will always revert
                        </span>
                      ) : doomReason === 'exceeds-unit-cap' ? (
                        <span className="pill error">
                          {o.units} units exceeds the {MAX_UNITS_PER_ORDER}-per-order cap — will always revert
                        </span>
                      ) : doomReason === 'not-joined' ? (
                        <span className="pill error">commander never joined — will always revert</span>
                      ) : attested ? (
                        <span className="pill attested">attested</span>
                      ) : (
                        <span className="pill waiting">waiting for attestation</span>
                      )}
                      {!isDoomed && batchable > 0 && (
                        <span className="muted" title="Select the checkboxes below and submit together in one batch">
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
            {selected.size === 0
              ? `Select up to ${MAX_BATCH_SIZE} attested orders above to prove them together in one CC3 transaction sharing a single continuity proof.`
              : `${selected.size} order${selected.size === 1 ? '' : 's'} selected.`}
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
