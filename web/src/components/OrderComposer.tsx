import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { orderBookContract } from '../lib/contracts';
import { sepoliaReadProvider } from '../lib/providers';
import { SEPOLIA_CHAIN_ID } from '../config';
import { describeError } from '../lib/errors';

export function OrderComposer({
  wallet,
  gameId,
  game,
}: {
  wallet: ReturnType<typeof useWallet>;
  gameId: bigint | null;
  game: GameData;
}) {
  const [zoneId, setZoneId] = useState(0);
  const [units, setUnits] = useState(10);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [orderFeeEth, setOrderFeeEth] = useState<string | null>(null);

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

  const zoneOutOfRange = game.zoneCount > 0 && (zoneId < 0 || zoneId > maxZone);

  async function placeOrder() {
    if (gameId === null) return;
    if (zoneOutOfRange) {
      setStatus(`Zone ${zoneId} doesn't exist in this game — valid zones are 0–${maxZone}.`);
      return;
    }
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
      setStatus(describeError(err));
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
          <input type="number" min={1} value={units} onChange={(e) => setUnits(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <button onClick={placeOrder} disabled={busy || gameId === null || !wallet.address || zoneOutOfRange}>
          {busy ? 'Sending…' : 'Send order'}
        </button>
      </div>
      <p className="muted">
        Fixed fee: {orderFeeEth ? `${orderFeeEth} ETH` : '…'} on Sepolia.
        {game.zoneCount > 0 && ` This game has zones 0–${maxZone}.`}
      </p>
      {zoneOutOfRange && <p className="error">Zone {zoneId} doesn't exist — pick 0–{maxZone}.</p>}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
