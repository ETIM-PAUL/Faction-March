# Faction March

**Track:** Gaming — a territory war with permanent, provably-resolved
captures. Also demonstrates the DeFi track: `WarChest.sol` is an
undercollateralised credit line backed by proven territory. Built for
**BUIDL CTC 2026 Fall**, themed on the Attestcoin Protocol (formerly USC).

- **Demo video:** TODO — add before the submission deadline.
- **Deck / whitepaper:** TODO — add before the submission deadline.

An Attestcoin-secured territory war: orders are Sepolia transactions, and
they only take effect once someone proves them to Creditcoin CC3. This
README leads with that integration — what it proves, how it's hardened,
and how it resolves in the same transaction it verifies — before getting to
the game itself. See [`spikes/FINDINGS.md`](./spikes/FINDINGS.md) for the
feasibility research and [`SECURITY.md`](./SECURITY.md) for the self-audit.

**Originality note.** The faction/zone/war-chest skeleton is a new codebase: proof-arrival resolution — `OrderBook.sol`, `ProofGate.sol`,
`FactionMarch.sol`'s Attestcoin wiring, and `WarChest.sol` are all written
fresh for BUIDL CTC 2026 Fall, and are the actual subject of this
submission.

---

## Attestcoin integration

### What the precompile proves — and doesn't

The block-prover precompile (`0x...0FD2`) cryptographically checks a
`ContinuityResponse`: that `txBytes` is included at `txIndex` in Sepolia
block `headerNumber`, and that `headerNumber` chains back to a checkpoint
Creditcoin has already attested. That's the whole guarantee. Confirmed live
against a real Sepolia transaction: `verifySingle` returned `true`, and the
same-tx `verifyAndEmitSingle` call succeeded on real data.

`txBytes` itself decodes further, via Gluwa's `EvmV1Decoder` library
(linked in at compile time, not called externally), into real receipt
fields — `receiptStatus` and `receiptLogs[].address_`/`topics`/`data`. So
the proof *is* a receipt-inclusion proof, not a bare transaction-inclusion
one: emitter, topics, and success status are all in there.

**What it does not do is stop `ProofGate` from being handed a proof for
someone else's transaction.** Nothing in the precompile or the decoder
restricts which contract's logs a *calling* contract accepts — that's
`ProofGate`'s job, not the precompile's. Assume the precompile proves
inclusion and nothing about intent, and build the consuming contract
accordingly. That assumption is what the checks below are built on.

### The seven checks

`ProofGate.submitOrderProof` runs these in order, each with its own custom
error so a rejection is legible on-chain:

1. **Emitter allowlist** — `ForgedEmitter()`. The log's address must equal
   the deployed `OrderBook`, set immutably at deploy.
2. **topic0 match** — `WrongTopic0()`, against
   `keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)")`.
3. **Topic count == 4** — `WrongTopicCount(count)`. Guards against a
   different event colliding on topic0 (the class of bug where ERC-20 and
   ERC-721 `Transfer` share a topic0 and differ only in topic count).
4. **gameId binding** — `GameNotActive(gameId)`, checked live against
   `FactionMarch.currentState(gameId)` so an order for one game can't
   resolve in another.
5. **Replay protection** — `OrderAlreadyProcessed(orderKey)`, keyed on
   `keccak256(blockHeight, txIndex, logIndex)`, not txHash or block number
   alone — two orders can share a block, so a block-only cursor would let
   one replay the other.
6. **Ordering cursor — deliberately absent.** A monotonic per-game cursor
   here would reject exactly the out-of-order proof arrivals the game
   depends on (see *Arrival order is authority*, below). Documented in the
   contract's own NatSpec, not just here.
7. **Staleness window** — `OrderStale(orderHeight, latestAttestedHeight)`,
   1200 Sepolia blocks (~4 hours), checked against the ChainInfo precompile
   so a hoarded proof from an old game can't be dropped in later.

Every check has a dedicated negative test (forged emitter, wrong topic0,
topic-count mismatch, cross-game order, exact replay, same-block sibling
replay, stale order), all passing — the demo video shows each of these
proofs bouncing on camera.

### Same-tx verify-and-execute

After all seven checks pass, `submitOrderProof` calls
`FactionMarch.resolveOrder(...)` directly, in the same transaction — no
separate settlement step for anyone to front-run or skip. `resolveOrder` is
restricted to the deployed `ProofGate` address via a one-shot
`setProofGate(address)`, callable exactly once by whoever deployed
`FactionMarch`; until it's called, `resolveOrder` fails closed. This is a
narrow setup step, not a standing admin key — it moves no army, captures no
zone, and can never be redirected.

**Arrival order is authority.** Two orders targeting the same zone resolve
in the order their *proofs* land on Creditcoin, not the order they were
sent on Sepolia. Proven, not just asserted: two Foundry tests submit the
same two competing orders' proofs in opposite sequences and get opposite
winners —
`test_arrivalOrder_laterSentOrderWinsBecauseItArrivedFirst` and
`test_arrivalOrder_sentFirstButProvenSecond_loses`. Do not sort by Sepolia
block number "for fairness" — that deletes the mechanic.

