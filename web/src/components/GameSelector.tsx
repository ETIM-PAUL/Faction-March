import { useEffect, useRef, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import type { GameData } from '../hooks/useGameData';
import { creditcoinReadProvider } from '../lib/providers';
import { factionMarchContract } from '../lib/contracts';
import { CREDITCOIN_CHAIN_ID } from '../config';
import { factionColor, factionName } from '../lib/format';
import { describeError } from '../lib/errors';

const DEFAULT_ZONE_COUNT = 25;
// CC3's measured block time is a steady 15s/block (confirmed by comparing real block
// timestamps, not assumed) -- 40 blocks to join (~10 min), 120 active (~30 min). Short
// enough to actually test a full OPEN -> ACTIVE -> SETTLED cycle in one sitting.
// FactionMarch.join() reverts with GameNotOpen once the open window closes; the only fix at
// that point is waiting for this game to settle and starting a fresh one.
const DEFAULT_OPEN_DURATION_BLOCKS = 40;
const DEFAULT_ACTIVE_DURATION_BLOCKS = 120; // must be <= FactionMarch.MAX_ACTIVE_DURATION_BLOCKS (28_800)

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
  const [latestGameState, setLatestGameState] = useState<number | null>(null); // 0 OPEN, 1 ACTIVE, 2 SETTLED
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
      if (count > 0n) {
        // FactionMarch only allows one unsettled game at a time -- this is what
        // createGame() itself will check, surfaced here too so the button can be
        // disabled with an explanation instead of just reverting when clicked.
        march
          .currentState(count)
          .then((s: bigint) => !cancelled && setLatestGameState(Number(s)))
          .catch(() => !cancelled && setLatestGameState(null));
      } else {
        setLatestGameState(null);
      }
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
  // FactionMarch.createGame() reverts with PreviousGameNotSettled unless the latest game
  // has SETTLED — surface that here so the button is disabled with an explanation instead
  // of letting the user spend gas on a doomed transaction.
  const blockedByUnsettledGame = latestGameState !== null && latestGameState !== 2;

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
      <button className="ghost" onClick={createGame} disabled={busy || blockedByUnsettledGame}>
        Create new game
      </button>
      <button className="ghost" onClick={joinGame} disabled={busy || gameId === null || !wallet.address || joinWindowClosed}>
        Join game {gameId?.toString() ?? ''}
      </button>
      {blockedByUnsettledGame && (
        <span className="muted">
          Only one game can run at a time — game {gameCount.toString()} is still {latestGameState === 0 ? 'open for joining' : 'active'}.
          Wait for it to settle before creating a new one.
        </span>
      )}
      {!blockedByUnsettledGame && joinWindowClosed && (
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
