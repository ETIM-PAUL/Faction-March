// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier, NativeQueryVerifierLib} from
    "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {FactionMarch} from "./FactionMarch.sol";
import {WarChest} from "./WarChest.sol";

/// @title IChainInfo
/// @notice Minimal Solidity interface for the ChainInfo precompile at 0x...0fd3. Hand-written
/// against the real ABI shipped in the Gluwa usc-sdk TypeScript package
/// (dist/chain-info/chain_info.json) — no Solidity-side interface for it exists in the
/// Gluwa asc-contracts package. Only the one function ProofGate needs (the staleness
/// check) is declared.
interface IChainInfo {
    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    function get_latest_attestation_height_and_hash(uint64 chainKey)
        external
        view
        returns (HeightHashResult memory);
}

/// @title ProofGate
/// @notice Hardened verification layer (Phase 5) wired into march resolution (Phase 7),
/// with a permissionless bounty and batching for the courier layer (Phase 8). The
/// block-prover precompile proves inclusion and continuity — nothing more. It does not
/// prove who emitted a log, that the source transaction succeeded, or that a proof is
/// fresh. ProofGate enforces all of that itself, in order, each with its own error so a
/// rejection is legible on-chain:
///   1. emitter allowlist    -> ForgedEmitter
///   2. topic0 match         -> WrongTopic0
///   3. topic count == 4     -> WrongTopicCount
///   4. gameId is active     -> GameNotActive
///   5. exact replay         -> OrderAlreadyProcessed, keyed on (blockHeight, txIndex, logIndex)
///   6. ordering cursor      -> deliberately NOT enforced; see note below
///   7. staleness window     -> OrderStale
/// Once all seven pass, it calls FACTION_MARCH.resolveOrder(...) in the same transaction —
/// same-tx verify-and-execute, no separate settlement step for anyone to front-run or skip
/// — and pays a bounty to whoever submitted the proof.
/// @dev No admin key anywhere: every field is immutable, submitOrderProof/
/// submitOrderProofBatch/fundBounties are all permissionless.
///
/// Game existence/activity (check 4) is read live from FACTION_MARCH — there is exactly one
/// source of truth for "is this game active," not a second registry duplicated here.
///
/// On (6): Phase 7's entire mechanic is that competing orders resolve in *proof-arrival*
/// order, not Sepolia block order ("Arrival order is authority"). A monotonic per-game
/// ordering cursor here would reject exactly the out-of-order arrivals the game is built
/// on. So this contract explicitly allows out-of-order arrival — replay protection (5)
/// still blocks resubmitting the same order twice.
///
/// On the bounty (Phase 8): "order fee funds a bounty" is a documented simplification.
/// There is no audited, trustless way yet to move the Sepolia ETH fee itself onto
/// Creditcoin (Attestcoin's writability primitives are still pre-audit — see
/// gluwa/attestcoin-protocol-examples' own README caveat). BOUNTY_PER_ORDER is a fixed CTC
/// amount paid from a pool anyone can top up via fundBounties(), standing in for that
/// eventual fee-funded bounty. Combat resolution never depends on the pool being funded —
/// if it's dry, the order still resolves and the courier simply isn't paid this time.
///
/// On CHEST_FEE_PER_ORDER (Phase 13): the Sepolia fee still can't be bridged into CTC, but
/// that doesn't mean the chest has to stay manually-funded forever. Every successful proof
/// now requires the courier to attach a small native CTC fee, deposited straight into that
/// specific order's game's chest via WarChest.depositToChest in the same transaction — real
/// CTC, moved by a real action, growing in lockstep with actual proven gameplay instead of
/// sitting inert until someone clicks a "fund chest" button unprompted. It's charged to the
/// courier, not the commander, so it nets against BOUNTY_PER_ORDER rather than adding a new
/// cost on top of the Sepolia fee; deliberately kept smaller than the bounty so a courier
/// that successfully lands proofs stays net-positive. Routed to each order's own gameId
/// individually rather than summed into one deposit — correct regardless, and specifically
/// matters if FactionMarch's current one-active-game-at-a-time rule (see createGame) is ever
/// relaxed, since nothing here assumes every order in a batch shares a gameId.
///
/// On the discount (Phase 16): WarChest.discountBps was originally meant to discount the
/// Sepolia order fee, which turned out to be structurally impossible (Creditcoin can't
/// affect a Sepolia transaction's cost -- Attestcoin proofs run one direction only). This is
/// the fee it can actually discount: the *courier's* chest fee for proving an order, scaled
/// down by the *order's own commander's* faction territory tier at the moment the proof
/// lands. A bigger faction is cheaper to courier for -- a real, live-computed effect, not
/// just a number shown in a table. The exact required fee isn't known until the order's
/// commander is decoded (deep inside _processOrder), so unlike before, msg.value can't be
/// checked at the top of either entry point -- it's checked once the true total is known,
/// after the fee-moving side effects. This is still safe: Solidity reverts are atomic, so a
/// transaction that doesn't cover the required amount undoes every deposit and every
/// accounting change it made along the way, including anything that would otherwise look
/// like it "borrowed" from the separately-accounted bounty pool's real balance.
///
/// On over/underpayment (Phase 17): because feeCharged depends on the *same transaction's*
/// own resolveOrder side effects (a capture that just crossed a discount-tier threshold
/// already discounts that very order, see _discountedChestFee), no caller can predict the
/// exact required fee purely from state read before sending the transaction -- only from
/// state as it will exist mid-transaction. Requiring an exact msg.value match under that
/// constraint meant a caller's best-effort, pre-flight estimate would routinely overshoot
/// (or undershoot) by exactly the amount a same-batch capture changed the discount by, and a
/// harmless overpayment reverted the whole submission instead of just costing slightly more
/// than necessary. Both entry points now accept msg.value >= the true required total and
/// refund the difference to msg.sender at the end of the call; only genuine underpayment
/// still reverts with IncorrectChestFee.
contract ProofGate {
    /// @dev keccak256("OrderRevealed(address,uint256,uint16,uint32,uint64)") -- the event
    /// OrderBook's two-phase commit/reveal emits once units are actually exposed (Phase 14).
    /// Same shape (3 indexed address/gameId/zoneId topics, units+nonce in data) as the old
    /// single-phase OrderPlaced this used to check, so nothing else in this decode path
    /// needed to change.
    bytes32 public constant ORDER_REVEALED_SIGNATURE =
        keccak256("OrderRevealed(address,uint256,uint16,uint32,uint64)");

    /// @notice The native precompile's hard limit on proofs per batch call.
    uint256 public constant MAX_BATCH_SIZE = 10;

    address internal constant CHAIN_INFO_PRECOMPILE = 0x0000000000000000000000000000000000000fD3;

    INativeQueryVerifier public immutable VERIFIER;
    IChainInfo public immutable CHAIN_INFO;
    FactionMarch public immutable FACTION_MARCH;
    WarChest public immutable WAR_CHEST;

    /// @notice The only contract ProofGate accepts OrderRevealed logs from.
    address public immutable ORDER_BOOK;
    /// @notice Creditcoin-internal chain key for the source chain (Sepolia = 1). Not the EVM chainId.
    uint64 public immutable SOURCE_CHAIN_KEY;
    /// @notice Orders whose Sepolia block is more than this many blocks behind the latest
    /// attested height are rejected as stale.
    uint64 public immutable STALENESS_WINDOW_BLOCKS;
    /// @notice Fixed CTC bounty paid to whoever successfully lands an order's proof.
    uint256 public immutable BOUNTY_PER_ORDER;
    /// @notice Fixed CTC fee the courier must attach per order, deposited into that order's
    /// game's WarChest in the same transaction. Kept smaller than BOUNTY_PER_ORDER so a
    /// successful courier nets positive overall.
    uint256 public immutable CHEST_FEE_PER_ORDER;

    /// @notice Replay guard, keyed on (blockHeight, txIndex, logIndex) — never blockHeight
    /// alone (two orders can share a block) and never txHash alone (doesn't disambiguate
    /// position for the ordering story other checks rely on).
    mapping(bytes32 => bool) public processedOrders;

    /// @notice CTC available to pay bounties. Anyone can top it up; nobody can withdraw it
    /// except by successfully couriering an order.
    uint256 public bountyPool;

    event OrderArrived(
        address indexed commander, uint256 indexed gameId, uint16 indexed zoneId, uint32 units, uint64 nonce
    );
    event BountyFunded(address indexed funder, uint256 amount);
    event BountyPaid(address indexed courier, bytes32 indexed orderKey, uint256 amount);
    event BountySkipped(bytes32 indexed orderKey, uint256 requested, uint256 available);

    error ForgedEmitter();
    error WrongTopic0();
    error WrongTopicCount(uint256 count);
    error GameNotActive(uint256 gameId);
    error OrderAlreadyProcessed(bytes32 orderKey);
    error OrderStale(uint64 orderHeight, uint64 latestAttestedHeight);
    error TransactionDidNotSucceed();
    error ProofVerificationFailed();
    error BountyTransferFailed();
    error InvalidBatchSize(uint256 size);
    error BatchLengthMismatch();
    error IncorrectChestFee(uint256 sent, uint256 required);
    error RefundFailed();

    constructor(
        address orderBook,
        address factionMarch,
        address warChest,
        uint64 sourceChainKey,
        uint64 stalenessWindowBlocks,
        uint256 bountyPerOrder,
        uint256 chestFeePerOrder
    ) {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        CHAIN_INFO = IChainInfo(CHAIN_INFO_PRECOMPILE);
        FACTION_MARCH = FactionMarch(factionMarch);
        WAR_CHEST = WarChest(warChest);
        ORDER_BOOK = orderBook;
        SOURCE_CHAIN_KEY = sourceChainKey;
        STALENESS_WINDOW_BLOCKS = stalenessWindowBlocks;
        BOUNTY_PER_ORDER = bountyPerOrder;
        CHEST_FEE_PER_ORDER = chestFeePerOrder;
    }

    /// @notice Tops up the bounty pool. Permissionless — a game creator, a faction, or a
    /// commander couriering their own orders can all fund it.
    function fundBounties() external payable {
        bountyPool += msg.value;
        emit BountyFunded(msg.sender, msg.value);
    }

    /// @notice Verify a proof of a Sepolia OrderBook.placeOrder transaction and, if it
    /// passes every check, resolve it on FactionMarch in this same transaction and pay the
    /// caller a bounty. Callable by anyone, holds no special key — this is the
    /// permissionless courier entry point.
    function submitOrderProof(
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external payable {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        bool verified =
            VERIFIER.verifyAndEmit(SOURCE_CHAIN_KEY, blockHeight, encodedTransaction, merkleProof, continuityProof);
        if (!verified) revert ProofVerificationFailed();

        uint64 txIndex = VERIFIER.calculateTxIndex(merkleProof);
        (uint256 gameId, uint256 feeCharged) = _processOrder(blockHeight, txIndex, encodedTransaction);
        if (msg.value < feeCharged) revert IncorrectChestFee(msg.value, feeCharged);
        // Deposited only now, after msg.value is confirmed sufficient -- see the batch version
        // below for why a "deposit as you go" ordering is worth avoiding even here.
        if (feeCharged > 0) WAR_CHEST.depositToChest{value: feeCharged}(gameId);
        _refundExcess(feeCharged);
    }

    /// @notice Verify up to MAX_BATCH_SIZE proofs sharing one continuity proof in a single
    /// call — cheaper than submitting them one at a time, and the reason a courier choosing
    /// what to bundle is real optimisation: orders clustered in nearby Sepolia blocks batch
    /// cheaply, scattered ones don't.
    function submitOrderProofBatch(
        uint64[] calldata blockHeights,
        bytes[] calldata encodedTransactions,
        bytes32[] calldata merkleRoots,
        INativeQueryVerifier.MerkleProofEntry[][] calldata siblingsPerOrder,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external payable {
        uint256 n = blockHeights.length;
        if (n == 0 || n > MAX_BATCH_SIZE) revert InvalidBatchSize(n);
        if (encodedTransactions.length != n || merkleRoots.length != n || siblingsPerOrder.length != n) {
            revert BatchLengthMismatch();
        }

        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](n);
        for (uint256 i = 0; i < n; i++) {
            merkleProofs[i] = INativeQueryVerifier.MerkleProof({root: merkleRoots[i], siblings: siblingsPerOrder[i]});
        }
        INativeQueryVerifier.ContinuityProof memory sharedContinuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        bool verified = VERIFIER.verifyAndEmit(
            SOURCE_CHAIN_KEY, blockHeights, encodedTransactions, merkleProofs, sharedContinuityProof
        );
        if (!verified) revert ProofVerificationFailed();

        // Two passes, deliberately: resolve every order and total up what each one's
        // (possibly discounted) fee actually is first, *then* check msg.value, *then* only
        // deposit once that check has passed. Depositing as each order resolved instead
        // would mean an underpaid batch could partially drain its own msg.value on the
        // first order or two, then hit a hard "insufficient balance" revert with no error
        // data on a later one, once the contract's balance ran out -- still safe (Solidity
        // reverts are atomic, nothing is lost or stuck either way), but a confusing, useless
        // error instead of a clean IncorrectChestFee telling the courier what they actually
        // owed.
        uint256[] memory feePerOrder = new uint256[](n);
        uint256[] memory gameIdPerOrder = new uint256[](n);
        uint256 totalFee = 0;
        for (uint256 i = 0; i < n; i++) {
            uint64 txIndex = VERIFIER.calculateTxIndex(merkleProofs[i]);
            (uint256 gameId, uint256 fee) = _processOrder(blockHeights[i], txIndex, encodedTransactions[i]);
            gameIdPerOrder[i] = gameId;
            feePerOrder[i] = fee;
            totalFee += fee;
        }
        if (msg.value < totalFee) revert IncorrectChestFee(msg.value, totalFee);

        for (uint256 i = 0; i < n; i++) {
            if (feePerOrder[i] > 0) WAR_CHEST.depositToChest{value: feePerOrder[i]}(gameIdPerOrder[i]);
        }
        _refundExcess(totalFee);
    }

    /// @dev Refunds msg.value beyond `required` back to msg.sender. Called only after every
    /// deposit this call is going to make has already happened, so this is always the very
    /// last transfer in either entry point.
    function _refundExcess(uint256 required) internal {
        uint256 excess = msg.value - required;
        if (excess == 0) return;
        (bool ok,) = msg.sender.call{value: excess}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev Shared by both entry points: checks 1-3 (via _findOrderLog), 4, 5, 7, then
    /// resolves on FactionMarch and pays the bounty. Assumes inclusion/continuity (the
    /// precompile call) was already verified by the caller. Returns the order's gameId and
    /// the chest fee it owes (after the commander's faction discount) but does NOT deposit
    /// it -- callers total every order's fee, verify msg.value against that total, and only
    /// then actually call WAR_CHEST.depositToChest, once per order, themselves.
    function _processOrder(uint64 blockHeight, uint64 txIndex, bytes memory encodedTransaction)
        internal
        returns (uint256 gameId, uint256 feeCharged)
    {
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionDidNotSucceed();

        // Checks 1-3: emitter allowlist, topic0, topic count.
        (EvmV1Decoder.LogEntry memory log, uint256 logIndex) = _findOrderLog(receipt);

        address commander = address(uint160(uint256(log.topics[1])));
        gameId = uint256(log.topics[2]);
        uint16 zoneId = uint16(uint256(log.topics[3]));
        (uint32 units, uint64 nonce) = abi.decode(log.data, (uint32, uint64));

        // Check 4: gameId binding, read live from FactionMarch — the one source of truth.
        try FACTION_MARCH.currentState(gameId) returns (FactionMarch.GameState state) {
            if (state != FactionMarch.GameState.ACTIVE) revert GameNotActive(gameId);
        } catch {
            revert GameNotActive(gameId);
        }

        // Check 5: exact replay / same-block sibling replay.
        bytes32 orderKey = keccak256(abi.encode(blockHeight, txIndex, logIndex));
        if (processedOrders[orderKey]) revert OrderAlreadyProcessed(orderKey);
        processedOrders[orderKey] = true;

        // Check 7: staleness window.
        IChainInfo.HeightHashResult memory latest = CHAIN_INFO.get_latest_attestation_height_and_hash(SOURCE_CHAIN_KEY);
        if (latest.exists && latest.height > blockHeight && (latest.height - blockHeight) > STALENESS_WINDOW_BLOCKS) {
            revert OrderStale(blockHeight, latest.height);
        }

        emit OrderArrived(commander, gameId, zoneId, units, nonce);

        // Same-tx verify-and-execute: combat resolves in this transaction, not a later one.
        FACTION_MARCH.resolveOrder(gameId, commander, zoneId, units);

        // The fee owed for this order -- discounted by the commander's own faction's live
        // territory tier (see contract-level NatSpec on the discount), read *after*
        // resolveOrder so a capture that just pushed this faction into a new tier this same
        // transaction already counts. Not deposited here -- see callers.
        feeCharged = _discountedChestFee(gameId, commander);

        bool bountyPaid = _payBounty(orderKey);

        // Same-tx reputation recording — the only authentic (non-self-reported) source for
        // WarChest's ordersProven/bountiesClaimed counters.
        WAR_CHEST.recordOrderResolution(gameId, commander, msg.sender, nonce, bountyPaid);
    }

    /// @dev CHEST_FEE_PER_ORDER, reduced by the commander's faction's current
    /// WarChest.discountBps -- 0% under 3 zones held, up to 20% at 9+. Bounded below by 0
    /// automatically: discountBps never exceeds 10_000 (100%), so this can't underflow.
    function _discountedChestFee(uint256 gameId, address commander) internal view returns (uint256) {
        if (CHEST_FEE_PER_ORDER == 0) return 0;
        FactionMarch.Faction faction = FACTION_MARCH.commanderFaction(gameId, commander);
        uint256 discountBps = WAR_CHEST.discountBps(gameId, faction);
        return CHEST_FEE_PER_ORDER - (CHEST_FEE_PER_ORDER * discountBps) / 10_000;
    }

    /// @dev Never lets a dry pool block order resolution — the courier just goes unpaid.
    function _payBounty(bytes32 orderKey) internal returns (bool paid) {
        uint256 amount = BOUNTY_PER_ORDER;
        if (amount == 0) return false;
        if (amount > bountyPool) {
            emit BountySkipped(orderKey, amount, bountyPool);
            return false;
        }
        bountyPool -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BountyTransferFailed();
        emit BountyPaid(msg.sender, orderKey, amount);
        return true;
    }

    /// @dev Checks 1-3. Scans logs for the first one emitted by ORDER_BOOK; once found, that
    /// log must have the right topic0 and exactly 4 topics, or the whole call reverts — it
    /// does not keep searching for a different, better-shaped log from ORDER_BOOK.
    function _findOrderLog(EvmV1Decoder.ReceiptFields memory receipt)
        internal
        view
        returns (EvmV1Decoder.LogEntry memory, uint256)
    {
        uint256 n = receipt.receiptLogs.length;
        for (uint256 i = 0; i < n; i++) {
            if (receipt.receiptLogs[i].address_ == ORDER_BOOK) {
                EvmV1Decoder.LogEntry memory log = receipt.receiptLogs[i];
                if (log.topics.length == 0 || log.topics[0] != ORDER_REVEALED_SIGNATURE) revert WrongTopic0();
                if (log.topics.length != 4) revert WrongTopicCount(log.topics.length);
                return (log, i);
            }
        }
        revert ForgedEmitter();
    }
}