### Batching

Proof submission is a permissionless, bountied job — anyone can submit any
proof, the reference courier in `courier/` holds no special key, and a
commander can courier their own order and collect their own bounty.
`submitOrderProofBatch` lands up to 10 proofs sharing one continuity proof
in a single CC3 transaction (`MAX_BATCH_SIZE = 10` is the native
precompile's own hard limit, not a choice made here). Real on-chain
measurement, not a local mock: batching 10 orders costs **56.9% less gas**
than 10 separate submissions (1,695,981 gas actual vs. 3,938,060 projected —
see [`SECURITY.md`](./SECURITY.md#gas-profile-the-batch-path-at-10-queries)).
A single bad order reverts the whole batch by design, so a courier is
incentivized to only bundle orders it's already confident are valid. Two
independent courier processes racing for the same bounty pay out to exactly
one of them — the other's transaction reverts. Batching isn't CLI-only: the
courier board in `web/` lets anyone tick multiple attested, valid orders and
submit them as one batch straight from the browser (`ProofGate.submitOrderProofBatch`,
same call the CLI makes), fetching the shared continuity proof from the same
prover REST endpoint the CLI uses (`POST /api/v1/proof-batch-by-tx`), called
directly rather than through `@gluwa/usc-sdk` for the same browser-bundle
reason as single-order proofs (see *Frontend*, below).

---

## The game

Three factions, 12 zones, each `{ owner, garrison }`. Faction assignment
auto-balances on join. A zone always has an owner once first taken — it
changes hands but never reverts to neutral. Combat is deterministic:
attacker beats garrison, zone flips with survivors as the new garrison;
attacker loses, garrison shrinks. No randomness — the fog comes from
`ProofGate`'s ~9-minute march time (see *Networks*, below), not from dice.
Game lifecycle (`OPEN → ACTIVE → SETTLED`) is computed from block number,
not stored, so no transaction is ever needed to "advance" it.

Order fees accrue to a per-game war chest, split across factions by
territory held. A faction can borrow against proven territory —
`WarChest.sol` — to fund an offensive beyond its chest balance, with no
separate collateral posted: territory read live from `FactionMarch` *is*
the collateral. A draw must be repaid within `REPAYMENT_WINDOW_BLOCKS`
(5000 blocks on the current deployment) of being taken, or the line
defaults automatically — computed from the block number like everything
else here, no transaction required to trigger it. Defaulting zeroes the
credit limit immediately, and even after it's repaid and cleared, permanently
cuts the faction's multiplier by 30% *per lifetime default* — it does not
reset. Every resolved order also writes to an on-chain commander reputation
record (orders issued, proven, bounties claimed, debts repaid). This is the
credit thesis: an undercollateralised credit primitive that's played, not
pitched, on a credit chain.

The frontend (`web/`) is a zone map with ownership history, an order
composer, a paginated courier board (single-order *and* in-browser batch
submission — see *Batching*, above) that flags doomed proofs before anyone
wastes real gas on them — an out-of-range zone or, just as fatal, a
commander who never joined the game (`resolveOrder` reverts with
`NotJoined` either way) — a war chest/credit panel showing each faction's
live due-block countdown and default consequences, a connected wallet's own
on-chain reputation pulled straight from `WarChest.reputations`, and — the
single most important screen — an in-flight panel with a live ticking clock,
so the UI never implies instant resolution.

---

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `OrderBook` | Sepolia | [`0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F`](https://sepolia.etherscan.io/address/0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F#code) — verified, orderFee 0.0005 ETH, treasury `0x9d4eF81F5225107049ba08F69F598D97B31ea644` |
| `FactionMarch` | Creditcoin CC3 | `0xB8Fde830fF968E56528539505243da22ce59b628` — game board, `resolveOrder` restricted to `ProofGate` below; only one game may be OPEN/ACTIVE at a time (`createGame` reverts with `PreviousGameNotSettled` otherwise), open duration capped at `MAX_OPEN_DURATION_BLOCKS` (3600), active duration capped at `MAX_ACTIVE_DURATION_BLOCKS` (28,800) |
| `WarChest` | Creditcoin CC3 | `0xF1eD07B6A8406E2b0B7D8FE072C64740aCdf24C4` — credit line + reputation, reads territory from `FactionMarch` above, repayment window 5000 blocks |
| `ProofGate` | Creditcoin CC3 | `0x58ef7793d058d7F2e11DCe57747bEf6D1d487778` — hardened, wired to `FactionMarch` and `WarChest` above, allowlists `OrderBook` above, staleness window 1200 blocks, bounty 0.0001 CTC/order, bounty pool funded with 0.01 CTC |

Superseded addresses, kept only as a record of earlier iterations (see `spikes/FINDINGS.md`): `ProofGate` unguarded, no emitter check `0x296Ecf33a2c64F7A858133E60aC5d732Cd1b654c`; `ProofGate` hardened, before `FactionMarch` wiring `0x9fe147c23600CFcB7dd0DAEc4670d96868142744`; `FactionMarch` no access control `0x871F283Cf322F0206FE6424EE01529E186270eb5`; `ProofGate`/`FactionMarch` wired, no bounty/batching `0x0739BA644E4a25e529B04b870b54958c4C25131d` / `0x3181cFd3D6927656797208C20848c2B623bbf223`; `ProofGate`/`FactionMarch` bounty/batching, no `WarChest` `0x1BDA513AC071A6736Bb5569499CE9a7D96c3E0bc` / `0x92b474811aC11EbfFdcc21fc240993b46909ae69`; `ProofGate`/`FactionMarch`/`WarChest` wired, no game-exclusivity rule (any number of games could be OPEN/ACTIVE at once) `0xcEd503d0Eeb04C13F8974CaA85d06A22f0441C88` / `0xEf7Cc55BD1bF5c836D4CcD0c3d108415a6Bc18Ba` / `0x54C3901F43d1ab2694357D304e6dAc1671Cf10a2`.

## Networks

| | Sepolia (source) | Creditcoin CC3 (execution) |
|---|---|---|
| EVM chainId | 11155111 | 102031 |
| RPC alias (foundry) | `sepolia` | `creditcoin-cc3` |
| RPC URL | your `SOURCE_CHAIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` |
| `Hello.sol` smoke deploy | [`0xdcd00274619938e6467c0f8550209d81e8d5ee52`](https://sepolia.etherscan.io/address/0xdcd00274619938e6467c0f8550209d81e8d5ee52) | `0x33ba2c273a55c8a3766b597c1c9343b8e9a05f97` |

**Real measured latency, not a rounded estimate:** broadcast → mined on
Sepolia 15.1 s, mined → Creditcoin attestation 508.9 s (~8.5 min), proof
generation 0.7 s, on-chain verify 7.4 s — **8.88 minutes total, broadcast to
verified.** This is march time. The deck and demo state this number as
measured, not an inflated "instant" resolution claim.

Note: `contracts/creditcoin/foundry.toml` pins `evm_version = "london"` —
CC3's Frontier/Substrate EVM pallet doesn't populate the post-merge
`prevrandao` header field, which otherwise makes forge's local script
simulation fail with `header validation error: prevrandao not set`.

## Layout

| Path | What |
|---|---|
| `contracts/source/` | Foundry project for Ethereum Sepolia (`OrderBook.sol`) |
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`ProofGate.sol`, `FactionMarch.sol`, `WarChest.sol`) |
| `courier/` | Node/TS proof-delivery scripts — `place-and-relay.ts` is the reference courier |
| `web/` | React + Vite frontend — no backend, reads/writes contracts directly from the browser |
| `spikes/` | Feasibility research scripts and findings |

## Setup

```sh
npm install
cp .env.example .env   # fill in RPC URLs / a throwaway funded key, see spikes/README.md
```

Chain-info spike (no wallet needed):

```sh
npm run spike:chain-info
```

Full attestation round-trip (needs a funded throwaway wallet — see `spikes/README.md`):

```sh
npm run spike:full
```

Contracts:

```sh
npm run build:contracts
npm run test:contracts
```

Vertical slice — creates and joins a FactionMarch game if none is given, places a real Sepolia order, and relays it end to end, reporting the bounty paid (needs `ORDER_BOOK_ADDRESS`/`PROOF_GATE_ADDRESS`/`FACTION_MARCH_ADDRESS` in `.env`, and `npm run build:contracts` first so the courier can read the compiled ABIs from `out/`):

```sh
npm run courier:place-and-relay -- <zoneId> <units> [gameId]
```

Batch courier — places up to 10 orders back to back, waits once, and lands all of them in a single CC3 transaction with one shared continuity proof:

```sh
npm run courier:batch-relay -- <count> [gameId]
```

Frontend — zone map, order composer, in-flight panel, courier board, and war chest, all reading the deployed contracts live (no `.env` needed; addresses/RPCs are public and hardcoded in `web/src/config.ts`):

```sh
npm run web:dev     # opens on http://localhost:5173
```

Needs an injected wallet (MetaMask or similar) added to both Sepolia and Creditcoin CC3 to place orders, join games, or submit proofs — the read-only screens (zone map, war chest, in-flight/resolved orders) work without connecting anything. If contracts are redeployed, re-extract the ABIs the frontend imports:

```sh
node -e "const fs=require('fs');for(const [n,p] of Object.entries({OrderBook:'contracts/source/out/OrderBook.sol/OrderBook.json',FactionMarch:'contracts/creditcoin/out/FactionMarch.sol/FactionMarch.json',ProofGate:'contracts/creditcoin/out/ProofGate.sol/ProofGate.json',WarChest:'contracts/creditcoin/out/WarChest.sol/WarChest.json'})){fs.writeFileSync('web/src/abis/'+n+'.json',JSON.stringify(JSON.parse(fs.readFileSync(p)).abi,null,2))}"
```
