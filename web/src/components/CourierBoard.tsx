import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { getAttestedHeight, getBatchProof, getProofForTx } from '../lib/proofBuilder';
import { proofGateContract, factionMarchContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { shortAddress } from '../lib/format';
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
  const [joined, setJoined] = useState<Record<string, boolean>>({}); // lowercased commander -> has a faction

  const pending = orders.filter((o) => !o.resolved);
  const pageCount = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
  // Clamp rather than reset to 0 -- avoids yanking the page back under someone mid-review
  // just because a page at the end emptied out (e.g. its last order got resolved).
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = pending.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

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

  // A proof for a commander who never joined this game can never resolve --
  // FactionMarch.resolveOrder always reverts with NotJoined. Same idea as the invalid-zone
  // check below: flag it instead of letting a courier burn real gas finding out the hard
  // way. One call per distinct commander among pending orders, not per order.
  useEffect(() => {
    if (gameId === null) {
      setJoined({});
      return;
    }
    let cancelled = false;
    async function poll() {
      const commanders = Array.from(new Set(pending.map((o) => o.commander.toLowerCase())));
      const march = factionMarchContract(creditcoinReadProvider);
      const results = await Promise.all(
        commanders.map(async (c) => {
          try {
            const faction: bigint = await march.commanderFaction(gameId, c);
            return [c, faction !== 0n] as const;
          } catch {
            return [c, true] as const; // unknown -- don't block on a failed read
          }
        })
      );
      if (!cancelled) setJoined(Object.fromEntries(results));
    }
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, pending.map((o) => o.commander).join(',')]);

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
        proof.continuityProof.roots
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
      const tx = await gate.submitOrderProofBatch(
        proof.heights,
        proof.encodedTxs,
        proof.merkleRoots,
        proof.siblingsPerOrder,
        proof.continuityProof.lowerEndpointDigest,
        proof.continuityProof.roots
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
                // A zone that didn't exist in this game when the order was sent (e.g. the
                // sender typed a zone past the board's edge) can never resolve --
                // FactionMarch.resolveOrder will always revert with InvalidZone. Flag it
                // instead of letting a courier burn real gas on a doomed transaction.
                const invalidZone = game.zoneCount > 0 && o.zoneId >= game.zoneCount;
                const notJoined = joined[o.commander.toLowerCase()] === false;
                const doomed = invalidZone || notJoined;
                const eligibleForBatch = attested && !doomed;
                const batchable = pending.filter(
                  (other) => other.key !== o.key && Math.abs(other.sepoliaBlock - o.sepoliaBlock) <= BATCH_RANGE_BLOCKS
                ).length;
                return (
                  <tr key={o.key} style={{ opacity: doomed ? 0.5 : 1 }}>
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
                      {invalidZone ? (
                        <span className="pill error">
                          zone {o.zoneId} doesn't exist (0–{game.zoneCount - 1}) — will always revert
                        </span>
                      ) : notJoined ? (
                        <span className="pill error">commander never joined — will always revert</span>
                      ) : attested ? (
                        <span className="pill attested">attested</span>
                      ) : (
                        <span className="pill waiting">waiting for attestation</span>
                      )}
                      {!doomed && batchable > 0 && (
                        <span className="muted" title="Select the checkboxes below and submit together in one batch">
                          {' '}
                          · batchable ×{batchable}
                        </span>
                      )}
                      {statusByKey[o.key] && <div className="muted">{statusByKey[o.key]}</div>}
                    </td>
                    <td>
                      <button onClick={() => claim(o)} disabled={doomed || !attested || busyKey === o.key || !wallet.address}>
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
