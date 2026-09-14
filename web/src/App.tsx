import { useEffect, useState } from 'react';
import { useWallet } from './hooks/useWallet';
import { useGameData } from './hooks/useGameData';
import { useOrders } from './hooks/useOrders';
import { WalletBar } from './components/WalletBar';
import { GameSelector } from './components/GameSelector';
import { ZoneMap } from './components/ZoneMap';
import { OrderComposer } from './components/OrderComposer';
import { InFlightPanel } from './components/InFlightPanel';
import { CourierBoard } from './components/CourierBoard';
import { WarChestPanel } from './components/WarChestPanel';
import { FactionChat } from './components/FactionChat';
import { factionMarchContract } from './lib/contracts';
import { creditcoinReadProvider } from './lib/providers';

export default function App() {
  const wallet = useWallet();
  const [gameId, setGameId] = useState<bigint | null>(null);
  const [myFaction, setMyFaction] = useState<number | null>(null);

  const game = useGameData(gameId);
  const orders = useOrders(gameId);

  useEffect(() => {
    if (gameId === null || !wallet.address) {
      setMyFaction(null);
      return;
    }
    let cancelled = false;
    function poll() {
      factionMarchContract(creditcoinReadProvider)
        .commanderFaction(gameId, wallet.address)
        .then((f: bigint) => {
          if (!cancelled) setMyFaction(Number(f));
        })
        .catch(() => {
          if (!cancelled) setMyFaction(null);
        });
    }
    // Polled, not one-shot: a successful `join()` changes this on-chain without changing
    // gameId or wallet.address, so a one-shot fetch tied only to those would never notice
    // and the "You are <faction>" pill would stay stale until something else re-triggered it.
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId, wallet.address]);

  return (
    <div className="app">
      <WalletBar wallet={wallet} />
      <main>
        <GameSelector wallet={wallet} gameId={gameId} setGameId={setGameId} myFaction={myFaction} game={game} />
        <ZoneMap gameId={gameId} game={game} />
        <InFlightPanel orders={orders} game={game} gameId={gameId} />
        <div className="deck">
          <OrderComposer wallet={wallet} gameId={gameId} game={game} myFaction={myFaction} />
          <CourierBoard wallet={wallet} orders={orders} game={game} gameId={gameId} />
        </div>
        <WarChestPanel wallet={wallet} gameId={gameId} game={game} myFaction={myFaction} />
        <FactionChat wallet={wallet} gameId={gameId} myFaction={myFaction} />
      </main>
    </div>
  );
}
