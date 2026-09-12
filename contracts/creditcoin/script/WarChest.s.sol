// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WarChest} from "../src/WarChest.sol";

/// @dev Run with: forge script script/WarChest.s.sol --rpc-url creditcoin-cc3 --broadcast
/// Required env: FACTION_MARCH_ADDRESS. Optional: REPAYMENT_WINDOW_BLOCKS (default 5000,
/// roughly a couple of hours on CC3).
contract WarChestScript is Script {
    function run() public returns (WarChest chest) {
        address factionMarch = vm.envAddress("FACTION_MARCH_ADDRESS");
        uint64 repaymentWindowBlocks = uint64(vm.envOr("REPAYMENT_WINDOW_BLOCKS", uint256(5000)));

        vm.startBroadcast();
        chest = new WarChest(factionMarch, repaymentWindowBlocks);
        vm.stopBroadcast();

        console.log("WarChest deployed at:", address(chest));
        console.log("factionMarch:", factionMarch);
        console.log("repaymentWindowBlocks:", repaymentWindowBlocks);
    }
}
