import { useState } from 'react';
import { parseEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { warChestContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName, formatCtc } from '../lib/format';
import { describeError } from '../lib/errors';

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
      setStatus(describeError(err));
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
    <div className="panel">
      <div className="panel-header">
        <h2>War chest</h2>
        <span className="panel-eyebrow mono">{formatCtc(game.chestBalance)} CTC on hand</span>
      </div>
      <p className="muted">
        Territory (zones a faction currently owns) drives everything below: <strong>Discount</strong> rises in tiers
        at 3/6/9 zones held; <strong>Credit limit</strong> scales directly with zones held (more territory, more you
        can borrow against it) and gets a permanent penalty per past default, even after it's repaid.
      </p>
      <div className="table-scroll">
        <table className="data-table">
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
                <td className="faction-cell" style={{ ['--row-color' as string]: factionColor(f.faction), color: factionColor(f.faction) }}>
                  {factionName(f.faction)}
                </td>
                <td className="num">{f.territory}</td>
                <td className="num">{(Number(f.discountBps) / 100).toFixed(1)}%</td>
                <td className="num">{formatCtc(f.creditLimit)}</td>
                <td className="num">{formatCtc(f.availableCredit)}</td>
                <td className="num">{formatCtc(f.borrowed)}</td>
                <td className="num">
                  {f.defaultCount.toString()}
                  {f.inDefault ? ' (line closed)' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field-row section-gap">
        <label>
          Deposit (CTC)
          <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} style={{ width: 90 }} />
        </label>
        <button className="ghost" onClick={deposit} disabled={busy || !wallet.address}>
          Fund chest
        </button>
      </div>

      {myFaction !== null && myFaction > 0 && (
        <>
          <div className="field-row">
            <label>
              Borrow (CTC)
              <input value={borrowAmount} onChange={(e) => setBorrowAmount(e.target.value)} style={{ width: 90 }} />
            </label>
            <button className="ghost" onClick={borrow} disabled={busy || !wallet.address}>
              Borrow against {factionName(myFaction)}'s territory
            </button>
          </div>
          <div className="field-row">
            <label>
              Repay (CTC)
              <input value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} style={{ width: 90 }} />
            </label>
            <button className="ghost" onClick={repay} disabled={busy || !wallet.address}>
              Repay {factionName(myFaction)}'s debt
            </button>
          </div>
        </>
      )}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
