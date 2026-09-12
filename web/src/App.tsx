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
import { factionMarchContract } from './lib/contracts';
import { creditcoinReadProvider } from './lib/providers';

export default function App() {
  const wallet = useWallet();
  const [gameId, setGameId] = useState<bigint | null>(null);
  const [myFaction, setMyFaction] = useState<number | null>(null);

  const game = useGameData(gameId);
  const orders = useOrders(gameId);

  useEffect(() => {
    let cancelled = false;
    if (gameId === null || !wallet.address) {
      setMyFaction(null);
      return;
    }
    factionMarchContract(creditcoinReadProvider)
      .commanderFaction(gameId, wallet.address)
      .then((f: bigint) => {
        if (!cancelled) setMyFaction(Number(f));
      })
      .catch(() => {
        if (!cancelled) setMyFaction(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, wallet.address]);

  return (
    <div className="app">
      <WalletBar wallet={wallet} />
      <main>
        <GameSelector wallet={wallet} gameId={gameId} setGameId={setGameId} myFaction={myFaction} />
        <ZoneMap gameId={gameId} game={game} />
        <InFlightPanel orders={orders} />
        <div className="deck">
          <OrderComposer wallet={wallet} gameId={gameId} />
          <CourierBoard wallet={wallet} orders={orders} />
        </div>
        <WarChestPanel wallet={wallet} gameId={gameId} game={game} myFaction={myFaction} />
      </main>
    </div>
  );
}
