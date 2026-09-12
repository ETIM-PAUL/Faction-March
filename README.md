# Faction March

A faction territory war where orders are Sepolia transactions that only take
effect once someone proves them to Creditcoin. See
[`faction-march-build-plan.md`](./faction-march-build-plan.md) for the full
design and phase-by-phase build plan.

**Status: Phases 1-6 done.** Real send/attest/prove/verify round trip
measured at ~8.9 min (Phase 1). Both networks build, test, and deploy
cleanly (Phase 2). `OrderBook.sol` verified on Sepolia (Phase 3). Full
place→attest→prove→relay slice runs end to end via one courier command
(Phase 4). `ProofGate` is hardened — emitter allowlist, topic0/topic-count
checks, gameId binding, fine-grained replay protection, and a staleness
window, each with its own on-chain error and a dedicated negative test
(Phase 5). `FactionMarch.sol` — 3-faction auto-balanced board, replenishing
unit pools, block-driven OPEN→ACTIVE→SETTLED lifecycle, capture/reinforce/grind
combat — is live and fully tested via direct calls, no proofs involved yet
(Phase 6). See [`spikes/FINDINGS.md`](./spikes/FINDINGS.md) for details.

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `OrderBook` | Sepolia | [`0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F`](https://sepolia.etherscan.io/address/0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F#code) — verified, orderFee 0.0005 ETH, treasury `0x9d4eF81F5225107049ba08F69F598D97B31ea644` |
| `ProofGate` | Creditcoin CC3 | `0x9fe147c23600CFcB7dd0DAEc4670d96868142744` — hardened (Phase 5), allowlists `OrderBook` above, staleness window 1200 blocks |
| `FactionMarch` | Creditcoin CC3 | `0x871F283Cf322F0206FE6424EE01529E186270eb5` — game board (Phase 6). `resolveOrder` is **not yet access-controlled**; Phase 7 restricts it to `ProofGate` |

`ProofGate`'s earlier, deliberately-unguarded Phase 4 build lived at `0x296Ecf33a2c64F7A858133E60aC5d732Cd1b654c` — superseded, kept here only as a record of the trap it demonstrated (see `spikes/FINDINGS.md`).

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
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`ProofGate.sol` hardened, `FactionMarch.sol` done; `WarChest.sol` upcoming) |
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

Vertical slice — places a real order and relays it end to end, registering the game on `ProofGate` first if needed (needs `ORDER_BOOK_ADDRESS`/`PROOF_GATE_ADDRESS` in `.env`, and `npm run build:contracts` first so the courier can read the compiled ABIs from `out/`):

```sh
npm run courier:place-and-relay -- <gameId> <zoneId> <units>
```
