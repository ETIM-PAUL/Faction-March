import { BrowserProvider, JsonRpcProvider } from 'ethers';
import { CREDITCOIN_PUBLIC_RPC, SEPOLIA_PUBLIC_RPC } from '../config';

// Public, keyless RPCs — safe to embed client-side, and available before any wallet is
// connected so read-only screens (zone map, war chest) work the instant the page loads.
export const sepoliaReadProvider = new JsonRpcProvider(SEPOLIA_PUBLIC_RPC);
export const creditcoinReadProvider = new JsonRpcProvider(CREDITCOIN_PUBLIC_RPC);

declare global {
  interface Window {
    ethereum?: import('ethers').Eip1193Provider & {
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export function getBrowserProvider(): BrowserProvider {
  if (!window.ethereum) throw new Error('No injected wallet found (install MetaMask or similar).');
  return new BrowserProvider(window.ethereum);
}
