// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarChest} from "../src/WarChest.sol";
import {FactionMarch} from "../src/FactionMarch.sol";

/// @dev FactionMarch has no precompile dependency, so both it and WarChest run for real here
/// (no mocking needed) — this suite exercises the actual credit mechanic end to end. The
/// test contract stands in as "ProofGate" for both (mirrors FactionMarch.t.sol's own
/// pattern) so zone captures and reputation recording can be driven directly.
contract WarChestTest is Test {
    FactionMarch march;
    WarChest chest;

    uint256 constant GAME_ID = 1;
    uint64 constant REPAYMENT_WINDOW = 100;

    address alice = makeAddr("alice"); // will be Alpha
    address bob = makeAddr("bob"); // will be Beta

    function setUp() public {
        march = new FactionMarch();
        chest = new WarChest(address(march), REPAYMENT_WINDOW);
        march.setProofGate(address(this));
        chest.setProofGate(address(this));

        march.createGame(12, 1, 20_000);
        vm.prank(alice);
        march.join(GAME_ID); // Alpha
        vm.prank(bob);
        march.join(GAME_ID); // Beta
        vm.roll(block.number + 200); // plenty of units for both
    }

    function _capture(address commander, uint16 zoneId, uint32 units) internal {
        march.resolveOrder(GAME_ID, commander, zoneId, units);
    }

    // --- territory / discount ---

    function test_territoryHeld_countsRealZonesFromFactionMarch() public {
        _capture(alice, 0, 5);
        _capture(alice, 1, 5);
        _capture(bob, 2, 5);

        assertEq(chest.territoryHeld(GAME_ID, FactionMarch.Faction.Alpha), 2);
        assertEq(chest.territoryHeld(GAME_ID, FactionMarch.Faction.Beta), 1);
        assertEq(chest.territoryHeld(GAME_ID, FactionMarch.Faction.Gamma), 0);
    }

    function test_discountBps_tiersByZoneCount() public {
        assertEq(chest.discountBps(GAME_ID, FactionMarch.Faction.Alpha), 0);

        for (uint16 z = 0; z < 3; z++) {
            _capture(alice, z, 5);
        }
        assertEq(chest.discountBps(GAME_ID, FactionMarch.Faction.Alpha), chest.TIER_1_DISCOUNT_BPS());

        for (uint16 z = 3; z < 6; z++) {
            _capture(alice, z, 5);
        }
        assertEq(chest.discountBps(GAME_ID, FactionMarch.Faction.Alpha), chest.TIER_2_DISCOUNT_BPS());

        for (uint16 z = 6; z < 9; z++) {
            _capture(alice, z, 5);
        }
        assertEq(chest.discountBps(GAME_ID, FactionMarch.Faction.Alpha), chest.TIER_3_DISCOUNT_BPS());
    }

    // --- chest funding ---

    function test_depositToChest_increasesBalance() public {
        chest.depositToChest{value: 1 ether}(GAME_ID);
        assertEq(chest.chestBalance(GAME_ID), 1 ether);
    }

    // --- credit limit ---

    function test_creditLimit_zeroWithNoTerritory() public view {
        assertEq(chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha), 0);
    }

    function test_creditLimit_scalesWithTerritory() public {
        _capture(alice, 0, 5);
        _capture(alice, 1, 5);
        assertEq(chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha), 2 * chest.BASE_CREDIT_PER_ZONE());
    }

    // --- borrow ---

    function test_revert_borrow_notFactionMember() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WarChest.NotFactionMember.selector, bob, FactionMarch.Faction.Alpha));
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 1);
    }

    function test_revert_borrow_exceedsAvailableCredit() public {
        _capture(alice, 0, 5); // 1 zone -> limit = BASE_CREDIT_PER_ZONE
        chest.depositToChest{value: 10 ether}(GAME_ID);

        uint256 limit = chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WarChest.ExceedsAvailableCredit.selector, limit + 1, limit));
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, limit + 1);
    }

    function test_revert_borrow_exceedsPerDrawCap() public {
        // Enough territory that the credit limit alone wouldn't block the draw, but a chest
        // small enough that the 20%-of-balance cap is the binding constraint instead.
        for (uint16 z = 0; z < 9; z++) {
            _capture(alice, z, 5);
        }
        chest.depositToChest{value: 0.01 ether}(GAME_ID);

        uint256 cap = (chest.chestBalance(GAME_ID) * chest.MAX_DRAW_BPS_OF_CHEST()) / 10_000;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WarChest.ExceedsPerDrawCap.selector, cap + 1, cap));
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, cap + 1);
    }

    function test_borrow_transfersCtcAndSetsDueBlock() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);

        uint256 before = alice.balance;
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.0005 ether);

        assertEq(alice.balance, before + 0.0005 ether);
        (uint256 borrowed,,, uint64 dueBlock) = chest.factionCredit(GAME_ID, uint8(FactionMarch.Faction.Alpha));
        assertEq(borrowed, 0.0005 ether);
        assertEq(dueBlock, block.number + REPAYMENT_WINDOW);
        assertEq(chest.chestBalance(GAME_ID), 10 ether - 0.0005 ether);
    }

    // --- repay ---

    function test_repay_reducesDebtAndRefillsChest() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.0005 ether);

        vm.prank(alice);
        chest.repay{value: 0.0002 ether}(GAME_ID, FactionMarch.Faction.Alpha);

        (uint256 borrowed,,,) = chest.factionCredit(GAME_ID, uint8(FactionMarch.Faction.Alpha));
        assertEq(borrowed, 0.0003 ether);
        assertEq(chest.chestBalance(GAME_ID), 10 ether - 0.0005 ether + 0.0002 ether);
        (,,, uint256 debtsRepaid) = chest.reputations(alice);
        assertEq(debtsRepaid, 1);
    }

    function test_repay_refundsOverpayment() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.0005 ether);

        vm.deal(alice, 1 ether); // top up so she can actually send more than she owes
        uint256 before = alice.balance;
        vm.prank(alice);
        chest.repay{value: 0.001 ether}(GAME_ID, FactionMarch.Faction.Alpha); // double what's owed

        assertEq(alice.balance, before - 0.0005 ether, "only the outstanding amount was actually spent");
        (uint256 borrowed,,,) = chest.factionCredit(GAME_ID, uint8(FactionMarch.Faction.Alpha));
        assertEq(borrowed, 0);
    }

    // --- default ---

    function test_isInDefault_trueOncePastDueBlock() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.0005 ether);

        assertFalse(chest.isInDefault(GAME_ID, FactionMarch.Faction.Alpha));
        vm.roll(block.number + REPAYMENT_WINDOW + 1);
        assertTrue(chest.isInDefault(GAME_ID, FactionMarch.Faction.Alpha));
        assertEq(chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha), 0, "line closed while in default");
    }

    /// @notice The full story the build plan asks for: a credit line, an offensive, a loss
    /// of territory, a default, and the limit correctly shrinking — including a permanent
    /// scar that survives clearing the default.
    function test_fullLifecycle_creditLine_offensive_territoryLoss_default_limitShrinks() public {
        // Alpha takes 6 zones -> tier 2 territory, meaningful credit limit.
        for (uint16 z = 0; z < 6; z++) {
            _capture(alice, z, 5);
        }
        chest.depositToChest{value: 10 ether}(GAME_ID);

        uint256 limitBeforeLoss = chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha);
        assertEq(limitBeforeLoss, 6 * chest.BASE_CREDIT_PER_ZONE());

        // Into a credit line: Alpha borrows to fund an offensive beyond the chest's own cap
        // logic notwithstanding — this draw is well within the per-draw cap.
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.002 ether);
        (uint256 borrowed,,,) = chest.factionCredit(GAME_ID, uint8(FactionMarch.Faction.Alpha));
        assertEq(borrowed, 0.002 ether);

        // A loss of territory: Beta captures 3 of Alpha's zones.
        for (uint16 z = 0; z < 3; z++) {
            _capture(bob, z, 10); // 10 > Alpha's garrison of 5 -> Beta captures
        }
        assertEq(chest.territoryHeld(GAME_ID, FactionMarch.Faction.Alpha), 3);

        uint256 limitAfterLoss = chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha);
        assertLt(limitAfterLoss, limitBeforeLoss, "credit limit shrinks when territory is lost");
        assertEq(limitAfterLoss, 3 * chest.BASE_CREDIT_PER_ZONE());

        // A default: the repayment window passes with the debt still outstanding.
        vm.roll(block.number + REPAYMENT_WINDOW + 1);
        assertTrue(chest.isInDefault(GAME_ID, FactionMarch.Faction.Alpha));
        assertEq(chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha), 0, "defaulted line has zero credit");

        // Clearing it: Alpha fully repays, reopening the line but with a permanent penalty.
        vm.prank(alice);
        chest.repay{value: 0.002 ether}(GAME_ID, FactionMarch.Faction.Alpha);
        assertFalse(chest.isInDefault(GAME_ID, FactionMarch.Faction.Alpha));

        (,, uint256 defaultCount,) = chest.factionCredit(GAME_ID, uint8(FactionMarch.Faction.Alpha));
        assertEq(defaultCount, 1);

        uint256 limitAfterClearing = chest.creditLimit(GAME_ID, FactionMarch.Faction.Alpha);
        // Same 3 zones as limitAfterLoss, but now scarred by one default: strictly lower
        // than what an otherwise-identical, never-defaulted faction would have.
        assertLt(
            limitAfterClearing,
            limitAfterLoss,
            "a cleared default still pays a worse tier than a faction that never defaulted, for the same territory"
        );
    }

    // --- reputation ---

    function test_revert_recordOrderResolution_notProofGate() public {
        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(abi.encodeWithSelector(WarChest.NotProofGate.selector, makeAddr("randomCaller")));
        chest.recordOrderResolution(GAME_ID, alice, alice, 0, false);
    }

    function test_reputation_queryableOnChain() public {
        address courier = makeAddr("courier");

        chest.recordOrderResolution(GAME_ID, alice, courier, 0, true);
        chest.recordOrderResolution(GAME_ID, alice, courier, 1, false);
        chest.recordOrderResolution(GAME_ID, alice, courier, 3, true); // gap at nonce 2 (never proven)

        (uint256 issuedLowerBound, uint256 proven, uint256 bountiesClaimedByAlice,) = chest.reputations(alice);
        assertEq(proven, 3, "three proofs landed for alice");
        assertEq(issuedLowerBound, 4, "highest nonce seen (3) + 1 -- a lower bound, not a guarantee nonce 2 was ever proven");
        assertEq(bountiesClaimedByAlice, 0, "alice is the commander here, not the courier");

        (,, uint256 courierBounties,) = chest.reputations(courier);
        assertEq(courierBounties, 2, "courier claimed 2 of the 3 bounties (one dry-pool skip)");
    }

    function test_reputation_debtsRepaidTracksPayerNotFaction() public {
        _capture(alice, 0, 5);
        chest.depositToChest{value: 10 ether}(GAME_ID);
        vm.prank(alice);
        chest.borrow(GAME_ID, FactionMarch.Faction.Alpha, 0.0003 ether);

        address goodSamaritan = makeAddr("goodSamaritan");
        vm.deal(goodSamaritan, 1 ether);
        vm.prank(goodSamaritan);
        chest.repay{value: 0.0003 ether}(GAME_ID, FactionMarch.Faction.Alpha);

        (,,, uint256 samaritanRepaid) = chest.reputations(goodSamaritan);
        assertEq(samaritanRepaid, 1, "permissionless repayment is credited to whoever actually paid");
    }

    // --- access control ---

    function test_revert_setProofGate_onlyOnce() public {
        vm.expectRevert(WarChest.ProofGateAlreadySet.selector);
        chest.setProofGate(makeAddr("newProofGate"));
    }

    function test_revert_setProofGate_onlyDeployer() public {
        WarChest fresh = new WarChest(address(march), REPAYMENT_WINDOW);
        vm.prank(makeAddr("notTheDeployer"));
        vm.expectRevert(WarChest.OnlyDeployer.selector);
        fresh.setProofGate(makeAddr("someProofGate"));
    }
}
