import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { getAttestedHeight, getProofForTx } from '../lib/proofBuilder';
import { proofGateContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { shortAddress } from '../lib/format';
import { describeError } from '../lib/errors';

const BATCH_RANGE_BLOCKS = 1000; // matches the precompile's MAX_BATCH_RANGE

export function CourierBoard({
  wallet,
  orders,
  game,
}: {
  wallet: ReturnType<typeof useWallet>;
  orders: TrackedOrder[];
  game: GameData;
}) {
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
      setStatusByKey((s) => ({ ...s, [order.key]: describeError(err) }));
    } finally {
      setBusyKey(null);
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
                // A zone that didn't exist in this game when the order was sent (e.g. the
                // sender typed a zone past the board's edge) can never resolve --
                // FactionMarch.resolveOrder will always revert with InvalidZone. Flag it
                // instead of letting a courier burn real gas on a doomed transaction.
                const invalidZone = game.zoneCount > 0 && o.zoneId >= game.zoneCount;
                const batchable = pending.filter(
                  (other) => other.key !== o.key && Math.abs(other.sepoliaBlock - o.sepoliaBlock) <= BATCH_RANGE_BLOCKS
                ).length;
                return (
                  <tr key={o.key} style={{ opacity: invalidZone ? 0.5 : 1 }}>
                    <td className="mono">{shortAddress(o.commander)}</td>
                    <td className="num">{o.zoneId}</td>
                    <td className="num">{o.sepoliaBlock}</td>
                    <td>
                      {invalidZone ? (
                        <span className="pill error">
                          zone {o.zoneId} doesn't exist (0–{game.zoneCount - 1}) — will always revert
                        </span>
                      ) : attested ? (
                        <span className="pill attested">attested</span>
                      ) : (
                        <span className="pill waiting">waiting for attestation</span>
                      )}
                      {!invalidZone && batchable > 0 && (
                        <span className="muted"> · batchable with {batchable} other{batchable === 1 ? '' : 's'} (CLI: courier:batch-relay)</span>
                      )}
                      {statusByKey[o.key] && <div className="muted">{statusByKey[o.key]}</div>}
                    </td>
                    <td>
                      <button onClick={() => claim(o)} disabled={invalidZone || !attested || busyKey === o.key || !wallet.address}>
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
    </div>
  );
}
