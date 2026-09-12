import { useCallback, useEffect, useState } from 'react';
import { BrowserProvider, type JsonRpcSigner } from 'ethers';
import {
  CREDITCOIN_CHAIN_ID_HEX,
  CREDITCOIN_NETWORK_PARAMS,
  SEPOLIA_CHAIN_ID_HEX,
  SEPOLIA_NETWORK_PARAMS,
} from '../config';
import { getBrowserProvider, hasInjectedWallet } from '../lib/providers';

export interface WalletState {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({ address: null, chainId: null, connecting: false, error: null });

  const refresh = useCallback(async () => {
    if (!hasInjectedWallet()) return;
    try {
      const provider = getBrowserProvider();
      const network = await provider.getNetwork();
      const signer = await provider.listAccounts();
      setState((s) => ({ ...s, address: signer[0]?.address ?? null, chainId: Number(network.chainId) }));
    } catch {
      // no accounts connected yet — not an error worth surfacing
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!window.ethereum?.on) return;
    const onAccountsChanged = () => refresh();
    const onChainChanged = () => refresh();
    window.ethereum.on('accountsChanged', onAccountsChanged);
    window.ethereum.on('chainChanged', onChainChanged);
    return () => {
      window.ethereum?.removeListener?.('accountsChanged', onAccountsChanged);
      window.ethereum?.removeListener?.('chainChanged', onChainChanged);
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!hasInjectedWallet()) {
      setState((s) => ({ ...s, error: 'No injected wallet found. Install MetaMask or similar.' }));
      return;
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const provider = getBrowserProvider();
      await provider.send('eth_requestAccounts', []);
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setState((s) => ({ ...s, connecting: false }));
    }
  }, [refresh]);

  const switchNetwork = useCallback(async (chainIdHex: string, addParams: typeof SEPOLIA_NETWORK_PARAMS) => {
    if (!hasInjectedWallet()) return;
    const provider = getBrowserProvider();
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: chainIdHex }]);
    } catch (err) {
      // 4902: chain not added yet
      const code = (err as { code?: number; error?: { code?: number } })?.code ?? (err as { error?: { code?: number } })?.error?.code;
      if (code === 4902) {
        await provider.send('wallet_addEthereumChain', [addParams]);
      } else {
        throw err;
      }
    }
    await refresh();
  }, [refresh]);

  const switchToSepolia = useCallback(() => switchNetwork(SEPOLIA_CHAIN_ID_HEX, SEPOLIA_NETWORK_PARAMS), [switchNetwork]);
  const switchToCreditcoin = useCallback(
    () => switchNetwork(CREDITCOIN_CHAIN_ID_HEX, CREDITCOIN_NETWORK_PARAMS),
    [switchNetwork]
  );

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => {
    const provider: BrowserProvider = getBrowserProvider();
    return provider.getSigner();
  }, []);

  return { ...state, connect, switchToSepolia, switchToCreditcoin, getSigner };
}
