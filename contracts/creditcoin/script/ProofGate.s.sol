// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProofGate} from "../src/ProofGate.sol";
import {FactionMarch} from "../src/FactionMarch.sol";

/// @dev Run with: forge script script/ProofGate.s.sol --rpc-url creditcoin-cc3 --broadcast
/// Required env: ORDER_BOOK_ADDRESS, FACTION_MARCH_ADDRESS. Optional: SOURCE_CHAIN_KEY
/// (default 1, Sepolia), STALENESS_WINDOW_BLOCKS (default 1200, ~4 hours of Sepolia blocks).
///
/// Deploys ProofGate, then immediately calls FactionMarch.setProofGate(<new address>) to
/// finish the one-shot wiring — must run as the same wallet that deployed FactionMarch.
contract ProofGateScript is Script {
    function run() public returns (ProofGate gate) {
        address orderBook = vm.envAddress("ORDER_BOOK_ADDRESS");
        address factionMarchAddress = vm.envAddress("FACTION_MARCH_ADDRESS");
        uint64 sourceChainKey = uint64(vm.envOr("SOURCE_CHAIN_KEY", uint256(1)));
        uint64 stalenessWindowBlocks = uint64(vm.envOr("STALENESS_WINDOW_BLOCKS", uint256(1200)));

        vm.startBroadcast();
        gate = new ProofGate(orderBook, factionMarchAddress, sourceChainKey, stalenessWindowBlocks);
        FactionMarch(factionMarchAddress).setProofGate(address(gate));
        vm.stopBroadcast();

        console.log("ProofGate deployed at:", address(gate));
        console.log("orderBook:", orderBook);
        console.log("factionMarch:", factionMarchAddress);
        console.log("sourceChainKey:", sourceChainKey);
        console.log("stalenessWindowBlocks:", stalenessWindowBlocks);
        console.log("FactionMarch.setProofGate: done");
    }
}
