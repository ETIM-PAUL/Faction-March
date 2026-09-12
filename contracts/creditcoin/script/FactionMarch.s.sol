// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactionMarch} from "../src/FactionMarch.sol";

/// @dev Run with: forge script script/FactionMarch.s.sol --rpc-url creditcoin-cc3 --broadcast
contract FactionMarchScript is Script {
    function run() public returns (FactionMarch march) {
        vm.startBroadcast();
        march = new FactionMarch();
        vm.stopBroadcast();

        console.log("FactionMarch deployed at:", address(march));
    }
}
