// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProofGate} from "../src/ProofGate.sol";

/// @dev Run with: forge script script/ProofGate.s.sol --rpc-url creditcoin-cc3 --broadcast
contract ProofGateScript is Script {
    function run() public returns (ProofGate gate) {
        vm.startBroadcast();
        gate = new ProofGate();
        vm.stopBroadcast();

        console.log("ProofGate deployed at:", address(gate));
    }
}
