// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProofGate, IChainInfo} from "../src/ProofGate.sol";
import {FactionMarch} from "../src/FactionMarch.sol";
import {WarChest} from "../src/WarChest.sol";
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
    bytes4 constant VERIFY_BATCH_SELECTOR = bytes4(
        keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))")
    );
    bytes4 constant TX_INDEX_SELECTOR = bytes4(keccak256("calculateTxIndex((bytes32,(bytes32,bool)[]))"));
    bytes4 constant GET_LATEST_SELECTOR = bytes4(keccak256("get_latest_attestation_height_and_hash(uint64)"));
    bytes32 constant ORDER_PLACED_SIGNATURE = keccak256("OrderRevealed(address,uint256,uint16,uint32,uint64)");

    uint64 constant SOURCE_CHAIN_KEY = 1;
    uint64 constant STALENESS_WINDOW = 50;
    uint64 constant BLOCK_HEIGHT = 100;
    uint256 constant GAME_ID = 1;
    uint256 constant BOUNTY_PER_ORDER = 0.0001 ether;
    // Zero here so every existing call site below doesn't need a msg.value change -- the
    // chest-fee mechanic itself gets dedicated tests against a separately-deployed ProofGate
    // with a real nonzero fee (see "chest fee" section near the bottom of this file).
    uint256 constant CHEST_FEE_PER_ORDER = 0;

    ProofGate gate;
    FactionMarch march;
    WarChest chest;
    address orderBook;
    address commander;
    address otherCommander;

    function setUp() public {
        orderBook = makeAddr("orderBook");
        commander = makeAddr("commander");
        otherCommander = makeAddr("otherCommander");

        march = new FactionMarch();
        chest = new WarChest(address(march), 5000);
        gate = new ProofGate(
            orderBook, address(march), address(chest), SOURCE_CHAIN_KEY, STALENESS_WINDOW, BOUNTY_PER_ORDER, CHEST_FEE_PER_ORDER
        );
        march.setProofGate(address(gate));
        chest.setProofGate(address(gate));

        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(VERIFY_SELECTOR), abi.encode(true));
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(VERIFY_BATCH_SELECTOR), abi.encode(true));
        // Default: "not stale" — latest attested height equals the block height most tests use.
        vm.mockCall(
            CHAIN_INFO_PRECOMPILE,
            abi.encodeWithSelector(GET_LATEST_SELECTOR),
            abi.encode(IChainInfo.HeightHashResult({height: BLOCK_HEIGHT, hash: bytes32(0), isAttestation: true, exists: true}))
        );

        // Game 1: both commanders join during OPEN, then roll into ACTIVE with plenty of
        // replenished units for every test scenario.
        uint256 gameId = march.createGame(12, 1, 20_000);
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
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(1));
        _mockTxIndex(root, 0);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, GAME_ID, 3, 5, 0);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, 3);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 5);
    }

    function test_revert_forgedEmitter() public {
        address attacker = makeAddr("attacker");
        bytes memory encodedTx = _encodeTx(attacker, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(2));
        _mockTxIndex(root, 0);

        vm.expectRevert(ProofGate.ForgedEmitter.selector);
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_wrongTopic0() public {
        bytes32[] memory topics = _orderTopics(commander, GAME_ID, 3);
        topics[0] = keccak256("SomethingElse(address)");
        bytes memory encodedTx = _encodeTx(orderBook, topics, abi.encode(uint32(5), uint64(0)), 1);
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
        bytes memory encodedTx = _encodeTx(orderBook, topics, abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(4));
        _mockTxIndex(root, 0);

        vm.expectRevert(abi.encodeWithSelector(ProofGate.WrongTopicCount.selector, 3));
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_crossGameOrder() public {
        // gameId 99 doesn't exist on FactionMarch at all — only game 1 was created (see setUp).
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, 99, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(5));
        _mockTxIndex(root, 0);

        vm.expectRevert(abi.encodeWithSelector(ProofGate.GameNotActive.selector, 99));
        _submit(encodedTx, root, BLOCK_HEIGHT);
    }

    function test_revert_exactReplay() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
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

        bytes memory orderC = _encodeTx(orderBook, _orderTopics(otherCommander, GAME_ID, 2), abi.encode(uint32(6), uint64(0)), 1);
        bytes32 rootC = bytes32(uint256(0xC));
        _mockTxIndex(rootC, 5);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, GAME_ID, 1, 10, 0);
        _submit(orderA, rootA, BLOCK_HEIGHT);

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(otherCommander, GAME_ID, 2, 6, 0);
        _submit(orderC, rootC, BLOCK_HEIGHT);

        vm.expectRevert(
            abi.encodeWithSelector(ProofGate.OrderAlreadyProcessed.selector, keccak256(abi.encode(BLOCK_HEIGHT, uint64(2), uint256(0))))
        );
        _submit(orderA, rootA, BLOCK_HEIGHT);
    }

    function test_revert_staleOrder() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
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

    /// @notice Phase 11: "what happens when no courier ever shows up." An order nobody ever
    /// proves has zero side effects — resolveOrder never runs, so the commander's units were
    /// never spent and remain fully available. There is no explicit "expire" transaction
    /// because there is no state anywhere that needs cleaning up.
    function test_neverCouriered_orderExpiresSafely_noStateChangeAndUnitsUnaffected() public {
        uint256 unitsBefore = march.currentUnits(GAME_ID, commander);

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(99));
        _mockTxIndex(root, 0);

        // Simulate "no courier ever shows up": time passes well beyond the staleness window
        // without anyone calling submitOrderProof.
        uint64 farAheadHeight = BLOCK_HEIGHT + STALENESS_WINDOW + 1;
        vm.mockCall(
            CHAIN_INFO_PRECOMPILE,
            abi.encodeWithSelector(GET_LATEST_SELECTOR),
            abi.encode(IChainInfo.HeightHashResult({height: farAheadHeight, hash: bytes32(0), isAttestation: true, exists: true}))
        );

        // A late attempt correctly fails, and reverts fully undo the replay-guard write --
        // this order's slot was never actually consumed.
        bytes32 orderKey = keccak256(abi.encode(BLOCK_HEIGHT, uint64(0), uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(ProofGate.OrderStale.selector, BLOCK_HEIGHT, farAheadHeight));
        _submit(encodedTx, root, BLOCK_HEIGHT);
        assertFalse(gate.processedOrders(orderKey));

        // Nothing was ever spent or locked: units are at least what they were before (only
        // replenishment can move this number), and zone 3 was never touched.
        assertGe(march.currentUnits(GAME_ID, commander), unitsBefore);
        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, 3);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.None), "zone was never touched by the stale order");
        assertEq(garrison, 0);

        // The commander can immediately place and resolve a fresh order for the same zone --
        // the never-couriered order does not wedge the game in any way.
        bytes memory freshTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(1)), 1);
        bytes32 freshRoot = bytes32(uint256(100));
        _mockTxIndex(freshRoot, 1);
        _submit(freshTx, freshRoot, BLOCK_HEIGHT + 10);

        (FactionMarch.Faction ownerAfter, uint256 garrisonAfter) = march.zones(GAME_ID, 3);
        assertEq(uint8(ownerAfter), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrisonAfter, 5);
    }

    function test_revert_transactionDidNotSucceed() public {
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 0);
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

    // --- Phase 8: bounty ---

    function test_fundBounties_increasesPool() public {
        gate.fundBounties{value: 1 ether}();
        assertEq(gate.bountyPool(), 1 ether);
    }

    function test_courier_paidBountyOnSuccess() public {
        gate.fundBounties{value: 1 ether}();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(9));
        _mockTxIndex(root, 0);

        address courier = makeAddr("courier");
        uint256 before = courier.balance;

        vm.prank(courier);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        assertEq(courier.balance, before + BOUNTY_PER_ORDER);
        assertEq(gate.bountyPool(), 1 ether - BOUNTY_PER_ORDER);
    }

    function test_soloPlay_commanderCouriersOwnOrderAndCollectsBounty() public {
        gate.fundBounties{value: 1 ether}();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(10));
        _mockTxIndex(root, 0);

        uint256 before = commander.balance;
        vm.prank(commander);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        assertEq(commander.balance, before + BOUNTY_PER_ORDER, "commander couriering their own order still gets paid");
    }

    function test_bountySkippedWhenPoolDry_orderStillResolves() public {
        // No fundBounties() call — pool starts at 0.
        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(11));
        _mockTxIndex(root, 0);

        address courier = makeAddr("courier");
        uint256 before = courier.balance;

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.BountySkipped(keccak256(abi.encode(BLOCK_HEIGHT, uint64(0), uint256(0))), BOUNTY_PER_ORDER, 0);

        vm.prank(courier);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        assertEq(courier.balance, before, "no bounty paid");
        (FactionMarch.Faction owner, uint256 garrison) = march.zones(GAME_ID, 3);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha), "order still resolves with a dry pool");
        assertEq(garrison, 5);
    }

    /// @notice Two independent courier processes race to submit the identical proof for the
    /// same order. Exactly one is paid; the loser's transaction reverts entirely (no partial
    /// state change, no partial bounty).
    function test_twoCouriersRaceForSameBounty_exactlyOnePaid() public {
        gate.fundBounties{value: 1 ether}();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(12));
        _mockTxIndex(root, 0);

        address courierAlice = makeAddr("courierAlice");
        address courierBob = makeAddr("courierBob");
        uint256 aliceBefore = courierAlice.balance;
        uint256 bobBefore = courierBob.balance;

        vm.prank(courierAlice);
        _submit(encodedTx, root, BLOCK_HEIGHT);

        vm.prank(courierBob);
        vm.expectRevert(
            abi.encodeWithSelector(ProofGate.OrderAlreadyProcessed.selector, keccak256(abi.encode(BLOCK_HEIGHT, uint64(0), uint256(0))))
        );
        _submit(encodedTx, root, BLOCK_HEIGHT);

        assertEq(courierAlice.balance, aliceBefore + BOUNTY_PER_ORDER, "winner is paid");
        assertEq(courierBob.balance, bobBefore, "loser gets nothing - its whole tx reverted");
    }

    // --- Phase 8: batching ---

    function _submitBatch(
        uint64[] memory heights,
        bytes[] memory encodedTxs,
        bytes32[] memory roots
    ) internal {
        INativeQueryVerifier.MerkleProofEntry[][] memory siblingsPerOrder =
            new INativeQueryVerifier.MerkleProofEntry[][](roots.length);
        for (uint256 i = 0; i < roots.length; i++) {
            siblingsPerOrder[i] = new INativeQueryVerifier.MerkleProofEntry[](0);
        }
        gate.submitOrderProofBatch(heights, encodedTxs, roots, siblingsPerOrder, bytes32(0), new bytes32[](0));
    }

    function test_batch_tenOrdersLandInOneTransaction() public {
        gate.fundBounties{value: 1 ether}();

        uint256 n = gate.MAX_BATCH_SIZE();
        uint64[] memory heights = new uint64[](n);
        bytes[] memory encodedTxs = new bytes[](n);
        bytes32[] memory roots = new bytes32[](n);

        for (uint256 i = 0; i < n; i++) {
            heights[i] = BLOCK_HEIGHT + uint64(i);
            roots[i] = bytes32(uint256(1000 + i));
            _mockTxIndex(roots[i], uint64(i));
            encodedTxs[i] =
                _encodeTx(orderBook, _orderTopics(commander, GAME_ID, uint16(i)), abi.encode(uint32(1), uint64(i)), 1);
        }

        address courier = makeAddr("batchCourier");
        uint256 before = courier.balance;

        vm.prank(courier);
        _submitBatch(heights, encodedTxs, roots);

        assertEq(courier.balance, before + n * BOUNTY_PER_ORDER, "one bounty per order in the batch");
        for (uint256 i = 0; i < n; i++) {
            (FactionMarch.Faction owner,) = march.zones(GAME_ID, uint16(i));
            assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        }
    }

    function test_revert_batch_tooLarge() public {
        uint256 n = gate.MAX_BATCH_SIZE() + 1;
        uint64[] memory heights = new uint64[](n);
        bytes[] memory encodedTxs = new bytes[](n);
        bytes32[] memory roots = new bytes32[](n);

        vm.expectRevert(abi.encodeWithSelector(ProofGate.InvalidBatchSize.selector, n));
        _submitBatch(heights, encodedTxs, roots);
    }

    function test_revert_batch_empty() public {
        vm.expectRevert(abi.encodeWithSelector(ProofGate.InvalidBatchSize.selector, 0));
        _submitBatch(new uint64[](0), new bytes[](0), new bytes32[](0));
    }

    function test_revert_batch_lengthMismatch() public {
        uint64[] memory heights = new uint64[](2);
        bytes[] memory encodedTxs = new bytes[](1); // mismatched on purpose
        bytes32[] memory roots = new bytes32[](2);

        vm.expectRevert(ProofGate.BatchLengthMismatch.selector);
        _submitBatch(heights, encodedTxs, roots);
    }

    function test_batch_oneBadOrderRevertsWholeBatch() public {
        // A batch is one transaction: if any order in it fails a check, the whole batch
        // reverts, including the otherwise-valid orders alongside it.
        uint64[] memory heights = new uint64[](2);
        bytes[] memory encodedTxs = new bytes[](2);
        bytes32[] memory roots = new bytes32[](2);

        heights[0] = BLOCK_HEIGHT;
        roots[0] = bytes32(uint256(2000));
        _mockTxIndex(roots[0], 0);
        encodedTxs[0] = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 5), abi.encode(uint32(1), uint64(0)), 1);

        heights[1] = BLOCK_HEIGHT + 1;
        roots[1] = bytes32(uint256(2001));
        _mockTxIndex(roots[1], 1);
        address attacker = makeAddr("attacker");
        encodedTxs[1] = _encodeTx(attacker, _orderTopics(commander, GAME_ID, 6), abi.encode(uint32(1), uint64(1)), 1);

        vm.expectRevert(ProofGate.ForgedEmitter.selector);
        _submitBatch(heights, encodedTxs, roots);

        (FactionMarch.Faction owner,) = march.zones(GAME_ID, 5);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.None), "the valid order in the same batch must not have applied either");
    }

    // --- Phase 13: chest fee -- a real, native way for the chest to grow with actual play ---
    // Deployed with its own nonzero CHEST_FEE_PER_ORDER (the shared `gate` above keeps it at
    // zero so every test above didn't need a msg.value change).

    uint256 constant CHEST_FEE = 0.00005 ether;

    /// @dev FactionMarch/WarChest's setProofGate is one-shot -- the shared setUp() already
    /// spent it on `gate` (fee-free), so any chest-fee test that needs a real successful
    /// resolution needs its own fresh march+chest+gate trio, not the shared ones.
    function _freshTrioWithChestFee() internal returns (FactionMarch freshMarch, WarChest freshChest, ProofGate feeGate) {
        freshMarch = new FactionMarch();
        freshChest = new WarChest(address(freshMarch), 5000);
        feeGate = new ProofGate(
            orderBook, address(freshMarch), address(freshChest), SOURCE_CHAIN_KEY, STALENESS_WINDOW, BOUNTY_PER_ORDER, CHEST_FEE
        );
        freshMarch.setProofGate(address(feeGate));
        freshChest.setProofGate(address(feeGate));

        freshMarch.createGame(12, 1, 20_000);
        vm.prank(commander);
        freshMarch.join(GAME_ID);
        vm.roll(block.number + 100);
    }

    function test_revert_submitOrderProof_incorrectChestFee() public {
        // The fee (with any discount) isn't known until the order's commander is decoded,
        // deep inside _processOrder -- so unlike the old single-check version, this needs a
        // properly wired trio to reach that check at all, not just a bare unwired ProofGate.
        (,, ProofGate feeGate) = _freshTrioWithChestFee();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(5500));
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(0)));

        // No territory yet -- no discount, so the required fee is exactly CHEST_FEE.
        vm.expectRevert(abi.encodeWithSelector(ProofGate.IncorrectChestFee.selector, 0, CHEST_FEE));
        feeGate.submitOrderProof(BLOCK_HEIGHT, encodedTx, root, siblings, bytes32(0), new bytes32[](0));
    }

    function test_submitOrderProof_depositsChestFeeIntoWarChest() public {
        (FactionMarch freshMarch, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(5), uint64(0)), 1);
        bytes32 root = bytes32(uint256(3001));
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(0)));

        address courier = makeAddr("feeCourier");
        vm.deal(courier, CHEST_FEE);
        assertEq(freshChest.chestBalance(GAME_ID), 0);

        vm.prank(courier);
        feeGate.submitOrderProof{value: CHEST_FEE}(BLOCK_HEIGHT, encodedTx, root, siblings, bytes32(0), new bytes32[](0));

        // This same order's own resolution captures zone 3 before the fee is deposited, so
        // the commander's faction already holds the only territory on the board by the time
        // WarChest splits the fee -- 100% of the yield share lands with them too.
        uint256 expectedChestBalance = CHEST_FEE - (CHEST_FEE * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "courier's fee landed in this order's game's chest, minus the territory yield share");
        (FactionMarch.Faction owner,) = freshMarch.zones(GAME_ID, 3);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha), "combat still resolved in the same transaction");
    }

    function test_submitOrderProofBatch_chargesFeePerOrder_depositsIntoChest() public {
        (, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        uint64[] memory heights = new uint64[](2);
        bytes[] memory encodedTxs = new bytes[](2);
        bytes32[] memory roots = new bytes32[](2);
        INativeQueryVerifier.MerkleProofEntry[][] memory siblingsPerOrder = new INativeQueryVerifier.MerkleProofEntry[][](2);

        for (uint256 i = 0; i < 2; i++) {
            heights[i] = BLOCK_HEIGHT + uint64(i);
            roots[i] = bytes32(uint256(4000 + i));
            siblingsPerOrder[i] = new INativeQueryVerifier.MerkleProofEntry[](0);
            INativeQueryVerifier.MerkleProof memory proof =
                INativeQueryVerifier.MerkleProof({root: roots[i], siblings: siblingsPerOrder[i]});
            vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(i)));
            encodedTxs[i] =
                _encodeTx(orderBook, _orderTopics(commander, GAME_ID, uint16(i)), abi.encode(uint32(1), uint64(i)), 1);
        }

        address courier = makeAddr("batchFeeCourier");
        vm.deal(courier, CHEST_FEE * 2);

        vm.prank(courier);
        feeGate.submitOrderProofBatch{value: CHEST_FEE * 2}(
            heights, encodedTxs, roots, siblingsPerOrder, bytes32(0), new bytes32[](0)
        );

        // Both orders resolve (capturing zones 0 and 1 for the same commander) before either
        // fee is deposited -- by the time each deposit's yield split runs, that one faction
        // already holds all the territory on the board, so it earns 100% of both shares.
        uint256 expectedChestBalance = (CHEST_FEE * 2) - ((CHEST_FEE * 2) * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "one fee share per order in the batch, minus the territory yield share");
    }

    function test_revert_submitOrderProofBatch_incorrectChestFee() public {
        // The fee check now runs *after* every order in the batch is fully processed (it
        // needs each commander decoded first, to look up their discount) -- so unlike the
        // single-order version above, this needs a properly wired trio to reach that check
        // at all, not just a bare unwired ProofGate.
        (, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        uint64[] memory heights = new uint64[](2);
        bytes[] memory encodedTxs = new bytes[](2);
        bytes32[] memory roots = new bytes32[](2);
        INativeQueryVerifier.MerkleProofEntry[][] memory siblingsPerOrder = new INativeQueryVerifier.MerkleProofEntry[][](2);

        for (uint256 i = 0; i < 2; i++) {
            heights[i] = BLOCK_HEIGHT + uint64(i);
            roots[i] = bytes32(uint256(5000 + i));
            siblingsPerOrder[i] = new INativeQueryVerifier.MerkleProofEntry[](0);
            INativeQueryVerifier.MerkleProof memory proof =
                INativeQueryVerifier.MerkleProof({root: roots[i], siblings: siblingsPerOrder[i]});
            vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(i)));
            encodedTxs[i] =
                _encodeTx(orderBook, _orderTopics(commander, GAME_ID, uint16(i)), abi.encode(uint32(1), uint64(i)), 1);
        }

        // Sent enough for only one order, not both -- commander here holds no territory, so
        // there's no discount and the required total is exactly CHEST_FEE * 2.
        vm.expectRevert(abi.encodeWithSelector(ProofGate.IncorrectChestFee.selector, CHEST_FEE, CHEST_FEE * 2));
        feeGate.submitOrderProofBatch{value: CHEST_FEE}(
            heights, encodedTxs, roots, siblingsPerOrder, bytes32(0), new bytes32[](0)
        );

        // Reverted atomically -- neither order actually resolved, chest got nothing.
        assertEq(freshChest.chestBalance(GAME_ID), 0);
    }

    // --- Phase 17: overpayment is refunded rather than rejected ---

    function test_submitOrderProof_overpaidChestFee_refundsExcess() public {
        // A courier's pre-flight fee estimate is read before this transaction runs, so it
        // can't see a discount this same order's own capture is about to unlock -- exactly
        // what happened live and prompted this fix. Simulate that mismatch directly: pay the
        // full undiscounted CHEST_FEE for an order that, once resolved, actually qualifies
        // for a discount, and confirm it succeeds (instead of reverting) with the difference
        // refunded.
        (FactionMarch freshMarch, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        vm.startPrank(address(feeGate));
        freshMarch.resolveOrder(GAME_ID, commander, 0, 1);
        freshMarch.resolveOrder(GAME_ID, commander, 1, 1);
        freshMarch.resolveOrder(GAME_ID, commander, 2, 1);
        vm.stopPrank();
        uint256 discountedFee = CHEST_FEE - (CHEST_FEE * 500) / 10_000; // TIER_1, 5% off

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(1), uint64(0)), 1);
        bytes32 root = bytes32(uint256(7001));
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(0)));

        address courier = makeAddr("overpayCourier");
        vm.deal(courier, CHEST_FEE); // pays the full, undiscounted fee -- more than actually required

        vm.prank(courier);
        feeGate.submitOrderProof{value: CHEST_FEE}(BLOCK_HEIGHT, encodedTx, root, siblings, bytes32(0), new bytes32[](0));

        assertEq(courier.balance, CHEST_FEE - discountedFee, "excess over the true (discounted) fee was refunded");
        uint256 expectedChestBalance = discountedFee - (discountedFee * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "chest only received the true discounted fee, not the overpayment");
    }

    function test_submitOrderProofBatch_overpaidChestFee_refundsExcess() public {
        (, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        uint64[] memory heights = new uint64[](2);
        bytes[] memory encodedTxs = new bytes[](2);
        bytes32[] memory roots = new bytes32[](2);
        INativeQueryVerifier.MerkleProofEntry[][] memory siblingsPerOrder = new INativeQueryVerifier.MerkleProofEntry[][](2);

        for (uint256 i = 0; i < 2; i++) {
            heights[i] = BLOCK_HEIGHT + uint64(i);
            roots[i] = bytes32(uint256(7100 + i));
            siblingsPerOrder[i] = new INativeQueryVerifier.MerkleProofEntry[](0);
            INativeQueryVerifier.MerkleProof memory proof =
                INativeQueryVerifier.MerkleProof({root: roots[i], siblings: siblingsPerOrder[i]});
            vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(i)));
            encodedTxs[i] =
                _encodeTx(orderBook, _orderTopics(commander, GAME_ID, uint16(i)), abi.encode(uint32(1), uint64(i)), 1);
        }

        address courier = makeAddr("batchOverpayCourier");
        vm.deal(courier, CHEST_FEE * 3); // sends far more than the true total (no discount applies -- commander starts with no territory)

        vm.prank(courier);
        feeGate.submitOrderProofBatch{value: CHEST_FEE * 3}(
            heights, encodedTxs, roots, siblingsPerOrder, bytes32(0), new bytes32[](0)
        );

        assertEq(courier.balance, CHEST_FEE, "excess over the true total (CHEST_FEE * 2) was refunded");
        uint256 expectedChestBalance = (CHEST_FEE * 2) - ((CHEST_FEE * 2) * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "chest only received the true total, not the overpayment");
    }

    // --- Phase 16: chest fee discount, scaled by the commander's own faction's territory ---

    function test_submitOrderProof_appliesDiscountFromCommandersTerritory() public {
        (FactionMarch freshMarch, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        // Give the commander's faction (Alpha) 3 zones -- TIER_1, a 5% discount -- by
        // resolving three cheap reinforcement orders directly (bypassing proofs entirely,
        // since this is just about setting up territory, not testing proof mechanics).
        vm.startPrank(address(feeGate));
        freshMarch.resolveOrder(GAME_ID, commander, 0, 1);
        freshMarch.resolveOrder(GAME_ID, commander, 1, 1);
        freshMarch.resolveOrder(GAME_ID, commander, 2, 1);
        vm.stopPrank();
        assertEq(freshChest.discountBps(GAME_ID, FactionMarch.Faction.Alpha), 500, "3 zones -> TIER_1, 5%");

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(1), uint64(0)), 1);
        bytes32 root = bytes32(uint256(6001));
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(0)));

        uint256 discountedFee = CHEST_FEE - (CHEST_FEE * 500) / 10_000; // 5% off
        assertLt(discountedFee, CHEST_FEE, "sanity: discount actually reduces the fee");

        address courier = makeAddr("discountCourier");
        vm.deal(courier, discountedFee);

        vm.prank(courier);
        feeGate.submitOrderProof{value: discountedFee}(BLOCK_HEIGHT, encodedTx, root, siblings, bytes32(0), new bytes32[](0));

        // This order captures a 4th zone for the same (only) faction on the board, so it
        // still earns 100% of the discounted fee's yield share.
        uint256 expectedChestBalance = discountedFee - (discountedFee * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "exactly the discounted amount landed in the chest, minus the territory yield share");
    }

    function test_submitOrderProof_zeroTerritory_noDiscount() public {
        (, WarChest freshChest, ProofGate feeGate) = _freshTrioWithChestFee();

        bytes memory encodedTx = _encodeTx(orderBook, _orderTopics(commander, GAME_ID, 3), abi.encode(uint32(1), uint64(0)), 1);
        bytes32 root = bytes32(uint256(6002));
        INativeQueryVerifier.MerkleProofEntry[] memory siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        INativeQueryVerifier.MerkleProof memory proof = INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        vm.mockCall(BLOCK_PROVER, abi.encodeWithSelector(TX_INDEX_SELECTOR, proof), abi.encode(uint64(0)));

        feeGate.submitOrderProof{value: CHEST_FEE}(BLOCK_HEIGHT, encodedTx, root, siblings, bytes32(0), new bytes32[](0));

        // No territory *before* this order -- hence no discount on the fee itself -- but its
        // own capture of zone 3 means the commander's faction holds the board's only
        // territory by the time the fee is deposited, so it still earns the yield share.
        uint256 expectedChestBalance = CHEST_FEE - (CHEST_FEE * freshChest.YIELD_SHARE_BPS()) / 10_000;
        assertEq(freshChest.chestBalance(GAME_ID), expectedChestBalance, "no discount, but the territory yield share still applies once this order captures a zone");
    }
}
