# Faction March

**Track:** Gaming (primary) + DeFi (`WarChest`'s undercollateralized credit line and territory yield). Built for **BUIDL CTC 2026 Fall**, themed on the Attestcoin Protocol (formerly USC).

An Attestcoin-secured territory war: orders are real Sepolia transactions, and they only take effect once someone proves them to Creditcoin CC3. Three factions fight over a fixed 10-zone board; combat resolves live, in the same transaction that verifies the proof; and a faction's proven territory becomes real financial leverage — cheaper proof fees, borrowing power, and a direct share of the game's own activity.

## The problem

Cross-chain apps usually need something to trust. A bridge, a relayer, an oracle committee — some intermediary that reports "this happened on chain A" to chain B, and chain B just believes it. That intermediary is the actual attack surface; the largest class of cross-chain exploits targets exactly this trust boundary, not bugs in the chains themselves. Attestcoin's answer is a block-prover precompile: Creditcoin can cryptographically verify a Sepolia transaction's inclusion directly, no intermediary to compromise.

That's a real primitive, but a primitive alone doesn't prove much. Most demonstrations of cross-chain attestation are toy examples — prove a number, prove a balance — with nothing real riding on the outcome. Toy examples don't surface the failure modes that matter once actual value and actual adversaries are involved: forged emitters, replayed proofs, cross-context injection, front-running, censorship, staleness. Faction March exists to put real stakes behind the primitive — real ETH spent placing orders, real CTC paid proving them, real competitive incentive to cheat — and see what breaks. Nine concrete adversarial cases got found and fixed this way (documented in `SECURITY.md`), not hypothesized.

The second, smaller problem: undercollateralized DeFi lending needs a trustworthy signal of creditworthiness, and locking collateral is the usual workaround for not having one. `WarChest` shows an alternative — a faction's territory is itself the output of cryptographically-attested actions, so it can't be faked, and it can stand in as collateral directly.

## Architecture

Two chains, one off-chain proof-relay step, and no gameplay backend — nothing about who won a fight, who owns a zone, or who can borrow lives anywhere but the two chains themselves:

```
 Sepolia                          Creditcoin CC3
 --------                          --------------
 OrderBook.sol                     block-prover precompile
 commitOrder() / revealOrder()     verifies tx inclusion, decodes the
   |                               receipt via Gluwa's EvmV1Decoder
   | OrderRevealed event                |
   +----------------(proven by)-------->|
                                         v
                                  ProofGate.sol  --resolves in the same tx-->  FactionMarch.sol
                                  (7 checks, then                             (combat, live,
                                   pays the chest fee)                        arrival-order authority)
                                         |
                                         v
                                  WarChest.sol
                                  (credit, per-order fee discount,
                                   territory yield)

                                                          Supabase (faction chat only)
                                                          Edge Function re-derives faction
                                                          membership from a live CC3 read —
                                                          never trusts its own database for it
```

The frontend (`web/`) reads and writes both chains' contracts directly from the connected wallet. Supabase's only job is faction chat, and even there it doesn't get the final word on who belongs to which faction — every session is minted only after a fresh on-chain check.

## How it works, step by step

1. **Commit.** A commander calls `OrderBook.commitOrder(gameId, zoneId, commitHash)` on Sepolia, paying a flat ETH fee. `commitHash = keccak256(abi.encode(units, salt))` — the zone is public, the army size isn't.
2. **Reveal.** Whenever the commander is ready to have the order proven, they call `revealOrder(nonce, units, salt)` — this lives in the Courier board now, presented as the first step toward proving, not a free-floating action taken far in advance. `OrderRevealed` is the event everything downstream proves against.
3. **Prove.** Anyone — a courier, no privileged role, can be the commander themselves — fetches a Merkle + continuity proof from the prover once Creditcoin has attested the relevant Sepolia block, and submits it to `ProofGate.submitOrderProof` (or the batched version, up to 10 orders sharing one continuity proof).
4. **Verify.** `ProofGate` runs 7 checks in order — emitter allowlist, topic0 match, topic-count match, live gameId binding, exact replay guard (deliberately *no* ordering cursor — that would break the mechanic below), staleness window (~4 hours) — each with its own custom error so a rejection is legible on-chain.
5. **Resolve.** Still inside the same transaction, `ProofGate` calls `FactionMarch.resolveOrder`. Combat is deterministic: attacker beats garrison → zone flips, survivors become the new garrison; attacker loses → garrison shrinks. No separate settlement step exists for anyone to front-run or skip.
6. **Pay.** The courier's native CTC fee — discounted per order by that order's own commander's current territory tier — is deposited into the game's `WarChest`, which immediately splits 30% of it across factions by current zones held.

**Arrival order is authority**, not send order: two orders targeting the same zone resolve in the order their *proofs* land on Creditcoin, regardless of which was placed on Sepolia first. Proven with two tests that submit the same competing orders in opposite sequences and get opposite winners — sorting by Sepolia send time "for fairness" would delete the actual mechanic.

## Key mechanics

**Commit-reveal orders.** Hiding units end-to-end (until game end) would force every order into one giant batch resolution at settlement — a different game, since live arrival-order combat depends on proofs landing throughout. Instead, units are hidden only for the span that matters: the flight between commit and reveal. The commander controls reveal timing entirely; nothing auto-reveals.

**Two hard caps, different in kind.** `MAX_UNIT_POOL` (500) bounds a commander's total strength over time and refills — temporary, waitable. `MAX_UNITS_PER_ORDER` (10) bounds a single order permanently — no wait ever raises it. Together they mean wealth buys more *orders*, never one overwhelming strike.

**WarChest — territory as leverage, three ways.**
- *Cheaper fees:* 3/6/9 zones held → 5%/10%/20% off the courier's proof fee, applied live per order to whichever faction that order's own commander belongs to. Because the discount is read *after* combat resolves, an order that itself captures the qualifying zone already earns its own discount — which a courier's pre-flight fee estimate can't foresee, so `ProofGate` accepts `msg.value` at or above the true required total and refunds the difference rather than demanding an exact, unpredictable match.
- *Borrowing power:* `creditLimit = zonesHeld × 0.001 CTC`, adjusted +2% per completed repayment and −30% per lifetime default (permanent). No separate collateral is posted — territory that can only exist because it was cryptographically proven *is* the collateral. A draw not repaid within the repayment window defaults automatically, computed from block number, no transaction required to trigger it.
- *Direct yield:* every `depositToChest` call — a manual top-up or a courier's proof fee — immediately splits 30% across Alpha/Beta/Gamma by *current* zones held, credited as claimable yield. Splitting at the instant funds land (not a claim-time snapshot) is what makes sniping a zone right before a big deposit unprofitable for that specific deposit: a faction only ever earns a share of CTC that arrives after it already held the ground.

**One game at a time, on-chain.** `createGame` reverts with `PreviousGameNotSettled` unless the latest game has actually settled — the UI never has to make an ambiguous choice about which of several live games is "the" game. Every game is a fixed 10 zones, ~10 minutes to join, ~30 minutes active, with duration caps bounding the worst-case lockout if a game were ever misconfigured.

**Faction chat, genuinely gated.** `faction_messages` has RLS enabled with zero grants to `anon`/`authenticated` — unreachable through Supabase's public API no matter what, confirmed live (`permission denied`, not an empty result). The only way in is an Edge Function that verifies an EIP-191 wallet signature, then reads `FactionMarch.commanderFaction` live from Creditcoin before minting a short-lived session scoped to exactly the faction that call returns. A validly-signed request from a wallet that never joined gets a real 403.

**Courier board.** Flags "doomed" proofs — invalid zone, commander never joined, order over the unit cap — before anyone spends real gas on something guaranteed to revert. Shows each faction's current zones-held → discount live, and supports both single and batched submission straight from the browser.

## Built for real, not just tested for real

91 Foundry tests pass across both Foundry projects. Every one of `ProofGate`'s 7 checks has a dedicated negative test, and `SECURITY.md` documents 9 adversarial findings against the full system — forged emitter, replay, cross-game injection, front-running the bounty, censorship, griefing — each Mitigated (named test), Accepted, or Inherited from the protocol. Gas figures quoted anywhere in the docs come from real `cast receipt` data on live transactions, not local-mock estimates (the mocked precompile in Foundry is a trivial always-`true` stub that doesn't reflect real proof-verification cost). Every major mechanic — arrival-order authority, batching, the fee discount, commit-reveal, faction chat's access control — has also been live-verified against real testnet state on top of the unit-test suite, not just asserted from it.

## Deployed contracts (Sepolia / Creditcoin CC3)

| Contract | Address |
|---|---|
| `OrderBook` (Sepolia) | `0xa9842871a176feeA29590de1A71DE829940FfC36` |
| `FactionMarch` (CC3) | `0xba618275A71ea261cAbA7294e742589723aEC1AE` |
| `WarChest` (CC3) | `0xcd3A69f231c93f37A2A7f61D5B5F58850850a045` |
| `ProofGate` (CC3) | `0x8ff40DBA12240379e431eD7a927D16413717F6B8` |

Full superseded-address history and phase-by-phase build log: `README.md` / `spikes/FINDINGS.md`.

## Stack

Solidity ^0.8.28 (Foundry) · Attestcoin block-prover precompile + Gluwa's `EvmV1Decoder` · React + Vite + TypeScript frontend, wallet-only, no backend for gameplay · Supabase (Postgres + Deno Edge Functions), scoped to faction chat only.

## Originality

The faction/zone/war-chest skeleton — proof-arrival resolution in `OrderBook.sol`, `ProofGate.sol`, `FactionMarch.sol`'s Attestcoin wiring, and `WarChest.sol` — is a new codebase written fresh for BUIDL CTC 2026 Fall, and is the actual subject of this submission.
