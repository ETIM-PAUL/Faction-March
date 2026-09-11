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

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(OrderBook.ZeroTreasury.selector);
        new OrderBook(FEE, address(0));
    }

    function test_placeOrder_emitsWithNonceZero() public {
        vm.expectEmit(true, true, true, true, address(book));
        emit OrderBook.OrderPlaced(commander, 1, 5, 100, 0);

        vm.prank(commander);
        book.placeOrder{value: FEE}(1, 5, 100);
    }

    function test_nonce_monotonic_perCommander() public {
        vm.startPrank(commander);
        book.placeOrder{value: FEE}(1, 1, 10);
        book.placeOrder{value: FEE}(1, 1, 10);
        book.placeOrder{value: FEE}(1, 1, 10);
        vm.stopPrank();

        assertEq(book.nonces(commander), 3);
    }

    function test_nonce_independent_perCommander() public {
        address other = makeAddr("other");
        vm.deal(other, 10 ether);

        vm.startPrank(commander);
        book.placeOrder{value: FEE}(1, 1, 10);
        book.placeOrder{value: FEE}(1, 1, 10);
        vm.stopPrank();

        vm.prank(other);
        book.placeOrder{value: FEE}(1, 1, 10);

        assertEq(book.nonces(commander), 2);
        assertEq(book.nonces(other), 1);
    }

    function test_placeOrder_nonceInEvent() public {
        vm.startPrank(commander);
        book.placeOrder{value: FEE}(1, 1, 10);

        vm.expectEmit(true, true, true, true, address(book));
        emit OrderBook.OrderPlaced(commander, 1, 1, 10, 1);
        book.placeOrder{value: FEE}(1, 1, 10);
        vm.stopPrank();
    }

    function test_revert_underpay() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, FEE - 1, FEE));
        book.placeOrder{value: FEE - 1}(1, 1, 10);
    }

    function test_revert_overpay() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, FEE + 1, FEE));
        book.placeOrder{value: FEE + 1}(1, 1, 10);
    }

    function test_revert_freeOrder() public {
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, 0, FEE));
        book.placeOrder(1, 1, 10);
    }

    function test_revert_zeroUnits() public {
        vm.prank(commander);
        vm.expectRevert(OrderBook.ZeroUnits.selector);
        book.placeOrder{value: FEE}(1, 1, 0);
    }

    function test_underpay_doesNotConsumeNonce() public {
        vm.startPrank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, 0, FEE));
        book.placeOrder(1, 1, 10);
        vm.stopPrank();

        assertEq(book.nonces(commander), 0);
    }

    function test_withdraw_sweepsFullBalanceToTreasury() public {
        vm.startPrank(commander);
        book.placeOrder{value: FEE}(1, 1, 10);
        book.placeOrder{value: FEE}(1, 1, 10);
        vm.stopPrank();

        uint256 before = treasury.balance;
        book.withdraw();

        assertEq(treasury.balance, before + 2 * FEE);
        assertEq(address(book).balance, 0);
    }

    function test_withdraw_callableByAnyone() public {
        vm.prank(commander);
        book.placeOrder{value: FEE}(1, 1, 10);

        address rando = makeAddr("rando");
        vm.prank(rando);
        book.withdraw();

        assertEq(treasury.balance, FEE);
    }

    function testFuzz_nonceIncrementsMatchOrderCount(uint8 n) public {
        vm.assume(n > 0 && n < 50);
        vm.startPrank(commander);
        for (uint256 i = 0; i < n; i++) {
            book.placeOrder{value: FEE}(1, 1, 1);
        }
        vm.stopPrank();

        assertEq(book.nonces(commander), n);
    }

    function testFuzz_wrongFeeAlwaysReverts(uint256 sent) public {
        vm.assume(sent != FEE);
        vm.deal(commander, sent);
        vm.prank(commander);
        vm.expectRevert(abi.encodeWithSelector(OrderBook.IncorrectFee.selector, sent, FEE));
        book.placeOrder{value: sent}(1, 1, 10);
    }
}
