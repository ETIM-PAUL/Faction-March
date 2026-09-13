import { useEffect, useRef, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { creditcoinReadProvider } from '../lib/providers';
import { factionMarchContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName } from '../lib/format';
import { describeError } from '../lib/errors';

const DEFAULT_ZONE_COUNT = 25;
// ~15 minutes of CC3 blocks (roughly 1/sec) to actually join before the game goes ACTIVE —
// long enough for a second browser/wallet to join a demo game. FactionMarch.join() reverts
// with GameNotOpen once this window closes; the only fix at that point is a fresh game.
const DEFAULT_OPEN_DURATION_BLOCKS = 900;
const DEFAULT_ACTIVE_DURATION_BLOCKS = 100_000;

export function GameSelector({
  wallet,
  gameId,
  setGameId,
  myFaction,
  game,
}: {
  wallet: ReturnType<typeof useWallet>;
  gameId: bigint | null;
  setGameId: (id: bigint) => void;
  myFaction: number | null;
  game: GameData;
}) {
  const [gameCount, setGameCount] = useState<bigint>(0n);
  const [zoneCount, setZoneCount] = useState(DEFAULT_ZONE_COUNT);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Auto-default to the most recent game exactly once. A naive `gameId === null` check
  // inside this effect would use a stale closure (the effect's deps are intentionally `[]`
  // so it doesn't re-poll on every keystroke) and would silently stomp the user's own
  // manual gameId selection every 8 seconds, forever, since `gameId` here would always
  // read as its value from mount. A ref sidesteps that: it fires at most once, regardless
  // of how many poll cycles run afterward.
  const hasAutoSelected = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const march = factionMarchContract(creditcoinReadProvider);
      const count = await march.gameCount();
      if (cancelled) return;
      setGameCount(count);
      if (!hasAutoSelected.current && count > 0n) {
        hasAutoSelected.current = true;
        setGameId(count);
      }
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
      const tx = await march.createGame(zoneCount, DEFAULT_OPEN_DURATION_BLOCKS, DEFAULT_ACTIVE_DURATION_BLOCKS);
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
      setStatus(`Game created with ${zoneCount} zones — open for joining for ~${DEFAULT_OPEN_DURATION_BLOCKS} CC3 blocks.`);
    } catch (err) {
      setStatus(describeError(err));
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
      setStatus(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const joinWindowClosed = game.exists && game.state !== 0; // 0 = OPEN

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
      <label>
        Zones (new game)
        <input
          type="number"
          min={1}
          max={100}
          value={zoneCount}
          onChange={(e) => setZoneCount(Math.max(1, Math.min(100, Number(e.target.value))))}
          style={{ width: 70 }}
        />
      </label>
      <button className="ghost" onClick={createGame} disabled={busy}>
        Create new game
      </button>
      <button className="ghost" onClick={joinGame} disabled={busy || gameId === null || !wallet.address || joinWindowClosed}>
        Join game {gameId?.toString() ?? ''}
      </button>
      {joinWindowClosed && (
        <span className="muted">
          Game {gameId?.toString()}'s join window has closed (it's {game.state === 1 ? 'ACTIVE' : 'SETTLED'}) — new
          players need a fresh game.
        </span>
      )}
      {myFaction !== null && myFaction > 0 && (
        <span className="pill faction" style={{ color: factionColor(myFaction) }}>
          You are {factionName(myFaction)}
        </span>
      )}
      {status && <span className="muted">{status}</span>}
    </div>
  );
}
