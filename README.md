# Faction March

**Track:** Gaming — a territory war with permanent, provably-resolved
captures. Also demonstrates the DeFi track: `WarChest.sol` is an
undercollateralised credit line backed by proven territory. Built for
**BUIDL CTC 2026 Fall**, themed on the Attestcoin Protocol (formerly USC).

- **Demo video:** https://app.screencastify.com/watch/Lkm77diol5mTP0df18Te
- **Deck / whitepaper:** https://drive.google.com/file/d/1ISdR8eNg7nR64Xh-mWYRWNQw9BmXSwQP/view?usp=sharing

An Attestcoin-secured territory war: orders are Sepolia transactions, and
they only take effect once someone proves them to Creditcoin CC3. This
README leads with that integration — what it proves, how it's hardened,
and how it resolves in the same transaction it verifies — before getting to
the game itself.

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
   `keccak256("OrderRevealed(address,uint256,uint16,uint32,uint64)")` (the
   event `OrderBook`'s commit/reveal split emits once units are actually
   exposed — see *The game*, below; same shape the single-phase
   `OrderPlaced` this replaced used to have, so nothing else in this check
   list changed).
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
than 10 separate submissions.
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
attacker loses, garrison shrinks. No randomness — the fog comes from two
things, both real: `ProofGate`'s ~9-minute march time, and units genuinely
hidden until the commander chooses to reveal them (below) — not from dice.
Game lifecycle (`OPEN → ACTIVE → SETTLED`) is computed from block number,
not stored, so no transaction is ever needed to "advance" it.

**Orders are commit/reveal, not single-shot — units are genuinely hidden,
not just hidden in the UI.** `OrderBook.commitOrder(gameId, zoneId,
commitHash)` locks in a zone and pays the fee against
`keccak256(abi.encode(units, salt))`, exposing nothing about army size to
anyone watching Sepolia. `OrderBook.revealOrder(nonce, units, salt)` exposes
the real count later, whenever the commander chooses — and it's the reveal
transaction, not the commit, that a courier actually proves (`ProofGate` now
checks for `OrderRevealed`, decoded exactly the way it used to decode the
single-phase `OrderPlaced`). This is why the design isn't "hide units until
the game ends": that would mean nothing is provable until `SETTLED`, forcing
every order into one giant batch resolution at game end instead of the live,
one-proof-at-a-time captures this game is actually built on (see *arrival
order is authority*, above) — a different game, not a bigger version of this
one. Hiding until reveal instead keeps every existing resolution mechanic
intact while still denying an opponent the one thing that would let them
out-reinforce an incoming attack before it lands: how large it actually is.
The salt lives only in the revealer's own browser (`localStorage`, never
sent anywhere until reveal) — lose it and that specific order can never be
revealed, no recovery path, by design: a recoverable secret isn't one. Two
honest limits, not hidden: a public mempool means a reveal transaction's
calldata is visible to anyone watching *before* it's mined, not only after
(this can't be fixed without a private relay, which is out of scope here);
and once revealed, a resolved zone's garrison is exactly as public as it
always was — there's no scheme that keeps *settled* combat outcomes secret,
only the *unresolved* order leading up to one.

**A flat order fee doesn't buy a bigger army — that's deliberate.** The
Sepolia order fee (0.0005 ETH) is priced per *action*, not per unit: it costs
the same whether the order requests 1 unit or 1,000,000. What actually
rations combat power is a pair of separate, purely on-chain mechanisms —
`FactionMarch`'s per-commander unit pool, `UNITS_PER_BLOCK = 1` regenerating
up to a total `MAX_UNIT_POOL = 500`, *and* a tighter `MAX_UNITS_PER_ORDER = 10`
ceiling on any single order regardless of how large the pool has grown. The
two caps are different knobs on purpose: the pool bounds total strength built
up over time, the per-order cap forces a large attack into several separate
orders — each one its own proof, its own arrival-order race, its own chance
for a defender's reinforcement to land first and flip the outcome (see
*arrival order is authority*, above). An order over 10 units isn't cheap
firepower; it's a transaction guaranteed to revert with
`ExceedsMaxUnitsPerOrder` the moment anyone tries to prove it, on any
deployment, at any time — no wait raises that ceiling, unlike a merely
depleted pool (which recovers, and reverts instead with the temporary
`InsufficientUnits`). Sepolia's `OrderBook` has no way to see either cap and
reject an order up front (Attestcoin proofs run one direction only:
Creditcoin reads Sepolia, never the reverse), so it happily mines the order
for the same flat fee regardless. Wealth buys more *orders*; only patience,
territory, and timing buy a bigger single strike.

