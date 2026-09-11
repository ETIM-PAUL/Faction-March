/**
 * Phase 1, steps 1-2: query the ChainInfo precompile for every supported source
 * chain and record chainKey values. Needs only a public CC3 RPC endpoint — no
 * wallet, no funds. Run this first; it gates the go/no-go decision.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { chainInfo } from '@gluwa/usc-sdk';

const CREDITCOIN_RPC_URL = process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network';

function decodeChainName(hex: string): string {
  try {
    return ethers.toUtf8String(hex);
  } catch {
    return hex;
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(CREDITCOIN_RPC_URL);
  const network = await provider.getNetwork();
  const block = await provider.getBlockNumber();
  console.log(`Connected to Creditcoin: chainId=${network.chainId}, block=${block}, rpc=${CREDITCOIN_RPC_URL}`);

  const info = new chainInfo.PrecompileChainInfoProvider(provider);
  const chains = await info.getSupportedChains();

  console.log(`\nSupported source chains (${chains.length}):`);
  for (const c of chains) {
    console.log(
      `  chainKey=${c.chainKey}  chainId=${c.chainId}  name=${decodeChainName(c.chainName)}  encoding=${c.chainEncoding}`
    );
  }

  const baseMatches = chains.filter(
    (c) => decodeChainName(c.chainName).toLowerCase().includes('base') || c.chainId === 8453 || c.chainId === 84532
  );
  console.log(`\nBase / Base Sepolia present: ${baseMatches.length > 0}`);

  const sepolia = chains.find((c) => c.chainId === 11155111);
  if (!sepolia) {
    console.log('\nEthereum Sepolia not found among supported chains.');
    return;
  }
  console.log(`\nEthereum Sepolia: chainKey=${sepolia.chainKey} (this is NOT the EVM chainId, do not conflate them)`);

  const latest = await info.getLatestAttestedHeightAndHash(sepolia.chainKey);
  console.log('Latest attested height/hash:', latest);

  const genesis = await info.getAttestationGenesisHeight(sepolia.chainKey);
  console.log('Attestation genesis height:', genesis);

  console.log(
    `\nDecision per build plan: ${baseMatches.length > 0 ? 'Base supported -> STOP, reconsider Megapot-native design.' : 'Base not supported -> proceed with Attestcoin-native Faction March.'}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
