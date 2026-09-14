/**
 * Places N (default 10, the protocol's hard batch limit) Sepolia orders back to back so
 * they land in nearby blocks, waits for the last one to be attested (attestation is
 * monotonic, so that implies the earlier ones are too), fetches one batch proof sharing a
 * single continuity proof, and submits all N in a single ProofGate.submitOrderProofBatch
 * call — one CC3 transaction, one bounty payout per order.
 *
 * Usage: npm run courier:batch-relay -- [count] [gameId]
 */
import 'dotenv/config';
import { createRequire } from 'module';
import { ethers } from 'ethers';
import { chainInfo, proofProvider } from '@gluwa/usc-sdk';
import { getOrCreateGame } from './lib/game.js';

const require = createRequire(import.meta.url);
const orderBookArtifact = require('../../contracts/source/out/OrderBook.sol/OrderBook.json');
const proofGateArtifact = require('../../contracts/creditcoin/out/ProofGate.sol/ProofGate.json');
const factionMarchArtifact = require('../../contracts/creditcoin/out/FactionMarch.sol/FactionMarch.json');

const FACTION_NAMES = ['None', 'Alpha', 'Beta', 'Gamma'];

function randomSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const sourceChainRpcUrl = need('SOURCE_CHAIN_RPC_URL');
  const creditcoinRpcUrl = process.env.CREDITCOIN_RPC_URL ?? 'https://rpc.cc3-testnet.creditcoin.network';
  const proofBuilderUrl = process.env.PROOF_BUILDER_URL ?? 'https://prover.cc3-testnet.creditcoin.network';
  const privateKey = need('CREDITCOIN_WALLET_PRIVATE_KEY');
  const sourceChainKey = Number(process.env.SOURCE_CHAIN_KEY ?? '1');
  const orderBookAddress = need('ORDER_BOOK_ADDRESS');
  const proofGateAddress = need('PROOF_GATE_ADDRESS');
  const factionMarchAddress = need('FACTION_MARCH_ADDRESS');

  const count = Number(process.argv[2] ?? '10');
  const gameIdArg = process.argv[3];

  const sourceChainRpc = new ethers.JsonRpcProvider(sourceChainRpcUrl);
  const ccRpc = new ethers.JsonRpcProvider(creditcoinRpcUrl);
  const sourceWallet = new ethers.Wallet(privateKey, sourceChainRpc);
  const ccWallet = new ethers.Wallet(privateKey, ccRpc);

  const orderBook = new ethers.Contract(orderBookAddress, orderBookArtifact.abi, sourceWallet);
  const proofGate = new ethers.Contract(proofGateAddress, proofGateArtifact.abi, ccWallet);
  const factionMarch = new ethers.Contract(factionMarchAddress, factionMarchArtifact.abi, ccWallet);

  const maxBatchSize: bigint = await proofGate.MAX_BATCH_SIZE();
  if (BigInt(count) > maxBatchSize) throw new Error(`count (${count}) exceeds MAX_BATCH_SIZE (${maxBatchSize})`);

  const gameId: bigint = gameIdArg ? BigInt(gameIdArg) : await getOrCreateGame(factionMarch);

  const commanderFaction: number = Number(await factionMarch.commanderFaction(gameId, ccWallet.address));
  if (commanderFaction === 0) {
    console.log(`Joining game ${gameId} on FactionMarch...`);
    await (await factionMarch.join(gameId)).wait();
  }

  const orderFee: bigint = await orderBook.orderFee();

  console.log(`Committing ${count} orders on OrderBook back to back (units hidden)...`);
  const commits: { nonce: bigint; salt: string }[] = [];
  for (let i = 0; i < count; i++) {
    const salt = randomSalt();
    const commitHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint32', 'bytes32'], [1, salt]));
    const tx = await orderBook.commitOrder(gameId, i, commitHash, { value: orderFee });
    const receipt = await tx.wait(1);
    const committedEvent = receipt.logs
      .map((log: any) => {
        try {
          return orderBook.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === 'OrderCommitted');
    if (!committedEvent) throw new Error(`OrderCommitted not found for order ${i}`);
    commits.push({ nonce: committedEvent.args.nonce as bigint, salt });
    console.log(`  committed ${i}: zoneId=${i} tx=${receipt.hash} nonce=${committedEvent.args.nonce}`);
  }

  console.log(`Revealing all ${count} orders back to back...`);
  const txHashes: string[] = [];
  let lastBlock = 0;
  for (let i = 0; i < count; i++) {
    const tx = await orderBook.revealOrder(commits[i].nonce, 1, commits[i].salt);
    const receipt = await tx.wait(1);
    txHashes.push(receipt.hash);
    lastBlock = Math.max(lastBlock, receipt.blockNumber);
    console.log(`  revealed ${i}: tx=${receipt.hash} block=${receipt.blockNumber}`);
  }

  const proofBuilder = new proofProvider.service.ProofBuilder(sourceChainKey, proofBuilderUrl);

  console.log(`Waiting for block ${lastBlock} (the latest of the ${count} orders) to be attested...`);
  await proofBuilder.waitUntilHeightAttested(sourceChainKey, lastBlock, 15_000, 20 * 60_000);

  console.log('Generating one batch proof for all orders (shared continuity proof)...');
  const batchResult = await proofBuilder.getBatchProof(txHashes);
  if (!batchResult.success || !batchResult.data) throw new Error(`Batch proof generation failed: ${batchResult.error}`);
  const batch = batchResult.data;

  const heights: number[] = [];
  const encodedTxs: string[] = [];
  const merkleRoots: string[] = [];
  const siblingsPerOrder: { hash: string; isLeft: boolean }[][] = [];

  for (const [header, byIndex] of batch.merkleProofs as Map<number, Map<number, any>>) {
    for (const [, entry] of byIndex) {
      heights.push(header);
      encodedTxs.push(entry.txBytes);
      merkleRoots.push(entry.merkleProof.root);
      siblingsPerOrder.push(entry.merkleProof.siblings);
    }
  }

  const chestFeePerOrder: bigint = await proofGate.CHEST_FEE_PER_ORDER();
  const totalChestFee = chestFeePerOrder * BigInt(heights.length);
  console.log(
    `Submitting batch of ${heights.length} proofs to ProofGate.submitOrderProofBatch in ONE transaction ` +
      `(chest fee: ${ethers.formatEther(totalChestFee)} CTC total)...`
  );
  const batchTx = await proofGate.submitOrderProofBatch(
    heights,
    encodedTxs,
    merkleRoots,
    siblingsPerOrder,
    batch.continuityProof.lowerEndpointDigest,
    batch.continuityProof.roots,
    { value: totalChestFee }
  );
  console.log(`Submitted: ${batchTx.hash}`);
  const batchReceipt = await batchTx.wait();
  if (!batchReceipt || batchReceipt.status !== 1) throw new Error('submitOrderProofBatch failed');

  function tryParse(iface: ethers.Interface, log: any) {
    try {
      return iface.parseLog(log);
    } catch {
      return null;
    }
  }
  const parsed = batchReceipt.logs.map((log: any) => tryParse(proofGate.interface, log) ?? tryParse(factionMarch.interface, log));
  const arrivedCount = parsed.filter((p: any) => p?.name === 'OrderArrived').length;
  const bountiesPaid = parsed.filter((p: any) => p?.name === 'BountyPaid').length;

  console.log(
    `ONE CC3 transaction (${batchTx.hash}) resolved ${arrivedCount} orders and paid ${bountiesPaid} bounties. Gas used: ${batchReceipt.gasUsed}.`
  );

  for (let i = 0; i < count; i++) {
    const [owner, garrison] = await factionMarch.zones(gameId, i);
    console.log(`  zone ${i}: owner=${FACTION_NAMES[Number(owner)]} garrison=${garrison}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
