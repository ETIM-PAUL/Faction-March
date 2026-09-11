# Faction March

A faction territory war where orders are Sepolia transactions that only take
effect once someone proves them to Creditcoin. See
[`faction-march-build-plan.md`](./faction-march-build-plan.md) for the full
design and phase-by-phase build plan.

**Status: Phase 1 done — real send/attest/prove/verify round trip measured
at ~8.9 min. Phase 2 done — both networks build, test, and deploy cleanly.
Phase 3 done — `OrderBook.sol` deployed to Sepolia, pending Etherscan
verification (needs `ETHERSCAN_API_KEY`).** See
[`spikes/FINDINGS.md`](./spikes/FINDINGS.md) for Phase 1 results.

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `OrderBook` | Sepolia | [`0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F`](https://sepolia.etherscan.io/address/0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F) — orderFee 0.0005 ETH, treasury `0x9d4eF81F5225107049ba08F69F598D97B31ea644` |

Phase 5's `ProofGate` allowlists this exact address as the only emitter it accepts `OrderPlaced` proofs from.

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
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`FactionMarch.sol`, `ProofGate.sol`, `WarChest.sol`) |
| `courier/` | Node/TS proof-delivery daemon (Phase 8) |
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
