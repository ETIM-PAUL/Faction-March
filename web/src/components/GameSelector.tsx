import { useEffect, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import { creditcoinReadProvider } from '../lib/providers';
import { factionMarchContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName } from '../lib/format';

export function GameSelector({
  wallet,
  gameId,
  setGameId,
  myFaction,
}: {
  wallet: ReturnType<typeof useWallet>;
  gameId: bigint | null;
  setGameId: (id: bigint) => void;
  myFaction: number | null;
}) {
  const [gameCount, setGameCount] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const march = factionMarchContract(creditcoinReadProvider);
      const count = await march.gameCount();
      if (cancelled) return;
      setGameCount(count);
      if (gameId === null && count > 0n) setGameId(count); // default to most recent
    }
    load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createGame() {
    setBusy(true);
    setStatus(null);
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const signer = await wallet.getSigner();
      const march = factionMarchContract(signer);
      const tx = await march.createGame(12, 5, 100_000); // 12 zones, ~5 CC3 blocks to join, long ACTIVE window
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((l: unknown) => {
          try {
            return march.interface.parseLog(l as { topics: string[]; data: string });
          } catch {
            return null;
          }
        })
        .find((p: { name: string } | null) => p?.name === 'GameCreated');
      if (created) setGameId(created.args.gameId as bigint);
      setStatus('Game created.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function joinGame() {
    if (gameId === null) return;
    setBusy(true);
    setStatus(null);
    try {
      if (wallet.chainId !== CREDITCOIN_CHAIN_ID) await wallet.switchToCreditcoin();
      const signer = await wallet.getSigner();
      const march = factionMarchContract(signer);
      const tx = await march.join(gameId);
      await tx.wait();
      setStatus('Joined.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="campaign-strip">
      <label>
        Game ID
        <input
          type="number"
          min={1}
          value={gameId?.toString() ?? ''}
          onChange={(e) => setGameId(BigInt(e.target.value || '0'))}
          style={{ width: 80 }}
        />
      </label>
      <span className="muted mono">{gameCount.toString()} created so far</span>
      <button className="ghost" onClick={createGame} disabled={busy}>
        Create new game
      </button>
      <button className="ghost" onClick={joinGame} disabled={busy || gameId === null || !wallet.address}>
        Join game {gameId?.toString() ?? ''}
      </button>
      {myFaction !== null && myFaction > 0 && (
        <span className="pill faction" style={{ color: factionColor(myFaction) }}>
          You are {factionName(myFaction)}
        </span>
      )}
      {status && <span className="muted">{status}</span>}
    </div>
  );
}
