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
contract ProofGate {
    /// @dev keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)")
    bytes32 public constant ORDER_PLACED_SIGNATURE =
        keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)");

    /// @notice The native precompile's hard limit on proofs per batch call.
    uint256 public constant MAX_BATCH_SIZE = 10;

    address internal constant CHAIN_INFO_PRECOMPILE = 0x0000000000000000000000000000000000000fD3;

    INativeQueryVerifier public immutable VERIFIER;
    IChainInfo public immutable CHAIN_INFO;
    FactionMarch public immutable FACTION_MARCH;
    WarChest public immutable WAR_CHEST;

    /// @notice The only contract ProofGate accepts OrderPlaced logs from.
    address public immutable ORDER_BOOK;
    /// @notice Creditcoin-internal chain key for the source chain (Sepolia = 1). Not the EVM chainId.
    uint64 public immutable SOURCE_CHAIN_KEY;
    /// @notice Orders whose Sepolia block is more than this many blocks behind the latest
    /// attested height are rejected as stale.
    uint64 public immutable STALENESS_WINDOW_BLOCKS;
    /// @notice Fixed CTC bounty paid to whoever successfully lands an order's proof.
    uint256 public immutable BOUNTY_PER_ORDER;

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

    constructor(
        address orderBook,
        address factionMarch,
        address warChest,
        uint64 sourceChainKey,
        uint64 stalenessWindowBlocks,
        uint256 bountyPerOrder
    ) {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        CHAIN_INFO = IChainInfo(CHAIN_INFO_PRECOMPILE);
        FACTION_MARCH = FactionMarch(factionMarch);
        WAR_CHEST = WarChest(warChest);
        ORDER_BOOK = orderBook;
        SOURCE_CHAIN_KEY = sourceChainKey;
        STALENESS_WINDOW_BLOCKS = stalenessWindowBlocks;
        BOUNTY_PER_ORDER = bountyPerOrder;
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
    ) external {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        bool verified =
            VERIFIER.verifyAndEmit(SOURCE_CHAIN_KEY, blockHeight, encodedTransaction, merkleProof, continuityProof);
        if (!verified) revert ProofVerificationFailed();

        uint64 txIndex = VERIFIER.calculateTxIndex(merkleProof);
        _processOrder(blockHeight, txIndex, encodedTransaction);
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
    ) external {
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

        for (uint256 i = 0; i < n; i++) {
            uint64 txIndex = VERIFIER.calculateTxIndex(merkleProofs[i]);
            _processOrder(blockHeights[i], txIndex, encodedTransactions[i]);
        }
    }

    /// @dev Shared by both entry points: checks 1-3 (via _findOrderLog), 4, 5, 7, then
    /// resolves on FactionMarch and pays the bounty. Assumes inclusion/continuity (the
    /// precompile call) was already verified by the caller.
    function _processOrder(uint64 blockHeight, uint64 txIndex, bytes memory encodedTransaction) internal {
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionDidNotSucceed();

        // Checks 1-3: emitter allowlist, topic0, topic count.
        (EvmV1Decoder.LogEntry memory log, uint256 logIndex) = _findOrderLog(receipt);

        address commander = address(uint160(uint256(log.topics[1])));
        uint256 gameId = uint256(log.topics[2]);
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

        bool bountyPaid = _payBounty(orderKey);

        // Same-tx reputation recording — the only authentic (non-self-reported) source for
        // WarChest's ordersProven/bountiesClaimed counters.
        WAR_CHEST.recordOrderResolution(gameId, commander, msg.sender, nonce, bountyPaid);
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
                if (log.topics.length == 0 || log.topics[0] != ORDER_PLACED_SIGNATURE) revert WrongTopic0();
                if (log.topics.length != 4) revert WrongTopicCount(log.topics.length);
                return (log, i);
            }
        }
        revert ForgedEmitter();
    }
}
