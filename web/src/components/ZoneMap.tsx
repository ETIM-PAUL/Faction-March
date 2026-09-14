import { useEffect, useState } from 'react';
import { Interface } from 'ethers';
import type { GameData } from '../hooks/useGameData';
import { useCountdown } from '../hooks/useCountdown';
import { creditcoinReadProvider } from '../lib/providers';
import { factionColor, factionName, formatCountdown } from '../lib/format';
import { ADDRESSES } from '../config';
import FactionMarchAbi from '../abis/FactionMarch.json';

const marchIface = new Interface(FactionMarchAbi);

interface CaptureEvent {
  zoneId: number;
  previousOwner: number;
  newOwner: number;
  survivors: bigint;
  blockNumber: number;
  txHash: string;
}

export function ZoneMap({ gameId, game }: { gameId: bigint | null; game: GameData }) {
  const [history, setHistory] = useState<CaptureEvent[]>([]);
  // Called unconditionally, before the early returns below -- these are hooks, and harmless
  // to compute against the EMPTY game's zeroed-out blocks when there's nothing to show yet.
  const secondsUntilActive = useCountdown(game.activeStartBlock, game.ccBlockNumber);
  const secondsUntilSettle = useCountdown(game.settleBlock, game.ccBlockNumber);

  useEffect(() => {
    if (gameId === null) return;
    let cancelled = false;
    const gameIdTopic = '0x' + gameId.toString(16).padStart(64, '0');

    async function load() {
      try {
        const current = await creditcoinReadProvider.getBlockNumber();
        const from = Math.max(0, current - 5000);
        const logs = await creditcoinReadProvider.getLogs({
          address: ADDRESSES.factionMarch,
          topics: [marchIface.getEvent('ZoneCaptured')!.topicHash, gameIdTopic],
          fromBlock: from,
          toBlock: current,
        });
        if (cancelled) return;
        const events = logs
          .map((log) => {
            const parsed = marchIface.parseLog(log);
            if (!parsed) return null;
            return {
              zoneId: Number(parsed.args.zoneId),
              previousOwner: Number(parsed.args.previousOwner),
              newOwner: Number(parsed.args.newOwner),
              survivors: parsed.args.survivors as bigint,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
            };
          })
          .filter((e): e is CaptureEvent => e !== null)
          .sort((a, b) => b.blockNumber - a.blockNumber);
        setHistory(events.slice(0, 15));
      } catch {
        // best-effort — an empty history is fine
      }
    }

    load();
    const id = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId]);

  if (gameId === null) return <div className="panel">Pick a game to see its board.</div>;
  if (game.loading) return <div className="panel">Loading board…</div>;
  if (game.error) return <div className="panel error">{game.error}</div>;

  const stateLabel = ['OPEN — JOINING', 'ACTIVE', 'SETTLED'][game.state] ?? 'UNKNOWN';
  const stateClass = ['state-open', 'state-active', 'state-settled'][game.state] ?? '';

  return (
    <div className="panel hero-panel">
      <div className="panel-header">
        <h2 title="Attacker needs strictly more units than the garrison to capture; a tie favours the defender.">
          Zone map — game {gameId.toString()}
        </h2>
        <span className={`stamp ${stateClass}`}>{stateLabel}</span>
        {game.state === 0 && (
          <span className="muted mono" title="Time left to join before this game goes ACTIVE">
            closes in {formatCountdown(secondsUntilActive)}
          </span>
        )}
        {game.state === 1 && (
          <span className="muted mono" title="Time left before this game goes SETTLED">
            ends in {formatCountdown(secondsUntilSettle)}
          </span>
        )}
      </div>
      <div className="zone-grid">
        {game.zones.map((zone) => (
          <div key={zone.zoneId} className="zone" style={{ ['--zone-color' as string]: factionColor(zone.owner) }}>
            <div className="zone-id">Zone {zone.zoneId + 1}</div>
            <div className="zone-owner" style={{ color: factionColor(zone.owner) }}>
              {factionName(zone.owner)}
            </div>
            <div className="zone-garrison">garrison {zone.garrison.toString()}</div>
          </div>
        ))}
      </div>

      <h3>Ownership history</h3>
      {history.length === 0 ? (
        <p className="muted">No captures yet.</p>
      ) : (
        <ul className="history-list">
          {history.map((e) => (
            <li key={e.txHash + e.zoneId}>
              Zone {e.zoneId + 1}: {factionName(e.previousOwner)} → {factionName(e.newOwner)} ({e.survivors.toString()} survivors)
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
