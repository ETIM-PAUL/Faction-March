import type { useWallet } from '../hooks/useWallet';
import { CREDITCOIN_CHAIN_ID, SEPOLIA_CHAIN_ID } from '../config';
import { shortAddress } from '../lib/format';

export function WalletBar({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const { address, chainId, connecting, error, connect, switchToSepolia, switchToCreditcoin } = wallet;

  const networkLabel =
    chainId === SEPOLIA_CHAIN_ID ? 'Sepolia' : chainId === CREDITCOIN_CHAIN_ID ? 'Creditcoin CC3' : chainId ? `Chain ${chainId}` : '—';

  return (
    <div className="command-bar">
      <div className="command-bar-left">
        <span className="wordmark">Faction March</span>
        <span className="wordmark-tag">orders are Sepolia transactions; proofs make them real on Creditcoin</span>
      </div>
      <div className="command-bar-right">
        {address ? (
          <>
            <span className="pill">{networkLabel}</span>
            <span className="pill mono">{shortAddress(address)}</span>
            <button className="ghost" onClick={switchToSepolia} disabled={chainId === SEPOLIA_CHAIN_ID}>
              Switch to Sepolia
            </button>
            <button className="ghost" onClick={switchToCreditcoin} disabled={chainId === CREDITCOIN_CHAIN_ID}>
              Switch to CC3
            </button>
          </>
        ) : (
          <button onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
