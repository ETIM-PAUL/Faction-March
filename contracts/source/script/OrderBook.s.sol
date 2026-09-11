// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OrderBook} from "../src/OrderBook.sol";

/// @dev Run with: forge script script/OrderBook.s.sol --rpc-url sepolia --broadcast --verify
/// Required env: TREASURY_ADDRESS. Optional: ORDER_FEE (wei, default 0.0005 ether).
contract OrderBookScript is Script {
    function run() public returns (OrderBook book) {
        uint256 orderFee = vm.envOr("ORDER_FEE", uint256(0.0005 ether));
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        vm.startBroadcast();
        book = new OrderBook(orderFee, treasury);
        vm.stopBroadcast();

        console.log("OrderBook deployed at:", address(book));
        console.log("orderFee (wei):", orderFee);
        console.log("treasury:", treasury);
    }
}