A faction can borrow against proven territory — `WarChest.sol` — to fund an
offensive, with no separate collateral posted: territory read live from
`FactionMarch` *is* the collateral, so `creditLimit` is pure arithmetic
(`zonesHeld × 0.001 CTC`, adjusted by reputation), not a balance. **It is not
money sitting anywhere** — the chest's actual spendable CTC comes only from
someone explicitly calling `depositToChest()` (or `repay()`), and starts at
zero on every game with no carryover from any other game: `chestBalance`,
`factionCredit`, and `creditLimit` are all keyed by `gameId`, so game 2 knows
nothing about game 1's territory, deposits, or borrowing history, even
seconds after game 1 settles. A faction can have a nonzero `creditLimit` and
still have nothing to actually draw against — `borrow()` checks the real
`chestBalance` too, and reverts with `InsufficientChestBalance` if the limit
outruns what's really in the pool. A draw must be repaid within
`REPAYMENT_WINDOW_BLOCKS` (5000 blocks on the current deployment) of being
taken, or the line defaults automatically — computed from the block number
like everything else here, no transaction required to trigger it. Defaulting
zeroes the credit limit immediately, and even after it's repaid and cleared,
permanently cuts the faction's multiplier by 30% *per lifetime default* — it
does not reset. Every resolved order also writes to an on-chain commander
reputation record (orders issued, proven, bounties claimed, debts repaid).
This is the credit thesis: an undercollateralised credit primitive that's
played, not pitched, on a credit chain — real funds still have to come from
somewhere, since Attestcoin's one-directional proofs mean the Sepolia order
fee itself can't be bridged into CTC and dropped into the chest automatically.

**That doesn't mean the chest has to stay manually-funded forever, though.**
Every successful `submitOrderProof`/`submitOrderProofBatch` call now requires
the courier to attach a small native CTC fee (`CHEST_FEE_PER_ORDER`,
0.00005 CTC on the current deployment) alongside it, deposited straight into
that specific order's game's chest via `WarChest.depositToChest` in the same
transaction. Real CTC, moved by a real action, growing the chest in lockstep
with actual proven gameplay instead of sitting inert until someone clicks
"fund chest" unprompted. It's charged to the courier rather than the
commander — commanders only ever pay on Sepolia, in ETH, and there's no way
to charge a CC3-side fee to an address that only acted on Sepolia — so it
nets against `BOUNTY_PER_ORDER` (0.0001 CTC) rather than stacking a new cost
on top of the Sepolia fee; deliberately kept smaller than the bounty so a
courier who successfully lands proofs stays net-positive overall. Routed to
each order's own `gameId` individually rather than summed into one deposit —
correct regardless, and specifically matters if `FactionMarch`'s current
one-active-game-at-a-time rule is ever relaxed, since nothing here assumes
every order in a batch shares a game.

