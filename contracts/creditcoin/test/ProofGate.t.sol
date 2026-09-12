// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProofGate, IChainInfo} from "../src/ProofGate.sol";
import {FactionMarch} from "../src/FactionMarch.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev Neither the block-prover precompile (0xFD2) nor the ChainInfo precompile (0xFD3)
/// exist in a plain forge EVM, so both are mocked with vm.mockCall. FactionMarch itself is
/// real (not mocked) — it's pure Solidity with no precompile dependency, so this suite
/// exercises the actual Phase 7 wiring: a successful submitOrderProof really does resolve
/// combat on FactionMarch in the same call.
contract ProofGateTest is Test {
    address constant BLOCK_PROVER = 0x0000000000000000000000000000000000000FD2;
    address constant CHAIN_INFO_PRECOMPILE = 0x0000000000000000000000000000000000000fD3;

    bytes4 constant VERIFY_SELECTOR =
        bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
    bytes4 constant TX_INDEX_SELECTOR = bytes4(keccak256("calculateTxIndex((bytes32,(bytes32,bool)[]))"));
    bytes4 constant GET_LATEST_SELECTOR = bytes4(keccak256("get_latest_attestation_height_and_hash(uint64)"));
    bytes32 constant ORDER_PLACED_SIGNATURE = keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)");

    uint64 constant SOURCE_CHAIN_KEY = 1;
    uint64 constant STALENESS_WINDOW = 50;
    uint64 constant BLOCK_HEIGHT = 100;
    uint256 constant GAME_ID = 1;

    ProofGate gate;
    FactionMarch march;
    address orderBook;
    address commander;
    address otherCommander;

    function setUp() public {
        orderBook = makeAddr("orderBook");
        commander = makeAddr("commander");
        otherCommander = makeAddr("otherCommander");

        march = new FactionMarch();
        gate = new ProofGate(orderBook, address(march), SOURCE_CHAIN_KEY, STALENESS_WINDOW);
        march.setProofGate(address(gate));

        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(VERIFY_SELECTOR), abi.encode(true));
        // Default: "not stale" — latest attested height equals the block height most tests use.
        vm.mockCall(
            CHAIN_INFO_PRECOMPILE,
            abi.encodeWithSelector(GET_LATEST_SELECTOR),
            abi.encode(IChainInfo.HeightHashResult({height: BLOCK_HEIGHT, hash: bytes32(0), isAttestation: true, exists: true}))
        );

        // Game 1: both commanders join during OPEN, then roll into ACTIVE with plenty of
        // replenished units for every test scenario.
        uint256 gameId = march.createGame(12, 1, 100_000);
        require(gameId == GAME_ID, "unexpected gameId");
        vm.prank(commander);
        march.join(GAME_ID); // Alpha
        vm.prank(otherCommander);
        march.join(GAME_ID); // Beta
        vm.roll(block.number + 100);
    }

    function _mockTxIndex(bytes32 root, uint64 txIndex) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(txIndex));
    }

    function _orderTopics(address commanderAddr, uint256 gameId, uint16 zoneId) internal pure returns (bytes32[] memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = ORDER_PLACED_SIGNATURE;
        topics[1] = bytes32(uint256(uint160(commanderAddr)));
        topics[2] = bytes32(gameId);
        topics[3] = bytes32(uint256(zoneId));
        return topics;
    }

    function _encodeTx(address emitter, bytes32[] memory topics, bytes memory data, uint8 receiptStatus)
        internal
        pure
        returns (bytes memory)
    {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});

        bytes memory receiptChunk = abi.encode(receiptStatus, uint64(21000), logs, bytes(""));

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = bytes("");
        chunks[1] = bytes("");
        chunks[2] = receiptChunk;

        return abi.encode(uint8(0), chunks);
    }

    function _submit(bytes memory encodedTx, bytes32 root, uint64 blockHeight) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        gate.submitOrderProof(blockHeight, encodedTx, root, siblings, bytes32(0), new bytes32[](0));
    }

    function test_relaysDecodedOrderAndResolvesOnFactionMarch() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(1));
        _mockTxIndex(root, 0);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, GAME_ID, 3, 50, 0);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, 3);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 50);
    }

    function test_revert_forgedEmitter() public {
        address attacker = makeAddr("attacker");
        bytes memory encodedTx = _encodeTx(attacker, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(2));
        _mockTxIndex(root, 0);

        vm.expectRevert(ProofGate.ForgedEmitter.selector);
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_wrongTopic0() public {
        bytes32[] memory topics = _orderTopics(commander, GAME_ID, 3);
        topics[0] = keccak256("SomethingElse(address)");
        bytes memory encodedTx = _encodeTx(orderBook, topics, abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(3));
        _mockTxIndex(root, 0);

        vm.expectRevert(ProofGate.WrongTopic0.selector);
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_topicCountMismatch() public {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = ORDER_PLACED_SIGNATURE;
        topics[1] = bytes32(uint256(uint160(commander)));
        topics[2] = bytes32(GAME_ID);
        bytes memory encodedTx = _encodeTx(orderBook, topics, abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(4));
        _mockTxIndex(root, 0);

        vm.expectRevert(abi.encodeWithSelector(ProofGate.WrongTopicCount.selector, 3));
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_crossGameOrder() public {
        // gameId 99 doesn't exist on FactionMarch at all — only game 1 was created (see setUp).
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, 99, 3), abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(5));
        _mockTxIndex(root, 0);

        vm.expectRevert(abi.encodeWithSelector(ProofGate.GameNotActive.selector, 99));
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_exactReplay() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(6));
        _mockTxIndex(root, 0);

        _submit(encodedTx, root, BLOCK_HEIGHT);

        vm.expectRevert(
            abi.encodeWithSelector(ProofGate.OrderAlreadyProcessed.selector, keccak256(abi.encode(BLOCK_HEIGHT, uint64(0), uint256(0))))
        );
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_sameBlockSiblingReplay() public {
        // Two genuinely different orders, same block, different txIndex — both must succeed
        // (proving replay protection isn't coarsely keyed on blockHeight alone). Then replaying
        // the first one's exact proof must still be rejected.
        bytes memory orderA = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 1), abi.encode(uint32(10), uint64(0)), 1);
        bytes32 rootA = bytes32(uint256(0xA));
        _mockTxIndex(rootA, 2);

        bytes memory orderC = _encodeTx(orderBook, _orderTopics(otherCommander, GAME_ID, 2), abi.encode(uint32(20), uint64(0)), 1);
        bytes32 rootC = bytes32(uint256(0xC));
        _mockTxIndex(rootC, 5);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, GAME_ID, 1, 10, 0);
        _submit(orderA, rootA, BLOCK_HEIGHT);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(otherCommander, GAME_ID, 2, 20, 0);
        _submit(orderC, rootC, BLOCK_HEIGHT);

        vm.expectRevert(
            abi.encodeWithSelector(ProofGate.OrderAlreadyProcessed.selector, keccak256(abi.encode(BLOCK_HEIGHT, uint64(2), uint256(0))))
        );
        _submit(orderA, rootA, BLOCK_HEIGHT);
    }

    function test_revert_staleOrder() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(50), uint64(0)), 1);
        bytes32 root = bytes32(uint256(7));
        _mockTxIndex(root, 0);

        uint64 farAheadHeight = BLOCK_HEIGHT + STALENESS_WINDOW + 1;
        vm.mockCall(
            CHAIN_INFO_PRECOMPILE,
            abi.encodeWithSelector(GET_LATEST_SELECTOR),
            abi.encode(IChainInfo.HeightHashResult({height: farAheadHeight, hash: bytes32(0), isAttestation: true, exists: true}))
        );

        vm.expectRevert(abi.encodeWithSelector(ProofGate.OrderStale.selector, BLOCK_HEIGHT, farAheadHeight));
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_transactionDidNotSucceed() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(50), uint64(0)), 0);
        bytes32 root = bytes32(uint256(8));
        _mockTxIndex(root, 0);

        vm.expectRevert(ProofGate.TransactionDidNotSucceed.selector);
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    // --- Phase 7: "arrival order is authority", not Sepolia send order ---

    /// @notice Order A is sent FIRST on Sepolia (nonce 0); Order B is sent SECOND (nonce 1).
    /// Both attack the same unclaimed zone with equal units, so whichever one's proof is
    /// *processed* first captures it and the other (arriving second, equal strength) fails
    /// to flip it back — a tie favours whoever already holds the zone. The courier proves
    /// B before A here, and B wins, even though B was sent second on Sepolia. Reversing the
    /// submission order below (test_arrivalOrder_sentFirstButProvenSecond_loses) shows the
    /// opposite outcome with the identical two orders — proving it's proof-arrival order on
    /// Creditcoin that decides the zone, never Sepolia send order.
    function test_arrivalOrder_laterSentOrderWinsBecauseItArrivedFirst() public {
        uint16 zoneId = 7;
        uint32 units = 10;

        bytes memory orderA = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, zoneId), abi.encode(units, uint64(0)), 1);
        bytes32 rootA = bytes32(uint256(0x1001));
        _mockTxIndex(rootA, 3);

        bytes memory orderB =
            _encodeTx(orderBook, _orderTopics(otherCommander, GAME_ID, zoneId), abi.encode(units, uint64(1)), 1);
        bytes32 rootB = bytes32(uint256(0x1002));
        _mockTxIndex(rootB, 7);

        // Sepolia block order would be A (nonce 0) then B (nonce 1). The courier instead
        // proves B first — its proof simply arrived on Creditcoin first.
        _submit(orderB, rootB, BLOCK_HEIGHT);
        _submit(orderA, rootA, BLOCK_HEIGHT + 1);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, zoneId);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Beta), "later-sent order (B) should hold the zone");
        // B captured first (garrison 10), then A's equal-strength attack is a tie: garrison
        // drops to 0 but ownership doesn't flip back to A.
        assertEq(garrison, 0, "tie: second mover (A) fails to flip it back");
    }

    function test_arrivalOrder_sentFirstButProvenSecond_loses() public {
        uint16 zoneId = 8;
        uint32 units = 10;

        bytes memory orderA = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, zoneId), abi.encode(units, uint64(0)), 1);
        bytes32 rootA = bytes32(uint256(0x2001));
        _mockTxIndex(rootA, 3);

        bytes memory orderB =
            _encodeTx(orderBook, _orderTopics(otherCommander, GAME_ID, zoneId), abi.encode(units, uint64(1)), 1);
        bytes32 rootB = bytes32(uint256(0x2002));
        _mockTxIndex(rootB, 7);

        // This time arrival order matches Sepolia send order: A (sent first) is also proven
        // first, and holds the zone against B's equal-strength follow-up.
        _submit(orderA, rootA, BLOCK_HEIGHT);
        _submit(orderB, rootB, BLOCK_HEIGHT + 1);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, zoneId);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha), "first-sent order (A) holds when also proven first");
        assertEq(garrison, 0, "tie: second mover (B) fails to flip it back");
    }
}
