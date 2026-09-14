# Build details — Faction March

Technical companion to [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) (the pitch) and [`README.md`](README.md) (the full write-up). This is the shape of what got built.

## Architecture

Two chains, one off-chain proof service, no gameplay backend:

```
Sepolia                Creditcoin CC3                  Supabase
--------                --------------                  --------
OrderBook.sol   --tx--> block-prover precompile   
(commit/reveal)         verifies inclusion via     
                         EvmV1Decoder, feeds        
                         ProofGate.sol       ------> FactionMarch.sol (combat,
                                                      resolved live, same tx)
                                                          |
                                                          v
                                                      WarChest.sol (credit,
                                                      discounts, territory yield)

                                                      faction-chat Edge Function
                                                      <-- verifies commanderFaction
                                                          live on CC3 before minting
                                                          a session, gates a Postgres
                                                          table with zero RLS grants
```

The frontend (`web/`) talks to both chains' contracts directly from the browser via the connected wallet — no server holds game state. Supabase is used for exactly one thing (faction chat) and is never trusted for membership; it re-derives that from a live on-chain read every session.

## Components

**`OrderBook.sol`** (Sepolia) — the only place a commander spends real ETH. `commitOrder(gameId, zoneId, commitHash)` locks in a zone and pays a flat fee against `keccak256(abi.encode(units, salt))`, exposing nothing. `revealOrder(nonce, units, salt)` — committer-only, exactly once — exposes the real unit count and emits `OrderRevealed`, the event the rest of the pipeline proves against.

**`ProofGate.sol`** (Creditcoin CC3) — the trust boundary. `submitOrderProof`/`submitOrderProofBatch` run 7 checks (emitter allowlist, topic0, topic count, live gameId binding, exact replay guard, no ordering cursor by design, staleness window) against a proof from the block-prover precompile, then call `FactionMarch.resolveOrder` in the same transaction. Also computes and collects the courier's chest fee, discounted per-order by the order's own commander's current `WarChest.discountBps` — read *after* `resolveOrder`, so an order that itself captures a discount-qualifying zone already earns that discount, which a caller's pre-flight estimate can't predict. Both entry points accept `msg.value` at or above the true required total and refund the excess, rather than requiring an exact (and structurally unpredictable) match.

**`FactionMarch.sol`** (Creditcoin CC3) — the board. Games are `{ zoneCount, activeStartBlock, settleBlock }`, lifecycle computed purely from `block.number` (no "advance" transaction). One game may be OPEN/ACTIVE at a time. `resolveOrder` is restricted to `ProofGate` via a one-shot `setProofGate`, and resolves combat live: attacker beats garrison → zone flips with survivors; attacker loses → garrison shrinks. Arrival order (of the *proof*, not the Sepolia send) is authority.

**`WarChest.sol`** (Creditcoin CC3) — the credit + territory-payout layer, reading `FactionMarch` as a pure consumer, no changes needed there. Territory does three things:
- **`discountBps`** — 3/6/9 zones held → 5%/10%/20% off `CHEST_FEE_PER_ORDER`, applied by `ProofGate` at proof time.
- **`creditLimit`** — `zonesHeld × 0.001 CTC`, adjusted ±by reputation (+2%/repay, −30%/lifetime default), no separate collateral posted since territory itself can't be faked.
- **Territory yield** — every `depositToChest` call (manual top-up or a courier's proof fee) immediately splits 30% (`YIELD_SHARE_BPS`) across Alpha/Beta/Gamma by *current* zones held, credited to `claimableYield` and pulled via `claimYield`. Splitting at the instant funds land (not a claim-time snapshot) makes sniping a zone right before a big deposit unprofitable for that specific deposit — you only earn a share of CTC that arrives after you already held the ground. Debt repayments are exempt from a second split (that CTC already passed through once, on the way in).

**`web/`** — React + Vite. Zone map, commit-order composer, courier board (reveal, doomed-proof detection, single/batch submission, live discount display), war chest panel, in-flight/resolved panel, faction chat. Reads are wallet-free (public RPCs); writes go through the connected wallet's own provider on whichever chain is relevant.

**`supabase/`** — one Postgres table (`faction_messages`, RLS enabled, zero grants to `anon`/`authenticated` — unreachable through the public API by construction) and one Edge Function (`faction-chat`) that verifies an EIP-191 signature, reads `commanderFaction` live from CC3, and mints a short-lived HMAC session scoped to exactly the faction that call returns.

**`courier/`** — Node/TS reference implementation of the same permissionless proof-relay role the browser's courier board plays: `place-and-relay.ts` (single order) and `batch-relay.ts` (up to 10, one shared continuity proof, one CC3 transaction).

## Repo layout

| Path | What |
|---|---|
| `contracts/source/` | Foundry project for Sepolia (`OrderBook.sol`) |
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`ProofGate.sol`, `FactionMarch.sol`, `WarChest.sol`) |
| `courier/` | Node/TS proof-delivery scripts |
| `web/` | React + Vite frontend |
| `supabase/` | Faction chat backend (migrations + Edge Function) |
| `spikes/` | Feasibility research scripts and the phase-by-phase build log (`FINDINGS.md`) |

