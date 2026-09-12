import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { TrackedOrder } from '../hooks/useOrders';
import { getAttestedHeight, getProofForTx } from '../lib/proofBuilder';
import { proofGateContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { shortAddress } from '../lib/format';

const BATCH_RANGE_BLOCKS = 1000; // matches the precompile's MAX_BATCH_RANGE

export function CourierBoard({ wallet, orders }: { wallet: ReturnType<typeof useWallet>; orders: TrackedOrder[] }) {
  const [attestedHeight, setAttestedHeight] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusByKey, setStatusByKey] = useState<Record<string, string>>({});

  const pending = orders.filter((o) => !o.resolved);

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
        proof.continuityProof.roots
      );
      setStatusByKey((s) => ({ ...s, [order.key]: `Submitted ${tx.hash}, waiting…` }));
      await tx.wait();
      setStatusByKey((s) => ({ ...s, [order.key]: 'Resolved — bounty paid if the pool had funds.' }));
    } catch (err) {
      setStatusByKey((s) => ({ ...s, [order.key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="card">
      <h2>Courier board</h2>
      <p className="muted">
        Anyone can submit anyone's proof — this board is not a privileged role. Claiming pays the fixed bounty from
        ProofGate's pool if it's funded.
      </p>
      {pending.length === 0 ? (
        <p className="muted">Nothing waiting on a courier.</p>
      ) : (
        <table className="orders-table">
          <thead>
            <tr>
              <th>Commander</th>
              <th>Zone</th>
              <th>Sepolia block</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pending.map((o) => {
              const attested = attestedHeight !== null && attestedHeight >= o.sepoliaBlock;
              const batchable = pending.filter(
                (other) => other.key !== o.key && Math.abs(other.sepoliaBlock - o.sepoliaBlock) <= BATCH_RANGE_BLOCKS
              ).length;
              return (
                <tr key={o.key}>
                  <td>{shortAddress(o.commander)}</td>
                  <td>{o.zoneId}</td>
                  <td>{o.sepoliaBlock}</td>
                  <td>
                    {attested ? (
                      <span className="pill" style={{ background: '#22c55e' }}>
                        attested
                      </span>
                    ) : (
                      <span className="pill">waiting for attestation</span>
                    )}
                    {batchable > 0 && (
                      <span className="muted"> · batchable with {batchable} other{batchable === 1 ? '' : 's'} (CLI: courier:batch-relay)</span>
                    )}
                    {statusByKey[o.key] && <div className="muted">{statusByKey[o.key]}</div>}
                  </td>
                  <td>
                    <button onClick={() => claim(o)} disabled={!attested || busyKey === o.key || !wallet.address}>
                      {busyKey === o.key ? 'Working…' : 'Submit proof'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
