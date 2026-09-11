// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProofGate} from "../src/ProofGate.sol";

/// @dev Run with: forge script script/ProofGate.s.sol --rpc-url creditcoin-cc3 --broadcast
/// Required env: ORDER_BOOK_ADDRESS. Optional: SOURCE_CHAIN_KEY (default 1, Sepolia),
/// STALENESS_WINDOW_BLOCKS (default 1200, roughly 4 hours of Sepolia blocks).
contract ProofGateScript is Script {
    function run() public returns (ProofGate gate) {
        address orderBook = vm.envAddress("ORDER_BOOK_ADDRESS");
        uint64 sourceChainKey = uint64(vm.envOr("SOURCE_CHAIN_KEY", uint256(1)));
        uint64 stalenessWindowBlocks = uint64(vm.envOr("STALENESS_WINDOW_BLOCKS", uint256(1200)));

        vm.startBroadcast();
        gate = new ProofGate(orderBook, sourceChainKey, stalenessWindowBlocks);
        vm.stopBroadcast();

        console.log("ProofGate deployed at:", address(gate));
        console.log("orderBook:", orderBook);
        console.log("sourceChainKey:", sourceChainKey);
        console.log("stalenessWindowBlocks:", stalenessWindowBlocks);
    }
}
