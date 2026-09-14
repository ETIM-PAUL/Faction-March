import { useEffect, useState } from 'react';
import { parseEther } from 'ethers';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { useChestLedger } from '../hooks/useChestLedger';
import { warChestContract } from '../lib/contracts';
import { creditcoinReadProvider } from '../lib/providers';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName, formatCtc } from '../lib/format';
import { describeError } from '../lib/errors';

interface Reputation {
  ordersIssuedLowerBound: bigint;
  ordersProven: bigint;
  bountiesClaimed: bigint;
  debtsRepaid: bigint;
}

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
  const [repaymentWindowBlocks, setRepaymentWindowBlocks] = useState<bigint | null>(null);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const ledger = useChestLedger(gameId);

  // REPAYMENT_WINDOW_BLOCKS is immutable -- fetch once, not on every poll tick.
  useEffect(() => {
    warChestContract(creditcoinReadProvider)
      .REPAYMENT_WINDOW_BLOCKS()
      .then((v: bigint) => setRepaymentWindowBlocks(v))
      .catch(() => setRepaymentWindowBlocks(null));
  }, []);

  // On-chain reputation (WarChest.reputations) for the connected wallet -- polled like
  // myFaction in App.tsx, since a resolved order changes it without changing gameId or
  // wallet.address.
  useEffect(() => {
    if (!wallet.address) {
      setReputation(null);
      return;
    }
    let cancelled = false;
    function poll() {
      warChestContract(creditcoinReadProvider)
        .reputations(wallet.address)
        .then((r: { ordersIssuedLowerBound: bigint; ordersProven: bigint; bountiesClaimed: bigint; debtsRepaid: bigint }) => {
          if (!cancelled) {
            setReputation({
              ordersIssuedLowerBound: r.ordersIssuedLowerBound,
              ordersProven: r.ordersProven,
              bountiesClaimed: r.bountiesClaimed,
              debtsRepaid: r.debtsRepaid,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setReputation(null);
        });
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet.address]);

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

  async function claimYield() {
    if (gameId === null || myFaction === null) return;
    await withChest(async (chest) => {
      const tx = await chest.claimYield(gameId, myFaction);
      await tx.wait();
      setStatus('Yield claimed.');
    });
  }

  if (gameId === null) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>War chest</h2>
        <span className="panel-eyebrow mono">{formatCtc(game.chestBalance)} CTC on hand</span>
      </div>
      <div className="field-row">
        <span className="pill mono" title="Direct funding via 'Fund chest' below">
          deposited {formatCtc(ledger.depositedByUsers)}
        </span>
        <span className="pill mono" title="Per-order fee couriers pay when submitting a proof (ProofGate.CHEST_FEE_PER_ORDER)">
          from proofs {formatCtc(ledger.depositedByProofs)}
        </span>
        <span className="pill mono" title="Debt paid back by a faction, returned to the chest">
          repaid {formatCtc(ledger.repaidTotal)}
        </span>
        <span className="pill mono" title="Currently lent out to factions, not available to borrow again until repaid">
          borrowed out {formatCtc(ledger.borrowedTotal)}
        </span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Faction</th>
              <th>Territory</th>
              <th title="Rises in tiers at 3/6/9 zones held">Discount</th>
              <th title="Scales with territory held; −30% per lifetime default, even once repaid">Credit limit</th>
              <th>Available</th>
              <th>Borrowed</th>
              <th title="30% of every deposit and proof fee, split live by current territory — claimable below">Yield</th>
              <th title={`Repay in full within ${repaymentWindowBlocks ?? '…'} blocks of borrowing, or the line defaults automatically`}>
                Repay by
              </th>
              <th>Defaults</th>
            </tr>
          </thead>
          <tbody>
            {game.factions.map((f) => {
              const blocksUntilDue = Number(f.dueBlock) - game.ccBlockNumber;
              return (
                <tr key={f.faction} style={{ opacity: f.inDefault ? 0.6 : 1 }}>
                  <td className="faction-cell" style={{ ['--row-color' as string]: factionColor(f.faction), color: factionColor(f.faction) }}>
                    {factionName(f.faction)}
                  </td>
                  <td className="num">{f.territory}</td>
                  <td className="num">{(Number(f.discountBps) / 100).toFixed(1)}%</td>
                  {/* 8 decimals here, not the usual 5 -- this table is precise credit
                      accounting, and a draw/discount small enough to round away at 5
                      decimals (e.g. limit 0.00200 vs. available 0.001998, both "0.00200" at
                      5dp) would make a real borrow look like it never happened. */}
                  <td className="num">{formatCtc(f.creditLimit, 8)}</td>
                  <td className="num">{formatCtc(f.availableCredit, 8)}</td>
                  <td className="num">{formatCtc(f.borrowed, 8)}</td>
                  <td className="num">{formatCtc(f.claimableYield, 8)}</td>
                  <td className="num">
                    {f.borrowed === 0n ? (
                      '—'
                    ) : f.inDefault ? (
                      <span className="pill error">defaulted, {Math.abs(blocksUntilDue)} blocks ago</span>
                    ) : (
                      `block ${f.dueBlock} (in ${blocksUntilDue} blocks)`
                    )}
                  </td>
                  <td className="num">
                    {f.defaultCount.toString()}
                    {f.defaultCount > 0n ? ` (−${(Number(f.defaultCount) * 30).toString()}% permanent)` : ''}
                    {f.inDefault ? ' · line closed' : ''}
                  </td>
                </tr>
              );
            })}
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

      {myFaction !== null && myFaction > 0 ? (
        <>
          {(() => {
            const mine = game.factions.find((f) => f.faction === myFaction);
            return mine && mine.claimableYield > 0n ? (
              <div className="field-row">
                <span className="pill mono" title="30% of every deposit/proof fee since it was last claimed, earned by holding territory">
                  yield available: {formatCtc(mine.claimableYield, 8)} CTC
                </span>
                <button onClick={claimYield} disabled={busy || !wallet.address}>
                  Claim yield
                </button>
              </div>
            ) : null;
          })()}
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
      ) : (
        wallet.address && <p className="muted">Join game {gameId?.toString()} to borrow or repay.</p>
      )}
      {status && <p className="muted">{status}</p>}

      {wallet.address && reputation && (
        <div className="section-gap">
          <h3 style={{ margin: '0 0 6px' }} title="Written only by ProofGate, in the same transaction as every resolution.">
            Your reputation
          </h3>
          <div className="field-row">
            <span className="pill mono" title="Highest proven Sepolia nonce + 1 — a lower bound, not a true count: Creditcoin can't observe an order issued on Sepolia but never proven.">
              orders issued (lower bound): {reputation.ordersIssuedLowerBound.toString()}
            </span>
            <span className="pill mono">orders proven: {reputation.ordersProven.toString()}</span>
            <span className="pill mono">bounties claimed: {reputation.bountiesClaimed.toString()}</span>
            <span className="pill mono">debts repaid: {reputation.debtsRepaid.toString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
