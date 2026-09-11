// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier, NativeQueryVerifierLib} from
    "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

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
/// @notice Hardened verification layer (Phase 5). The block-prover precompile proves
/// inclusion and continuity — nothing more. It does not prove who emitted a log, that the
/// source transaction succeeded, or that a proof is fresh. ProofGate enforces all of that
/// itself, in order, each with its own error so a rejection is legible on-chain:
///   1. emitter allowlist    -> ForgedEmitter
///   2. topic0 match         -> WrongTopic0
///   3. topic count == 4     -> WrongTopicCount
///   4. gameId is active     -> GameNotActive
///   5. exact replay         -> OrderAlreadyProcessed, keyed on (blockHeight, txIndex, logIndex)
///   6. ordering cursor      -> deliberately NOT enforced; see note below
///   7. staleness window     -> OrderStale
/// @dev No admin key anywhere: ORDER_BOOK/SOURCE_CHAIN_KEY/STALENESS_WINDOW_BLOCKS are
/// immutable, registerGame and submitOrderProof are both permissionless.
///
/// On (6): Phase 7's entire mechanic is that competing orders resolve in *proof-arrival*
/// order, not Sepolia block order ("Arrival order is authority"). A monotonic per-game
/// ordering cursor here would reject exactly the out-of-order arrivals the game is built
/// on. So this contract explicitly allows out-of-order arrival — replay protection (5)
/// still blocks resubmitting the same order twice.
contract ProofGate {
    /// @dev keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)")
    bytes32 public constant ORDER_PLACED_SIGNATURE =
        keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)");

    address internal constant CHAIN_INFO_PRECOMPILE = 0x0000000000000000000000000000000000000fD3;

    INativeQueryVerifier public immutable VERIFIER;
    IChainInfo public immutable CHAIN_INFO;

    /// @notice The only contract ProofGate accepts OrderPlaced logs from.
    address public immutable ORDER_BOOK;
    /// @notice Creditcoin-internal chain key for the source chain (Sepolia = 1). Not the EVM chainId.
    uint64 public immutable SOURCE_CHAIN_KEY;
    /// @notice Orders whose Sepolia block is more than this many blocks behind the latest
    /// attested height are rejected as stale.
    uint64 public immutable STALENESS_WINDOW_BLOCKS;

    /// @notice Permissionless game registry. Real lifecycle (closing/settling) belongs to
    /// FactionMarch (Phase 6/7); this is the minimal standalone version Phase 5 needs to be
    /// testable before that contract exists.
    mapping(uint256 => bool) public activeGames;

    /// @notice Replay guard, keyed on (blockHeight, txIndex, logIndex) — never blockHeight
    /// alone (two orders can share a block) and never txHash alone (doesn't disambiguate
    /// position for the ordering story other checks rely on).
    mapping(bytes32 => bool) public processedOrders;

    event OrderArrived(
        address indexed commander, uint256 indexed gameId, uint16 indexed zoneId, uint32 units, uint64 nonce
    );
    event GameRegistered(uint256 indexed gameId);

    error ForgedEmitter();
    error WrongTopic0();
    error WrongTopicCount(uint256 count);
    error GameNotActive(uint256 gameId);
    error GameAlreadyRegistered(uint256 gameId);
    error OrderAlreadyProcessed(bytes32 orderKey);
    error OrderStale(uint64 orderHeight, uint64 latestAttestedHeight);
    error TransactionDidNotSucceed();
    error ProofVerificationFailed();

    constructor(address orderBook, uint64 sourceChainKey, uint64 stalenessWindowBlocks) {
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        CHAIN_INFO = IChainInfo(CHAIN_INFO_PRECOMPILE);
        ORDER_BOOK = orderBook;
        SOURCE_CHAIN_KEY = sourceChainKey;
        STALENESS_WINDOW_BLOCKS = stalenessWindowBlocks;
    }

    /// @notice Opens ProofGate to orders for `gameId`. Permissionless — anyone can start a
    /// game. Cannot be un-registered here; that's Phase 6/7's job once FactionMarch exists.
    function registerGame(uint256 gameId) external {
        if (activeGames[gameId]) revert GameAlreadyRegistered(gameId);
        activeGames[gameId] = true;
        emit GameRegistered(gameId);
    }

    /// @notice Verify a proof of a Sepolia OrderBook.placeOrder transaction and, if it
    /// passes every check, emit the decoded order. Callable by anyone — this is the
    /// permissionless courier entry point (Phase 8).
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

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionDidNotSucceed();

        // Checks 1-3: emitter allowlist, topic0, topic count.
        (EvmV1Decoder.LogEntry memory log, uint256 logIndex) = _findOrderLog(receipt);

        address commander = address(uint160(uint256(log.topics[1])));
        uint256 gameId = uint256(log.topics[2]);
        uint16 zoneId = uint16(uint256(log.topics[3]));
        (uint32 units, uint64 nonce) = abi.decode(log.data, (uint32, uint64));

        // Check 4: gameId binding.
        if (!activeGames[gameId]) revert GameNotActive(gameId);

        // Check 5: exact replay / same-block sibling replay.
        uint64 txIndex = VERIFIER.calculateTxIndex(merkleProof);
        bytes32 orderKey = keccak256(abi.encode(blockHeight, txIndex, logIndex));
        if (processedOrders[orderKey]) revert OrderAlreadyProcessed(orderKey);
        processedOrders[orderKey] = true;

        // Check 7: staleness window.
        IChainInfo.HeightHashResult memory latest = CHAIN_INFO.get_latest_attestation_height_and_hash(SOURCE_CHAIN_KEY);
        if (latest.exists && latest.height > blockHeight && (latest.height - blockHeight) > STALENESS_WINDOW_BLOCKS) {
            revert OrderStale(blockHeight, latest.height);
        }

        emit OrderArrived(commander, gameId, zoneId, units, nonce);
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
