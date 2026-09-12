// Every value here is public testnet configuration — contract addresses, chain IDs, and
// keyless public RPC endpoints. Nothing secret is (or should ever be) embedded in a
// client-side bundle; API-keyed RPC URLs stay server/CLI-side only (see courier/.env).

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';
export const CREDITCOIN_CHAIN_ID = 102031;
export const CREDITCOIN_CHAIN_ID_HEX = '0x18e8f';
export const SOURCE_CHAIN_KEY = 1; // Creditcoin-internal chainKey for Sepolia, not the EVM chainId

export const SEPOLIA_PUBLIC_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const CREDITCOIN_PUBLIC_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
export const PROOF_BUILDER_URL = 'https://prover.cc3-testnet.creditcoin.network';

export const ADDRESSES = {
  orderBook: '0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F',
  factionMarch: '0xEf7Cc55BD1bF5c836D4CcD0c3d108415a6Bc18Ba',
  proofGate: '0xcEd503d0Eeb04C13F8974CaA85d06A22f0441C88',
  warChest: '0x54C3901F43d1ab2694357D304e6dAc1671Cf10a2',
} as const;

export const SEPOLIA_NETWORK_PARAMS = {
  chainId: SEPOLIA_CHAIN_ID_HEX,
  chainName: 'Sepolia',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: [SEPOLIA_PUBLIC_RPC],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
};

export const CREDITCOIN_NETWORK_PARAMS = {
  chainId: CREDITCOIN_CHAIN_ID_HEX,
  chainName: 'Creditcoin CC3 Testnet',
  nativeCurrency: { name: 'Creditcoin', symbol: 'CTC', decimals: 18 },
  rpcUrls: [CREDITCOIN_PUBLIC_RPC],
  blockExplorerUrls: [],
};

export const FACTION_NAMES = ['None', 'Alpha', 'Beta', 'Gamma'] as const;
export const FACTION_COLORS = ['#6b7280', '#ef4444', '#3b82f6', '#22c55e'] as const;

/** Rough prior from Phase 1: Sepolia attestation typically takes ~9 minutes. */
export const TYPICAL_MARCH_TIME_MS = 9 * 60 * 1000;
