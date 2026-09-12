# Faction March

A faction territory war where orders are Sepolia transactions that only take
effect once someone proves them to Creditcoin. See
[`faction-march-build-plan.md`](./faction-march-build-plan.md) for the full
design and phase-by-phase build plan.

**Status: Phases 1-9 done.** Real send/attest/prove/verify round trip
measured at ~8.9 min (Phase 1). Both networks build, test, and deploy
cleanly (Phase 2). `OrderBook.sol` verified on Sepolia (Phase 3). Full
place→attest→prove→relay slice runs end to end via one courier command
(Phase 4). `ProofGate` is hardened — emitter allowlist, topic0/topic-count
checks, gameId binding, fine-grained replay protection, and a staleness
window, each with its own on-chain error and a dedicated negative test
(Phase 5). `FactionMarch.sol` — 3-faction auto-balanced board, replenishing
unit pools, block-driven OPEN→ACTIVE→SETTLED lifecycle, capture/reinforce/grind
combat (Phase 6). `ProofGate` now calls `FactionMarch.resolveOrder` in the
same transaction as verification, restricted by a one-shot access-control
wiring step, with an integration test proving competing orders resolve in
*proof-arrival* order, not Sepolia send order (Phase 7). Proof submission is
now a permissionless, bountied job — a fixed CTC bounty per order, a batch
entry point handling up to 10 proofs sharing one continuity proof, and a
test proving two couriers racing for the same order pays exactly one of
them (Phase 8). `WarChest.sol` — an undercollateralised credit line backed
by proven territory: borrow against zones held, default when the repayment
window passes, a permanent penalty that survives clearing, and an on-chain
commander reputation record fed authentically from `ProofGate` in the same
transaction as every resolved order (Phase 9). See
[`spikes/FINDINGS.md`](./spikes/FINDINGS.md) for details.

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `OrderBook` | Sepolia | [`0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F`](https://sepolia.etherscan.io/address/0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F#code) — verified, orderFee 0.0005 ETH, treasury `0x9d4eF81F5225107049ba08F69F598D97B31ea644` |
| `FactionMarch` | Creditcoin CC3 | `0xEf7Cc55BD1bF5c836D4CcD0c3d108415a6Bc18Ba` — game board, `resolveOrder` restricted to `ProofGate` below |
| `WarChest` | Creditcoin CC3 | `0x54C3901F43d1ab2694357D304e6dAc1671Cf10a2` — credit line + reputation, reads territory from `FactionMarch` above, repayment window 50 blocks (demo-scale — production default is 5000) |
| `ProofGate` | Creditcoin CC3 | `0xcEd503d0Eeb04C13F8974CaA85d06A22f0441C88` — hardened, wired to `FactionMarch` and `WarChest` above, allowlists `OrderBook` above, staleness window 1200 blocks, bounty 0.0001 CTC/order, bounty pool funded with 0.01 CTC |

Superseded addresses, kept only as a record of what each phase demonstrated (see `spikes/FINDINGS.md`): `ProofGate` Phase 4 (unguarded, no emitter check) `0x296Ecf33a2c64F7A858133E60aC5d732Cd1b654c`; `ProofGate` Phase 5 (hardened, before FactionMarch wiring) `0x9fe147c23600CFcB7dd0DAEc4670d96868142744`; `FactionMarch` Phase 6 (no access control) `0x871F283Cf322F0206FE6424EE01529E186270eb5`; `ProofGate`/`FactionMarch` Phase 7 (wired, no bounty/batching) `0x0739BA644E4a25e529B04b870b54958c4C25131d` / `0x3181cFd3D6927656797208C20848c2B623bbf223`; `ProofGate`/`FactionMarch` Phase 8 (bounty/batching, no WarChest) `0x1BDA513AC071A6736Bb5569499CE9a7D96c3E0bc` / `0x92b474811aC11EbfFdcc21fc240993b46909ae69`.

## Networks

| | Sepolia (source) | Creditcoin CC3 (execution) |
|---|---|---|
| EVM chainId | 11155111 | 102031 |
| RPC alias (foundry) | `sepolia` | `creditcoin-cc3` |
| RPC URL | your `SOURCE_CHAIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` |
| `Hello.sol` smoke deploy | [`0xdcd00274619938e6467c0f8550209d81e8d5ee52`](https://sepolia.etherscan.io/address/0xdcd00274619938e6467c0f8550209d81e8d5ee52) | `0x33ba2c273a55c8a3766b597c1c9343b8e9a05f97` |

Note: `contracts/creditcoin/foundry.toml` pins `evm_version = "london"` —
CC3's Frontier/Substrate EVM pallet doesn't populate the post-merge
`prevrandao` header field, which otherwise makes forge's local script
simulation fail with `header validation error: prevrandao not set`.

## Layout

| Path | What |
|---|---|
| `contracts/source/` | Foundry project for Ethereum Sepolia (`OrderBook.sol`, Phase 3) |
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`ProofGate.sol`, `FactionMarch.sol`, `WarChest.sol` all done) |
| `courier/` | Node/TS proof-delivery scripts — `place-and-relay.ts` is the reference courier |
| `web/` | Frontend (Phase 10) |
| `spikes/` | Phase 1 feasibility scripts and findings |

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