## Stack

Solidity ^0.8.28 (Foundry) · Attestcoin block-prover precompile + Gluwa's `EvmV1Decoder` · ethers v6 · React + Vite + TypeScript, no gameplay backend · Supabase (Postgres + Deno Edge Functions), scoped to chat only.

## Testing

91 Foundry tests passing across both Foundry projects (`OrderBook.t.sol` + the Creditcoin suite: `FactionMarch.t.sol`, `WarChest.t.sol`, `ProofGate.t.sol`). Every one of `ProofGate`'s 7 checks has a dedicated negative test; `SECURITY.md` documents 9 adversarial findings against the full system, each Mitigated (with the exact test name), Accepted, or Inherited from the protocol. Gas numbers quoted anywhere in the docs are pulled from real `cast receipt` data on live transactions, not local-mock estimates — the mocked block-prover precompile used in Foundry is a trivial always-`true` stub that doesn't reflect real proof-verification cost. Every major mechanic (arrival-order authority, batching, the chest-fee discount, commit-reveal, faction chat's access control) has also been live-verified against real testnet state — via `cast`, or via Playwright with a mocked EIP-1193 provider bridged to a real funded `ethers.Wallet` for write paths — not just asserted from passing unit tests.

## Deployment

Redeploying `FactionMarch` forces a cascade, since `WarChest` reads it at construction and `ProofGate` is wired to both: `FactionMarch` → `WarChest` → `ProofGate`, then a one-shot `setProofGate` call on both `FactionMarch` and `WarChest`. That wiring step reliably flakes on CC3's scripted `forge script` broadcast (transaction planned but not landing, no revert reason) — recovered every time by retrying it directly via `cast send`, then confirming both contracts' `proofGate()` reads on-chain before moving on. ABIs are re-extracted from Foundry's `out/` into `web/src/abis/` after every contract change (one-liner in `README.md`'s Setup section).

### Current live deployment (Sepolia / Creditcoin CC3)

| Contract | Address |
|---|---|
| `OrderBook` (Sepolia) | `0xa9842871a176feeA29590de1A71DE829940FfC36` |
| `FactionMarch` (CC3) | `0xba618275A71ea261cAbA7294e742589723aEC1AE` |
| `WarChest` (CC3) | `0xcd3A69f231c93f37A2A7f61D5B5F58850850a045` |
| `ProofGate` (CC3) | `0x8ff40DBA12240379e431eD7a927D16413717F6B8` |

Full superseded-address history: `README.md`'s Deployed Contracts section.

## Known gap

`courier/src/place-and-relay.ts` and `courier/src/batch-relay.ts` (the CLI reference courier) still send a flat `CHEST_FEE_PER_ORDER` rather than computing the live discounted amount the browser's courier board does — they'll misbehave against a commander holding any territory until updated to match.

## Running it

```sh
npm install
cp .env.example .env        # RPC URLs + a throwaway funded key
npm run build:contracts && npm run test:contracts
npm run web:dev              # http://localhost:5173, no .env needed — addresses are public in web/src/config.ts
```

See `README.md`'s Setup section for the CLI courier scripts and the ABI re-extraction one-liner.
