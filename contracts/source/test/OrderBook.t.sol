// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../src/OrderBook.sol";

contract OrderBookTest is Test {
    uint256 constant FEE = 0.0005 ether;

    OrderBook book;
    address treasury;
    address commander;

    function setUp() public {
        treasury = makeAddr("treasury");
        commander = makeAddr("commander");
        book = new OrderBook(FEE, treasury);
        vm.deal(commander, 10 ether);
    }

    function _hash(uint32 units, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(units, salt));
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(OrderBook.ZeroTreasury.selector);
        new OrderBook(FEE, address(0));
    }

    // --- commit ---

    function test_commitOrder_emitsWithNonceZero() public {
        bytes32 hash = _hash(100, bytes32(uint256(1)));
        vm.expectEmit(true, true, true, true, address(book));
        emit OrderBook.OrderCommitted(commander, 1, 5, hash, 0);

        vm.prank(commander);
        book.commitOrder{value: FEE}(1, 5, hash);
    }

    function test_nonce_monotonic_perCommander() public {
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(1))));
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(2))));
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(3))));
        vm.stopPrank();

        assertEq(book.nonces(commander), 3);
    }

    function test_nonce_independent_perCommander() public {
        address other = makeAddr("other");
        vm.deal(other, 10 ether);

        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(1))));
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(2))));
        vm.stopPrank();

        vm.prank(other);
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(3))));

        assertEq(book.nonces(commander), 2);
        assertEq(book.nonces(other), 1);
    }

    function test_revert_commit_underpay() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, FEE - 1, FEE));
        book.commitOrder{value: FEE - 1}(1, 1, _hash(10, bytes32(uint256(1))));
    }

    function test_revert_commit_overpay() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, FEE + 1, FEE));
        book.commitOrder{value: FEE + 1}(1, 1, _hash(10, bytes32(uint256(1))));
    }

    function test_revert_commit_freeOrder() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, 0, FEE));
        book.commitOrder(1, 1, _hash(10, bytes32(uint256(1))));
    }

    function test_underpay_doesNotConsumeNonce() public {
        vm.startPrank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, 0, FEE));
        book.commitOrder(1, 1, _hash(10, bytes32(uint256(1))));
        vm.stopPrank();

        assertEq(book.nonces(commander), 0);
    }

    // --- reveal ---

    function test_revealOrder_emitsRealUnits() public {
        bytes32 salt = bytes32(uint256(42));
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(7, salt));

        vm.expectEmit(true, true, true, true, address(book));
        emit OrderBook.OrderRevealed(commander, 1, 5, 7, 0);
        book.revealOrder(0, 7, salt);
        vm.stopPrank();
    }

    function test_revealOrder_canHappenManyBlocksLater() public {
        bytes32 salt = bytes32(uint256(1));
        vm.prank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(7, salt));

        vm.roll(block.number + 5000);
        vm.warp(block.timestamp + 5000 * 12);

        vm.prank(commander);
        vm.expectEmit(true, true, true, true, address(book));
        emit OrderBook.OrderRevealed(commander, 1, 5, 7, 0);
        book.revealOrder(0, 7, salt);
    }

    function test_revert_reveal_wrongUnits() public {
        bytes32 salt = bytes32(uint256(1));
        vm.startPrank(commander);
        bytes32 hash = _hash(7, salt);
        book.commitOrder{value: FEE}(1, 5, hash);

        vm.expectRevert(abi.encodeWithSelector(OrderBook.CommitmentMismatch.selector, hash, _hash(8, salt)));
        book.revealOrder(0, 8, salt); // wrong units for this commitment
        vm.stopPrank();
    }

    function test_revert_reveal_wrongSalt() public {
        bytes32 salt = bytes32(uint256(1));
        bytes32 wrongSalt = bytes32(uint256(2));
        vm.startPrank(commander);
        bytes32 hash = _hash(7, salt);
        book.commitOrder{value: FEE}(1, 5, hash);

        vm.expectRevert(abi.encodeWithSelector(OrderBook.CommitmentMismatch.selector, hash, _hash(7, wrongSalt)));
        book.revealOrder(0, 7, wrongSalt);
        vm.stopPrank();
    }

    function test_revert_reveal_unknownNonce() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.UnknownCommitment.selector, commander, 0));
        book.revealOrder(0, 7, bytes32(uint256(1)));
    }

    function test_revert_reveal_zeroUnits() public {
        bytes32 salt = bytes32(uint256(1));
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(0, salt));

        vm.expectRevert(OrderBook.ZeroUnits.selector);
        book.revealOrder(0, 0, salt);
        vm.stopPrank();
    }

    function test_revert_reveal_twice() public {
        bytes32 salt = bytes32(uint256(1));
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(7, salt));
        book.revealOrder(0, 7, salt);

        vm.expectRevert(abi.encodeWithSelector(OrderBook.AlreadyRevealed.selector, commander, 0));
        book.revealOrder(0, 7, salt);
        vm.stopPrank();
    }

    function test_revert_reveal_byNonCommitter() public {
        bytes32 salt = bytes32(uint256(1));
        vm.prank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(7, salt));

        // Someone else's nonce-0 commitment doesn't exist -- each commander has their own
        // nonce space, so this looks up an entirely different (empty) commitment.
        address impostor = makeAddr("impostor");
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.UnknownCommitment.selector, impostor, 0));
        book.revealOrder(0, 7, salt);
    }

    function test_reveal_doesNotConsumeANewNonce() public {
        bytes32 salt = bytes32(uint256(1));
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 5, _hash(7, salt));
        assertEq(book.nonces(commander), 1);
        book.revealOrder(0, 7, salt);
        assertEq(book.nonces(commander), 1, "reveal reuses the commit's nonce, doesn't mint a new one");
        vm.stopPrank();
    }

    // --- withdraw ---

    function test_withdraw_sweepsFullBalanceToTreasury() public {
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(1))));
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(2))));
        vm.stopPrank();

        uint256 before = treasury.balance;
        book.withdraw();

        assertEq(treasury.balance, before + 2 * FEE);
        assertEq(address(book).balance, 0);
    }

    function test_withdraw_callableByAnyone() public {
        vm.prank(commander);
        book.commitOrder{value: FEE}(1, 1, _hash(10, bytes32(uint256(1))));

        address rando = makeAddr("rando");
        vm.prank(rando);
        book.withdraw();

        assertEq(treasury.balance, FEE);
    }

    function testFuzz_nonceIncrementsMatchCommitCount(uint8 n) public {
        vm.assume(n > 0 && n < 50);
        vm.startPrank(commander);
        for (uint256 i = 0; i < n; i++) {
            book.commitOrder{value: FEE}(1, 1, _hash(1, bytes32(i)));
        }
        vm.stopPrank();

        assertEq(book.nonces(commander), n);
    }

    function testFuzz_wrongFeeAlwaysReverts(uint256 sent) public {
        vm.assume(sent != FEE);
        vm.deal(commander, sent);
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, sent, FEE));
        book.commitOrder{value: sent}(1, 1, _hash(10, bytes32(uint256(1))));
    }

    function testFuzz_revealMatchesExactCommitment(uint32 units, bytes32 salt) public {
        vm.assume(units > 0);
        vm.startPrank(commander);
        book.commitOrder{value: FEE}(1, 1, _hash(units, salt));
        book.revealOrder(0, units, salt);
        vm.stopPrank();
    }
}
