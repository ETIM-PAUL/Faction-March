// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactionMarch} from "../src/FactionMarch.sol";

contract FactionMarchTest is Test {
    FactionMarch march;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function setUp() public {
        march = new FactionMarch();
        // Phase 6 tests exercise resolveOrder via direct calls, with no proofs involved —
        // wiring the test contract itself as "proofGate" preserves that while still
        // exercising the real onlyProofGate access control (Phase 7).
        march.setProofGate(address(this));
    }

    function _createGame() internal returns (uint256 gameId) {
        gameId = march.createGame(12, 10, 100);
    }

    // --- lifecycle ---

    function test_createGame_startsOpen() public {
        uint256 gameId = _createGame();
        assertEq(uint8(march.currentState(gameId)), uint8(FactionMarch.GameState.OPEN));
    }

    function test_lifecycle_advancesPurelyFromBlockNumber() public {
        uint256 gameId = _createGame();
        (,, uint64 activeStartBlock, uint64 settleBlock) = march.games(gameId);

        vm.roll(activeStartBlock);
        assertEq(uint8(march.currentState(gameId)), uint8(FactionMarch.GameState.ACTIVE));

        vm.roll(settleBlock);
        assertEq(uint8(march.currentState(gameId)), uint8(FactionMarch.GameState.SETTLED));
    }

    function test_revert_createGame_zeroZoneCount() public {
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.InvalidZoneCount.selector, 0));
        march.createGame(0, 10, 100);
    }

    function test_revert_createGame_zeroDuration() public {
        vm.expectRevert(FactionMarch.InvalidDuration.selector);
        march.createGame(12, 0, 100);
    }

    function test_revert_currentState_unknownGame() public {
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.GameDoesNotExist.selector, 999));
        march.currentState(999);
    }

    // --- joining / auto-balance ---

    function test_join_autoBalancesAcrossFactions() public {
        uint256 gameId = _createGame();

        vm.prank(alice);
        march.join(gameId);
        vm.prank(bob);
        march.join(gameId);
        vm.prank(carol);
        march.join(gameId);
        vm.prank(dave);
        march.join(gameId);

        FactionMarch.Faction fa = march.commanderFaction(gameId, alice);
        FactionMarch.Faction fb = march.commanderFaction(gameId, bob);
        FactionMarch.Faction fc = march.commanderFaction(gameId, carol);
        FactionMarch.Faction fd = march.commanderFaction(gameId, dave);

        assertEq(uint8(fa), uint8(FactionMarch.Faction.Alpha));
        assertEq(uint8(fb), uint8(FactionMarch.Faction.Beta));
        assertEq(uint8(fc), uint8(FactionMarch.Faction.Gamma));
        // Fourth join: all three factions tied at 1, ties broken Alpha < Beta < Gamma.
        assertEq(uint8(fd), uint8(FactionMarch.Faction.Alpha));

        assertEq(march.factionHeadcount(gameId, uint8(FactionMarch.Faction.Alpha)), 2);
        assertEq(march.factionHeadcount(gameId, uint8(FactionMarch.Faction.Beta)), 1);
        assertEq(march.factionHeadcount(gameId, uint8(FactionMarch.Faction.Gamma)), 1);
    }

    function test_revert_join_alreadyJoined() public {
        uint256 gameId = _createGame();
        vm.startPrank(alice);
        march.join(gameId);
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.AlreadyJoined.selector, alice));
        march.join(gameId);
        vm.stopPrank();
    }

    function test_revert_join_afterOpenWindow() public {
        uint256 gameId = _createGame();
        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.GameNotOpen.selector, gameId));
        march.join(gameId);
    }

    // --- unit pool ---

    function test_unitPool_replenishesOverBlocks() public {
        uint256 gameId = _createGame();
        vm.prank(alice);
        march.join(gameId);

        assertEq(march.currentUnits(gameId, alice), 0);

        vm.roll(block.number + 30);
        assertEq(march.currentUnits(gameId, alice), 30 * march.UNITS_PER_BLOCK());
    }

    function test_unitPool_capsAtMax() public {
        uint256 gameId = _createGame();
        vm.prank(alice);
        march.join(gameId);

        vm.roll(block.number + 100_000);
        assertEq(march.currentUnits(gameId, alice), march.MAX_UNIT_POOL());
    }

    function test_unitPool_zeroForCommanderWhoNeverJoined() public {
        uint256 gameId = _createGame();
        assertEq(march.currentUnits(gameId, alice), 0);
    }

    // --- combat resolution ---

    function _joinAndActivate(uint256 gameId, address commander, uint256 blocksForUnits) internal {
        vm.prank(commander);
        march.join(gameId);
        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock + blocksForUnits);
    }

    function test_resolveOrder_capturesUnclaimedZone() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 10);

        march.resolveOrder(gameId, alice, 0, 5);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(gameId, 0);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 5);
    }

    function test_resolveOrder_reinforcesOwnZone() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 20);

        march.resolveOrder(gameId, alice, 0, 5);
        march.resolveOrder(gameId, alice, 0, 3);

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(gameId, 0);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 8);
    }

    /// @dev Both commanders must join during OPEN before either roll forward into ACTIVE —
    /// joining after the roll would revert with GameNotOpen.
    function _joinBothAndActivate(uint256 gameId, uint256 extraActiveBlocks) internal {
        vm.prank(alice);
        march.join(gameId);
        vm.prank(bob);
        march.join(gameId);

        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock + extraActiveBlocks);
    }

    function test_resolveOrder_attackerLosesOnInsufficientUnits() public {
        uint256 gameId = _createGame();
        _joinBothAndActivate(gameId, 20);

        march.resolveOrder(gameId, alice, 0, 10); // Alpha holds zone 0 with garrison 10
        march.resolveOrder(gameId, bob, 0, 4); // Beta attacks with fewer units than garrison

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(gameId, 0);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 6);
    }

    function test_resolveOrder_tieFavoursDefender() public {
        uint256 gameId = _createGame();
        _joinBothAndActivate(gameId, 20);

        march.resolveOrder(gameId, alice, 0, 10);
        march.resolveOrder(gameId, bob, 0, 10); // exact tie

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(gameId, 0);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison, 0);
    }

    function test_resolveOrder_attackerCapturesWithSurvivors() public {
        uint256 gameId = _createGame();
        _joinBothAndActivate(gameId, 20);

        march.resolveOrder(gameId, alice, 0, 10); // Alpha garrison 10
        march.resolveOrder(gameId, bob, 0, 15); // Beta attacks with more than garrison

        (FactionMarch.Faction owner, uint256 garrison) = march.zones(gameId, 0);
        assertEq(uint8(owner), uint8(FactionMarch.Faction.Beta));
        assertEq(garrison, 5); // 15 - 10 survivors
    }

    function test_revert_resolveOrder_insufficientUnits() public {
        uint256 gameId = _createGame();
        vm.prank(alice);
        march.join(gameId);
        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock);

        uint256 available = march.currentUnits(gameId, alice);
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.InsufficientUnits.selector, available + 1, available));
        march.resolveOrder(gameId, alice, 0, uint32(available + 1));
    }

    function test_revert_resolveOrder_notJoined() public {
        uint256 gameId = _createGame();
        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock);

        vm.expectRevert(abi.encodeWithSelector(FactionMarch.NotJoined.selector, alice));
        march.resolveOrder(gameId, alice, 0, 1);
    }

    function test_revert_resolveOrder_beforeActive() public {
        uint256 gameId = _createGame();
        vm.prank(alice);
        march.join(gameId);

        vm.expectRevert(abi.encodeWithSelector(FactionMarch.GameNotActive.selector, gameId));
        march.resolveOrder(gameId, alice, 0, 1);
    }

    function test_revert_resolveOrder_afterSettled() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 5);
        (,,, uint64 settleBlock) = march.games(gameId);
        vm.roll(settleBlock);

        vm.expectRevert(abi.encodeWithSelector(FactionMarch.GameNotActive.selector, gameId));
        march.resolveOrder(gameId, alice, 0, 1);
    }

    function test_revert_resolveOrder_invalidZone() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 5);

        vm.expectRevert(abi.encodeWithSelector(FactionMarch.InvalidZone.selector, 12, 12));
        march.resolveOrder(gameId, alice, 12, 1);
    }

    function test_revert_resolveOrder_zeroUnits() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 5);

        vm.expectRevert(FactionMarch.ZeroUnits.selector);
        march.resolveOrder(gameId, alice, 0, 0);
    }

    // --- access control (Phase 7) ---

    function test_revert_resolveOrder_notProofGate() public {
        uint256 gameId = _createGame();
        _joinAndActivate(gameId, alice, 5);

        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(abi.encodeWithSelector(FactionMarch.NotProofGate.selector, makeAddr("randomCaller")));
        march.resolveOrder(gameId, alice, 0, 1);
    }

    function test_revert_setProofGate_onlyOnce() public {
        // setUp already called setProofGate(address(this)) once.
        vm.expectRevert(FactionMarch.ProofGateAlreadySet.selector);
        march.setProofGate(makeAddr("newProofGate"));
    }

    function test_revert_setProofGate_onlyDeployer() public {
        FactionMarch fresh = new FactionMarch();
        vm.prank(makeAddr("notTheDeployer"));
        vm.expectRevert(FactionMarch.OnlyDeployer.selector);
        fresh.setProofGate(makeAddr("someProofGate"));
    }

    function test_revert_setProofGate_zeroAddress() public {
        FactionMarch fresh = new FactionMarch();
        vm.expectRevert(FactionMarch.ZeroAddress.selector);
        fresh.setProofGate(address(0));
    }

    function test_resolveOrder_unusableUntilWired() public {
        FactionMarch fresh = new FactionMarch();
        uint256 gameId = fresh.createGame(12, 1, 1000);
        vm.prank(alice);
        fresh.join(gameId);
        vm.roll(block.number + 10);

        vm.expectRevert(abi.encodeWithSelector(FactionMarch.NotProofGate.selector, address(this)));
        fresh.resolveOrder(gameId, alice, 0, 1);
    }

    // --- full game, direct calls, no proofs ---

    function test_fullGame_endToEndDirectCalls() public {
        uint256 gameId = march.createGame(3, 5, 1000);

        vm.prank(alice);
        march.join(gameId); // Alpha
        vm.prank(bob);
        march.join(gameId); // Beta
        vm.prank(carol);
        march.join(gameId); // Gamma

        (,, uint64 activeStartBlock,) = march.games(gameId);
        vm.roll(activeStartBlock + 50); // everyone has 50 units available

        // Alpha and Beta both grab a zone each; Gamma reinforces nothing yet.
        march.resolveOrder(gameId, alice, 0, 20);
        march.resolveOrder(gameId, bob, 1, 15);

        // Gamma attacks Alpha's zone 0 and wins.
        march.resolveOrder(gameId, carol, 0, 25);
        (FactionMarch.Faction owner0, uint256 garrison0) = march.zones(gameId, 0);
        assertEq(uint8(owner0), uint8(FactionMarch.Faction.Gamma));
        assertEq(garrison0, 5);

        // Alpha reinforces zone... wait, Alpha no longer owns zone 0 — attack it back instead.
        march.resolveOrder(gameId, alice, 0, 10); // Alpha attacks Gamma's garrison of 5
        (FactionMarch.Faction owner0After, uint256 garrison0After) = march.zones(gameId, 0);
        assertEq(uint8(owner0After), uint8(FactionMarch.Faction.Alpha));
        assertEq(garrison0After, 5);

        // Beta reinforces its own zone 1.
        march.resolveOrder(gameId, bob, 1, 5);
        (FactionMarch.Faction owner1, uint256 garrison1) = march.zones(gameId, 1);
        assertEq(uint8(owner1), uint8(FactionMarch.Faction.Beta));
        assertEq(garrison1, 20);

        // Zone 2 stays unclaimed — never touched.
        (FactionMarch.Faction owner2,) = march.zones(gameId, 2);
        assertEq(uint8(owner2), uint8(FactionMarch.Faction.None));

        // Game settles on schedule with no operator, no cron.
        (,,, uint64 settleBlock) = march.games(gameId);
        vm.roll(settleBlock);
        assertEq(uint8(march.currentState(gameId)), uint8(FactionMarch.GameState.SETTLED));
    }
}