**That fee itself scales down with the territory the order's own commander
has already helped win.** `ProofGate._discountedChestFee` reads the same
zones-held tiers `WarChest.discountBps` already exposed for display
(`TIER_1`/`2`/`3` at 3/6/9 zones → 5%/10%/20% off) and actually applies the
discount to `CHEST_FEE_PER_ORDER` at the moment a proof is submitted, rather
than leaving it a number the UI shows and nothing spends — the concrete,
courier-board-facing use case the discount was missing before. It's read
per order, live, against whichever faction that order's commander currently
belongs to (not a snapshot from game start, and not tied to `msg.sender` —
the courier proving the order is very often not its commander), so a batch
mixing orders from factions at different tiers charges a genuinely different
`msg.value` per order; a single `IncorrectChestFee(sent, required)` check
against the *exact* discounted sum (`==`, not `>=`) covers both the
single-order and batch paths. Deliberately read after `resolveOrder` inside
the same call, so a batch that captures a faction's 3rd zone mid-batch
already earns that discount on later orders in the *same* batch — the tier
is truth-as-of-execution, not truth-as-of-submission. Enforced per-order even
inside a batch (`msg.value` must equal the sum of each order's own
discounted fee, computed in a first pass before any deposit is made in a
second — an earlier single-pass version could drain `msg.value` on early
orders and hard-revert with no error data on a later one; see
`spikes/FINDINGS.md` Phase 16). This is separate from — and stacks with
nothing from — the reputation-driven `creditLimit` multiplier above; the two
read the same `zonesHeld` state but spend it in unrelated ways.

**Discount and credit limit are both indirect — territory yield is the
direct payout.** Neither existing incentive actually pays a faction
anything: the discount only cheapens getting *your own* orders proven, and
`creditLimit` is a bigger loan ceiling with real default risk, not free
value. `WarChest.YIELD_SHARE_BPS` (30%) closes that gap. Every
`depositToChest` call — a manual top-up or a courier's chest fee, same entry
point either way — immediately splits 30% of whatever just arrived across
Alpha/Beta/Gamma proportional to *current* zones held, one pass over the
board (`_distributeYield`), and credits each faction's `claimableYield`; the
other 70% still lands in `chestBalance` to back the credit line, so more
territory now trades some collective borrowing power for a direct, ongoing
reward. Splitting at the instant CTC arrives — not on a claim snapshot — is
what makes capturing a zone right before a big deposit unprofitable for that
specific deposit: a faction only ever earns a share of CTC that lands after
it already held the zone (`test_claimYield_capturingAfterDepositEarnsNothingFromThatDeposit`
proves this, not just asserts it). `claimYield(gameId, faction)` pays out to
whoever calls, restricted to a member of that faction — same "no admin key,
permissionless within membership" shape as `borrow`/`repay`. Debt
repayments are deliberately exempt from the split (`repay` credits
`chestBalance` directly): that CTC already passed through it once, on the
way in, and splitting it again would tax the same principal twice. The
one-pass-over-zones design keeps this from tripling `territoryHeld`'s
already-documented O(zoneCount) cost on every single deposit — a real,
disclosed gas cost per proof (zoneCount is bounded at `MAX_ZONE_COUNT`, 100),
not an unbounded one.

