import { useState } from 'react';
import { parseEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { warChestContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName, formatCtc } from '../lib/format';

export function WarChestPanel({
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
  const [depositAmount, setDepositAmount] = useState('0.01');
  const [borrowAmount, setBorrowAmount] = useState('0.0005');
  const [repayAmount, setRepayAmount] = useState('0.0005');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function withChest(action: (chest: ReturnType<typeof warChestContract>) => Promise<void>) {
    setBusy(true);
    setStatus(null);
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const signer = await wallet.getSigner();
      await action(warChestContract(signer));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deposit() {
    if (gameId === null) return;
    await withChest(async (chest) => {
      const tx = await chest.depositToChest(gameId, { value: parseEther(depositAmount) });
      await tx.wait();
      setStatus('Deposited.');
    });
  }

  async function borrow() {
    if (gameId === null || myFaction === null) return;
    await withChest(async (chest) => {
      const tx = await chest.borrow(gameId, myFaction, parseEther(borrowAmount));
      await tx.wait();
      setStatus('Borrowed.');
    });
  }

  async function repay() {
    if (gameId === null || myFaction === null) return;
    await withChest(async (chest) => {
      const tx = await chest.repay(gameId, myFaction, { value: parseEther(repayAmount) });
      await tx.wait();
      setStatus('Repaid.');
    });
  }

  if (gameId === null) return null;

  return (
    <div className="card">
      <h2>War chest — {formatCtc(game.chestBalance)} CTC</h2>
      <table className="orders-table">
        <thead>
          <tr>
            <th>Faction</th>
            <th>Territory</th>
            <th>Discount</th>
            <th>Credit limit</th>
            <th>Available</th>
            <th>Borrowed</th>
            <th>Defaults</th>
          </tr>
        </thead>
        <tbody>
          {game.factions.map((f) => (
            <tr key={f.faction} style={{ opacity: f.inDefault ? 0.6 : 1 }}>
              <td style={{ color: factionColor(f.faction) }}>{factionName(f.faction)}</td>
              <td>{f.territory}</td>
              <td>{(Number(f.discountBps) / 100).toFixed(1)}%</td>
              <td>{formatCtc(f.creditLimit)}</td>
              <td>{formatCtc(f.availableCredit)}</td>
              <td>{formatCtc(f.borrowed)}</td>
              <td>
                {f.defaultCount.toString()}
                {f.inDefault ? ' (line closed)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <label>
          Deposit (CTC) <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} style={{ width: 90 }} />
        </label>
        <button onClick={deposit} disabled={busy || !wallet.address}>
          Fund chest
        </button>
      </div>

      {myFaction !== null && myFaction > 0 && (
        <>
          <div className="row">
            <label>
              Borrow (CTC) <input value={borrowAmount} onChange={(e) => setBorrowAmount(e.target.value)} style={{ width: 90 }} />
            </label>
            <button onClick={borrow} disabled={busy || !wallet.address}>
              Borrow against {factionName(myFaction)}'s territory
            </button>
          </div>
          <div className="row">
            <label>
              Repay (CTC) <input value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} style={{ width: 90 }} />
            </label>
            <button onClick={repay} disabled={busy || !wallet.address}>
              Repay {factionName(myFaction)}'s debt
            </button>
          </div>
        </>
      )}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
