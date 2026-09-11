// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Hello} from "../src/Hello.sol";

/// @dev Run with: forge script script/Hello.s.sol --rpc-url creditcoin-cc3 --broadcast
contract HelloScript is Script {
    function run() public {
        vm.startBroadcast();
        new Hello();
        vm.stopBroadcast();
    }
}