The frontend (`web/`) is a zone map with a live join/active countdown and
ownership history, a commit/reveal order composer (with a local "commits
awaiting reveal" queue, salt kept only in the browser, exactly one "Reveal"
click away), a paginated courier board (single-order
*and* in-browser batch submission — see *Batching*, above), and an in-flight
panel — both flag doomed proofs before anyone wastes real gas on them,
covering all three ways `resolveOrder` is guaranteed to revert regardless of
when it's proven: an out-of-range zone (`InvalidZone`), a commander who never
joined before the game left OPEN (`NotJoined` — joining itself closes
permanently once a game goes ACTIVE), or a single order over the 10-unit
per-order cap (`ExceedsMaxUnitsPerOrder`, unraisable by waiting — the order
composer also warns, non-blockingly, when your live pool is merely
*temporarily* short of a request that's still under that cap). There's also a war
chest/credit panel showing each faction's live due-block countdown, default
consequences, and claimable territory yield with a one-click `claimYield`
button, a connected wallet's own on-chain reputation pulled straight from
`WarChest.reputations`, and — the single most important screen — the
in-flight panel's live ticking clock, so the UI never implies instant
resolution.

**Faction chat** is real, per-`(gameId, faction)` private chat, backed by
Supabase — but membership is never taken on Supabase's word. `public.faction_messages`
has RLS enabled with zero grants to `anon`/`authenticated`, so the table is
unreachable through the public API no matter what — confirmed directly:
`curl` with the anon key gets `permission denied for table faction_messages`,
not an empty result. The only way in is the `faction-chat` Edge Function,
which verifies an EIP-191 signature over a short-lived login message, then
reads `FactionMarch.commanderFaction(gameId, address)` live from Creditcoin
CC3 before minting a session scoped to whatever faction that call actually
returns — a validly-signed request from a wallet that never joined is
rejected with a 403, confirmed live, not assumed. See
`supabase/functions/faction-chat/` and `supabase/migrations/`.

---

## Deployed contracts

| Contract | Network | Address |
|---|---|---|
| `OrderBook` | Sepolia | `0xa9842871a176feeA29590de1A71DE829940FfC36` — commit/reveal (`commitOrder`/`revealOrder`), orderFee 0.0005 ETH paid at commit, treasury `0x9d4eF81F5225107049ba08F69F598D97B31ea644` |
| `FactionMarch` | Creditcoin CC3 | `0xba618275A71ea261cAbA7294e742589723aEC1AE` — game board, `resolveOrder` restricted to `ProofGate` below; only one game may be OPEN/ACTIVE at a time (`createGame` reverts with `PreviousGameNotSettled` otherwise), open duration capped at `MAX_OPEN_DURATION_BLOCKS` (3600 blocks, ~15h at CC3's measured 15s/block), active duration capped at `MAX_ACTIVE_DURATION_BLOCKS` (28,800 blocks, ~5 days), single order capped at `MAX_UNITS_PER_ORDER` (10, independent of the 500-unit total pool) |
| `WarChest` | Creditcoin CC3 | `0xcd3A69f231c93f37A2A7f61D5B5F58850850a045` — credit line + reputation, reads territory from `FactionMarch` above, repayment window 5000 blocks, `discountBps` tiers (3/6/9 zones → 5%/10%/20%) spent by `ProofGate` below, and `YIELD_SHARE_BPS` (30%) of every `depositToChest` inflow — a direct deposit or a proof fee — split live across factions by *current* territory into `claimableYield`, on top of the discount and credit-limit incentives |
| `ProofGate` | Creditcoin CC3 | `0x8ff40DBA12240379e431eD7a927D16413717F6B8` — hardened, wired to `FactionMarch` and `WarChest` above, allowlists `OrderBook` above (checks for `OrderRevealed`, not the old `OrderPlaced`), staleness window 1200 blocks, bounty 0.0001 CTC/order (pool funded with 0.01 CTC), chest fee 0.00005 CTC/order, discounted per order by the order's own commander's live `WarChest.discountBps`, deposited into `WarChest` on every successful proof; accepts `msg.value` at or above the true required total and refunds the excess rather than requiring an exact match (see *On over/underpayment* in the contract's own NatSpec) |

Superseded addresses, kept only as a record of earlier iterations (see `spikes/FINDINGS.md`): `ProofGate` unguarded, no emitter check `0x296Ecf33a2c64F7A858133E60aC5d732Cd1b654c`; `ProofGate` hardened, before `FactionMarch` wiring `0x9fe147c23600CFcB7dd0DAEc4670d96868142744`; `FactionMarch` no access control `0x871F283Cf322F0206FE6424EE01529E186270eb5`; `ProofGate`/`FactionMarch` wired, no bounty/batching `0x0739BA644E4a25e529B04b870b54958c4C25131d` / `0x3181cFd3D6927656797208C20848c2B623bbf223`; `ProofGate`/`FactionMarch` bounty/batching, no `WarChest` `0x1BDA513AC071A6736Bb5569499CE9a7D96c3E0bc` / `0x92b474811aC11EbfFdcc21fc240993b46909ae69`; `ProofGate`/`FactionMarch`/`WarChest` wired, no game-exclusivity rule (any number of games could be OPEN/ACTIVE at once) `0xcEd503d0Eeb04C13F8974CaA85d06A22f0441C88` / `0xEf7Cc55BD1bF5c836D4CcD0c3d108415a6Bc18Ba` / `0x54C3901F43d1ab2694357D304e6dAc1671Cf10a2`; `ProofGate`/`FactionMarch`/`WarChest` wired with exclusivity + duration caps, but default game durations assumed an unverified ~1 block/sec (actually 15s/block — see `spikes/FINDINGS.md`) `0x58ef7793d058d7F2e11DCe57747bEf6D1d487778` / `0xB8Fde830fF968E56528539505243da22ce59b628` / `0xF1eD07B6A8406E2b0B7D8FE072C64740aCdf24C4`; `ProofGate`/`FactionMarch`/`WarChest` wired with correct durations, but no per-order unit cap and no chest-fee mechanism yet `0x5F979DaafCc5D3324Ea446e9DcEa829aCe4aE0e1` / `0xE3c75BD8B7029175f909141ffD2639D8478C9ea4` / `0xc15b39Ecd7068B2a2409f5833389Dd4c7E34B080`; `ProofGate`/`FactionMarch`/`WarChest` wired with per-order cap + chest fee, but `OrderBook` was still single-phase `placeOrder` (no unit secrecy) `0xdB29051641c7257BF8ca45a68B16505C254dC6d1` / `0x1561d62A22F74BA2098202Dd915669e2631a5e88` / `0x44db1f17611214Fc57a5D6aA116d3852FB12aA37`, `OrderBook` `0xA100d72A7F214D669AC3deCEb07E6b35C001fE7F`; `ProofGate`/`FactionMarch`/`WarChest` wired with commit-reveal + real chest fee, but the fee was flat (no discount) and `FactionMarch` had not yet gained `MAX_UNITS_PER_ORDER` on this particular deployment `0x3684c468B9Bd5fF998706294C1cA07f49609083a` / `0x3FA9CEeD76511372De1396e66D1561e8d5e5af3D` / `0x27A3fb6e3A576F15e8463b174415F1Ec51BB9f19`; `ProofGate`/`FactionMarch`/`WarChest` wired with the mandatory discount, but before territory yield existed — holding territory only earned a cheaper fee and a bigger (riskier) credit limit, no direct payout `0xEef2B7f161cF1B5F59BA360CE52F32A26A4e87C3` / `0xa02050aF59AF343e2FbB8cA0c11F637442Ef7a06` / `0x1E48018D1545f308c1AF7c4Ad3213aFDbDE741E6`; `ProofGate`/`FactionMarch`/`WarChest` wired with territory yield, but the chest fee still required an *exact* `msg.value` match — a same-transaction discount (a batch capturing its own qualifying zone) could make a courier's pre-flight estimate legitimately overshoot, hard-reverting a harmless overpayment instead of refunding it `0x785D5e6FFc6f163D7341f6Fda19FA2781C668b46` / `0x4B3A63385a837F93B336A71C9dCF085c26d7ba99` / `0xb58C0FfeC5D7DF67788646209c106d187F4eA568`.

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

**CC3's block time is a measured, steady 15 seconds/block** — checked
directly against real block timestamps (`cast block <N>` at two points
200 and 5000 blocks apart, both agreeing), not assumed. Every
`FactionMarch` duration in this repo (`openDurationBlocks`,
`activeDurationBlocks`, the two `MAX_*_DURATION_BLOCKS` caps) is
denominated in CC3 blocks — multiply by 15s for wall-clock time.

## Layout

| Path | What |
|---|---|
| `contracts/source/` | Foundry project for Ethereum Sepolia (`OrderBook.sol`) |
| `contracts/creditcoin/` | Foundry project for Creditcoin CC3 (`ProofGate.sol`, `FactionMarch.sol`, `WarChest.sol`) |
| `courier/` | Node/TS proof-delivery scripts — `place-and-relay.ts` is the reference courier |
| `web/` | React + Vite frontend — reads/writes contracts directly from the browser; the one exception is faction chat, which talks to `supabase/` |
| `supabase/` | Faction chat backend: `migrations/` (locked-down `faction_messages` table) and `functions/faction-chat/` (the only thing with a key that can reach it) |
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
