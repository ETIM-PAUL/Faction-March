/**
 * Phase 1, steps 3-5: send a trivial Sepolia transaction, wait for Creditcoin
 * attestation, generate a proof, verify it on-chain against the block prover
 * precompile (0x...0FD2), time the whole flow, and decode exactly what the
 * proof carries (does it include emitter address and tx success/revert
 * status, or only raw inclusion?).
 *
 * Needs a funded wallet on both Sepolia and Creditcoin CC3 testnet. See
 * .env.example for required variables and README.md in this folder for
 * faucet links.
 */
import 'dotenv/config';
import { createRequire } from 'module';
import { ethers } from 'ethers';
import { chainInfo, proofProvider, blockProver, utils } from '@gluwa/usc-sdk';

const require = createRequire(import.meta.url);
const evmV1DecoderAbi = require('@gluwa/usc-sdk/dist/utils/evmV1DecoderAbi.json');

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Minimal ABI for the pre-deployed Gluwa test ERC20 on Sepolia (mint/burn + Transfer).
const TEST_ERC20_ABI = [
  'function mint(uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

async function main() {
  const sourceChainRpcUrl = need('SOURCE_CHAIN_RPC_URL');
  const creditcoinRpcUrl = process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network';
  const proofBuilderUrl = process.env.PROOF_BUILDER_URL ?? 'https://prover.cc3-testnet.creditcoin.network';
  const privateKey = need('CREDITCOIN_WALLET_PRIVATE_KEY');
  const sourceChainKey = Number(process.env.SOURCE_CHAIN_KEY ?? '1');
  // Pre-deployed Gluwa test ERC20 on Sepolia — reused here purely as a trivial,
  // already-funded-with-nothing-to-lose emitter so the spike observes a real
  // log rather than an empty transfer. Faction March deploys its own
  // OrderBook.sol in Phase 3.
  const sourceChainContractAddress = process.env.SOURCE_CHAIN_CONTRACT_ADDRESS ?? '0x0F24FD9e0524BA53d3f0A4A40350Adf5370b4A53';
  const decoderLibraryAddress = process.env.EVM_V1_DECODER_LIBRARY_ADDRESS ?? '0x04B9ae8562D8Cc5bbbBbBB759080dDC30B56D18B';

  const sourceChainRpc = new ethers.JsonRpcProvider(sourceChainRpcUrl);
  const ccRpc = new ethers.JsonRpcProvider(creditcoinRpcUrl);
  const sourceWallet = new ethers.Wallet(privateKey, sourceChainRpc);
  const ccWallet = new ethers.Wallet(privateKey, ccRpc);

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  console.log(`Sending trivial tx on Sepolia (mint on ${sourceChainContractAddress})...`);
  const erc20 = new ethers.Contract(sourceChainContractAddress, TEST_ERC20_ABI, sourceWallet);
  const tx = await erc20.mint(1n);
  console.log(`Broadcast: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Sepolia tx failed or has no receipt');
  timings.broadcastToMinedMs = Date.now() - t0;
  console.log(`Mined in block ${receipt.blockNumber} (status=${receipt.status}). +${timings.broadcastToMinedMs}ms`);

  const info = new chainInfo.PrecompileChainInfoProvider(ccRpc);
  const latestBefore = await info.getLatestAttestedHeightAndHash(sourceChainKey);
  console.log(`Latest attested Sepolia height on Creditcoin right now: ${latestBefore.height}`);

  const proofBuilder = new proofProvider.service.ProofBuilder(sourceChainKey, proofBuilderUrl);

  console.log(`Waiting for block ${receipt.blockNumber} to be attested (this is march time; can take ~8-10 min)...`);
  const tAttestStart = Date.now();
  await proofBuilder.waitUntilHeightAttested(sourceChainKey, receipt.blockNumber, 15_000, 20 * 60_000);
  timings.attestationWaitMs = Date.now() - tAttestStart;
  console.log(`Attested. Wait took ${timings.attestationWaitMs}ms`);

  console.log('Generating proof...');
  const tProofStart = Date.now();
  const proofResult = await proofBuilder.getProof(receipt.hash);
  timings.proofGenMs = Date.now() - tProofStart;
  if (!proofResult.success || !proofResult.data) throw new Error(`Proof generation failed: ${proofResult.error}`);
  const proof = proofResult.data;
  console.log(`Proof generated in ${timings.proofGenMs}ms. header=${proof.headerNumber} txIndex=${proof.txIndex}`);

  console.log('Verifying on-chain against block prover precompile (0x...0FD2)...');
  const prover = new blockProver.PrecompileBlockProver(ccRpc);
  const tVerifyStart = Date.now();
  const verifiedView = await prover.verifySingle(
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof,
    proof.continuityProof
  );
  console.log(`Static verifySingle result: ${verifiedView}`);

  const verifyTx = await prover.verifyAndEmitSingle(
    ccWallet,
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof,
    proof.continuityProof
  );
  const verifyReceipt = await verifyTx.wait();
  timings.onChainVerifyMs = Date.now() - tVerifyStart;
  timings.totalMs = Date.now() - t0;
  console.log(`Verified on-chain: ${verifyTx.hash} (gasUsed=${verifyReceipt?.gasUsed}). +${timings.onChainVerifyMs}ms`);
  console.log(`\nTOTAL wall-clock, broadcast -> verified: ${timings.totalMs}ms (${(timings.totalMs / 1000 / 60).toFixed(2)} min)`);

  console.log('\n--- Decoding exactly what the proven txBytes contains ---');
  try {
    const decoderContract = new ethers.Contract(decoderLibraryAddress, evmV1DecoderAbi, ccRpc);
    const decoded = await utils.decoder.decodeEvmV1Transaction(proof.txBytes, decoderContract);
    console.log(utils.decoder.formatDecodedTransaction(decoded));

    const anyData = decoded.data as any;
    console.log('\nFields present in the decoded/proven payload:');
    console.log(`  commonTx.from (sender):        ${anyData.commonTx?.from}`);
    console.log(`  commonTx.to (target contract):  ${anyData.commonTx?.to}`);
    console.log(`  receipt.receiptStatus:          ${anyData.receipt?.receiptStatus}  <- success/revert status`);
    console.log(`  receipt.receiptLogs[].address_:  ${anyData.receipt?.receiptLogs?.map((l: any) => l.address_)}  <- log emitter(s)`);
    console.log(`  receipt.receiptLogs[].topics:    ${JSON.stringify(anyData.receipt?.receiptLogs?.map((l: any) => l.topics))}`);
  } catch (err) {
    // Known open issue: EVM_V1_DECODER_LIBRARY_ADDRESS from the tutorial repo currently
    // has no callable external functions on CC3 testnet (just solc's revert stub for a
    // library with only internal functions). See spikes/FINDINGS.md. Doesn't block the
    // core send-attest-prove-verify measurement above, so don't let it kill the run.
    console.warn(`Decode step failed (known open issue, see FINDINGS.md): ${(err as Error).message}`);
  }

  console.log('\n=== SUMMARY (copy into FINDINGS.md) ===');
  console.log(JSON.stringify({ timings, chainKey: proof.chainKey, header: proof.headerNumber, txHash: proof.txHash, verifyTxHash: verifyTx.hash }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
