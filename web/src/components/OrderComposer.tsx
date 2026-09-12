import { useEffect, useState } from 'react';
import { formatEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import { orderBookContract } from '../lib/contracts';
import { sepoliaReadProvider } from '../lib/providers';
import { SEPOLIA_CHAIN_ID } from '../config';

export function OrderComposer({ wallet, gameId }: { wallet: ReturnType<typeof useWallet>; gameId: bigint | null }) {
  const [zoneId, setZoneId] = useState(0);
  const [units, setUnits] = useState(10);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [orderFeeEth, setOrderFeeEth] = useState<string | null>(null);

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

  async function placeOrder() {
    if (gameId === null) return;
    setBusy(true);
    setStatus(null);
    try {
      if (wallet.chainId !== SEPOLIA_CHAIN_ID) await wallet.switchToSepolia();
      const signer = await wallet.getSigner();
      const orderBook = orderBookContract(signer);
      const orderFee: bigint = await orderBookContract(sepoliaReadProvider).orderFee();
      const tx = await orderBook.placeOrder(gameId, zoneId, units, { value: orderFee });
      setStatus(`Sent: ${tx.hash}. Waiting for it to mine on Sepolia…`);
      await tx.wait(1);
      setStatus(
        `Mined on Sepolia (${tx.hash}). Now in flight — see the panel below. This can take several minutes to prove; that wait is the mechanic, not a bug.`
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Dispatch an order</h2>
        <span className="panel-eyebrow">Sepolia</span>
      </div>
      <div className="field-row">
        <label>
          Zone
          <input type="number" min={0} value={zoneId} onChange={(e) => setZoneId(Number(e.target.value))} style={{ width: 60 }} />
        </label>
        <label>
          Units
          <input type="number" min={1} value={units} onChange={(e) => setUnits(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <button onClick={placeOrder} disabled={busy || gameId === null || !wallet.address}>
          {busy ? 'Sending…' : 'Send order'}
        </button>
      </div>
      <p className="muted">Fixed fee: {orderFeeEth ? `${orderFeeEth} ETH` : '…'} on Sepolia.</p>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
