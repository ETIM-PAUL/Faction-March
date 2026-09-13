/**
 * End to end in one command:
 *
 *   1. Create a game on FactionMarch if no gameId was given (Creditcoin CC3), and join it.
 *   2. Place an order on OrderBook (Sepolia).
 *   3. Wait for Creditcoin to attest the containing block.
 *   4. Generate a proof and submit it to ProofGate.submitOrderProof (Creditcoin CC3), which
 *      verifies it and calls FactionMarch.resolveOrder in the same transaction.
 *   5. Read back OrderArrived and FactionMarch's combat event, and confirm zoneId/units
 *      match what was sent.
 *
 * Usage: npm run courier:place-and-relay -- [zoneId] [units] [gameId]
 * Omit gameId to create a fresh game each run.
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

  const zoneId = Number(process.argv[2] ?? '3');
  const units = Number(process.argv[3] ?? '50');
  const gameIdArg = process.argv[4];

  const sourceChainRpc = new ethers.JsonRpcProvider(sourceChainRpcUrl);
  const ccRpc = new ethers.JsonRpcProvider(creditcoinRpcUrl);
  const sourceWallet = new ethers.Wallet(privateKey, sourceChainRpc);
  const ccWallet = new ethers.Wallet(privateKey, ccRpc);

  const orderBook = new ethers.Contract(orderBookAddress, orderBookArtifact.abi, sourceWallet);
  const proofGate = new ethers.Contract(proofGateAddress, proofGateArtifact.abi, ccWallet);
  const factionMarch = new ethers.Contract(factionMarchAddress, factionMarchArtifact.abi, ccWallet);

  const gameId: bigint = gameIdArg ? BigInt(gameIdArg) : await getOrCreateGame(factionMarch);
  if (gameIdArg) console.log(`Using existing FactionMarch game ${gameId}`);

  const commanderFaction: number = Number(await factionMarch.commanderFaction(gameId, ccWallet.address));
  if (commanderFaction === 0) {
    console.log(`Joining game ${gameId} on FactionMarch as ${ccWallet.address}...`);
    const joinTx = await factionMarch.join(gameId);
    await joinTx.wait();
  }

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

  const courierBalanceBefore: bigint = await ccRpc.getBalance(ccWallet.address);

  console.log(`Submitting proof to ProofGate ${proofGateAddress}...`);
  const verifyTx = await proofGate.submitOrderProof(
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof.root,
    proof.merkleProof.siblings,
    proof.continuityProof.lowerEndpointDigest,
    proof.continuityProof.roots
  );
  console.log(`Submitted: ${verifyTx.hash}`);
  const verifyReceipt = await verifyTx.wait();
  if (!verifyReceipt || verifyReceipt.status !== 1) throw new Error('ProofGate.submitOrderProof failed');

  // ethers' parseLog returns null (it does not throw) for a log whose topic0 isn't in that
  // interface, so each candidate interface must be tried in turn rather than relying on catch.
  function tryParse(iface: ethers.Interface, log: any) {
    try {
      return iface.parseLog(log);
    } catch {
      return null;
    }
  }
  const parsedLogs = verifyReceipt.logs.map(
    (log: any) => tryParse(proofGate.interface, log) ?? tryParse(factionMarch.interface, log)
  );

  const arrivedEvent = parsedLogs.find((parsed: any) => parsed?.name === 'OrderArrived');
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

  const combatEvent = parsedLogs.find(
    (parsed: any) => parsed?.name === 'ZoneCaptured' || parsed?.name === 'ZoneAttacked' || parsed?.name === 'ZoneReinforced'
  );
  if (combatEvent) {
    console.log(`FactionMarch combat resolved in the SAME transaction: ${combatEvent.name}`, combatEvent.args);
  } else {
    console.log('WARNING: no FactionMarch combat event found in the same transaction — same-tx verify-and-execute did not fire as expected.');
  }

  const [owner, garrison] = await factionMarch.zones(gameId, zoneId);
  console.log(`Zone ${zoneId} now owned by ${FACTION_NAMES[Number(owner)]} with garrison ${garrison}`);

  const bountyPaidEvent = parsedLogs.find((parsed: any) => parsed?.name === 'BountyPaid');
  const courierBalanceAfter: bigint = await ccRpc.getBalance(ccWallet.address);
  const gasSpent = verifyReceipt.gasUsed * verifyReceipt.gasPrice;
  if (bountyPaidEvent) {
    console.log(
      `Bounty paid: ${ethers.formatEther(bountyPaidEvent.args.amount)} CTC to ${bountyPaidEvent.args.courier}. Courier wallet balance change: ${ethers.formatEther(courierBalanceAfter - courierBalanceBefore)} CTC (net of ${ethers.formatEther(gasSpent)} CTC gas).`
    );
  } else {
    console.log('No BountyPaid event — pool was likely dry (BOUNTY_PER_ORDER > bountyPool); order still resolved.');
  }

  if (!matches) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
