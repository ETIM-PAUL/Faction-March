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
  factionMarch: '0xE3c75BD8B7029175f909141ffD2639D8478C9ea4',
  proofGate: '0x5F979DaafCc5D3324Ea446e9DcEa829aCe4aE0e1',
  warChest: '0xc15b39Ecd7068B2a2409f5833389Dd4c7E34B080',
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
export const FACTION_COLORS = ['#7b828c', '#c1584a', '#5b9bc4', '#96a86a'] as const;

/** Sepolia attestation typically takes ~9 minutes, measured against real transactions. */
export const TYPICAL_MARCH_TIME_MS = 9 * 60 * 1000;
