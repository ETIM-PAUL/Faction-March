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

// Faction chat backend. The function itself is the only thing that can reach
// faction_messages (RLS denies anon/authenticated entirely) -- see supabase/migrations and
// supabase/functions/faction-chat. This URL is public by construction, same as the rest of
// this file; it grants no access on its own.
export const FACTION_CHAT_URL = 'https://obdtwpduhnmeateukgcf.supabase.co/functions/v1/faction-chat';

export const ADDRESSES = {
  orderBook: '0xa9842871a176feeA29590de1A71DE829940FfC36',
  factionMarch: '0xba618275A71ea261cAbA7294e742589723aEC1AE',
  proofGate: '0x8ff40DBA12240379e431eD7a927D16413717F6B8',
  warChest: '0xcd3A69f231c93f37A2A7f61D5B5F58850850a045',
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

/** Every game created from this frontend uses exactly this many zones -- not user-chosen.
 * Keeps the map, the discount tiers (3/6/9 zones), and every "0–9" style range consistent
 * without a per-game variable to thread through every display. */
export const GAME_ZONE_COUNT = 10;

/** Sepolia block below which OrderRevealed events are ignored by useOrders entirely. Every
 * FactionMarch/ProofGate redeploy resets gameCount back to 0, so a stale, never-cleaned-up
 * commit from a superseded deployment can reveal under a gameId number the *current*
 * deployment now reuses for an unrelated game -- without this floor it would resurface in
 * the in-flight panel and courier board as if it belonged to the current game. Bump this to
 * the real current Sepolia block number every time FactionMarch/ProofGate are redeployed. */
export const CURRENT_DEPLOYMENT_SEPOLIA_BLOCK = 11700637;
