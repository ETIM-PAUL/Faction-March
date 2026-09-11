/**
 * Phase 4 thin vertical slice, end to end in one command:
 *
 *   1. Place an order on OrderBook (Sepolia).
 *   2. Wait for Creditcoin to attest the containing block.
 *   3. Generate a proof and submit it to ProofGate (Creditcoin CC3).
 *   4. Read back the OrderArrived log and confirm zoneId/units match what was sent.
 *
 * ProofGate is deliberately unguarded at this phase (see contracts/creditcoin/src/ProofGate.sol) —
 * this courier is a reference implementation, not the only permissionless way to submit a proof.
 */
import 'dotenv/config';
import { createRequire } from 'module';
import { ethers } from 'ethers';
import { chainInfo, proofProvider } from '@gluwa/usc-sdk';

const require = createRequire(import.meta.url);
const orderBookArtifact = require('../../contracts/source/out/OrderBook.sol/OrderBook.json');
const proofGateArtifact = require('../../contracts/creditcoin/out/ProofGate.sol/ProofGate.json');

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

  const gameId = BigInt(process.argv[2] ?? '1');
  const zoneId = Number(process.argv[3] ?? '3');
  const units = Number(process.argv[4] ?? '50');

  const sourceChainRpc = new ethers.JsonRpcProvider(sourceChainRpcUrl);
  const ccRpc = new ethers.JsonRpcProvider(creditcoinRpcUrl);
  const sourceWallet = new ethers.Wallet(privateKey, sourceChainRpc);
  const ccWallet = new ethers.Wallet(privateKey, ccRpc);

  const orderBook = new ethers.Contract(orderBookAddress, orderBookArtifact.abi, sourceWallet);
  const orderFee: bigint = await orderBook.orderFee();

  console.log(`Placing order on OrderBook ${orderBookAddress}: gameId=${gameId} zoneId=${zoneId} units=${units} fee=${ethers.formatEther(orderFee)} ETH`);
  const tx = await orderBook.placeOrder(gameId, zoneId, units, { value: orderFee });
  console.log(`Broadcast: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('placeOrder tx failed');
  console.log(`Mined in block ${receipt.blockNumber}`);

  const placedEvent = receipt.logs
    .map((log: any) => {
      try {
        return orderBook.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === 'OrderPlaced');
  if (!placedEvent) throw new Error('OrderPlaced not found in receipt — is ORDER_BOOK_ADDRESS correct?');
  const sent = {
    commander: placedEvent.args.commander as string,
    gameId: placedEvent.args.gameId as bigint,
    zoneId: Number(placedEvent.args.zoneId),
    units: Number(placedEvent.args.units),
    nonce: placedEvent.args.nonce as bigint,
  };
  console.log('OrderPlaced on Sepolia:', sent);

  const info = new chainInfo.PrecompileChainInfoProvider(ccRpc);
  const proofBuilder = new proofProvider.service.ProofBuilder(sourceChainKey, proofBuilderUrl);

  console.log(`Waiting for block ${receipt.blockNumber} to be attested on Creditcoin (this is march time)...`);
  await proofBuilder.waitUntilHeightAttested(sourceChainKey, receipt.blockNumber, 15_000, 20 * 60_000);

  console.log('Generating proof...');
  const proofResult = await proofBuilder.getProof(receipt.hash);
  if (!proofResult.success || !proofResult.data) throw new Error(`Proof generation failed: ${proofResult.error}`);
  const proof = proofResult.data;

  console.log(`Submitting proof to ProofGate ${proofGateAddress}...`);
  const proofGate = new ethers.Contract(proofGateAddress, proofGateArtifact.abi, ccWallet);
  const action = await proofGate.ACTION_RELAY_ORDER();
  const verifyTx = await proofGate.execute(
    action,
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof.root,
    proof.merkleProof.siblings,
    proof.continuityProof.lowerEndpointDigest,
    proof.continuityProof.roots
  );
  console.log(`Submitted: ${verifyTx.hash}`);
  const verifyReceipt = await verifyTx.wait();
  if (!verifyReceipt || verifyReceipt.status !== 1) throw new Error('ProofGate.execute failed');

  const arrivedEvent = verifyReceipt.logs
    .map((log: any) => {
      try {
        return proofGate.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === 'OrderArrived');
  if (!arrivedEvent) throw new Error('OrderArrived not found — proof landed but ProofGate did not emit it');

  const arrived = {
    commander: arrivedEvent.args.commander as string,
    gameId: arrivedEvent.args.gameId as bigint,
    zoneId: Number(arrivedEvent.args.zoneId),
    units: Number(arrivedEvent.args.units),
    nonce: arrivedEvent.args.nonce as bigint,
  };

  const matches = arrived.zoneId === sent.zoneId && arrived.units === sent.units && arrived.commander.toLowerCase() === sent.commander.toLowerCase();

  console.log(
    `OrderArrived on Creditcoin CC3: commander=${arrived.commander} gameId=${arrived.gameId} zoneId=${arrived.zoneId} units=${arrived.units} nonce=${arrived.nonce} — zoneId/units match sent order: ${matches}`
  );

  if (!matches) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
