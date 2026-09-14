// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ProofGate} from "../src/ProofGate.sol";
import {FactionMarch} from "../src/FactionMarch.sol";
import {WarChest} from "../src/WarChest.sol";

/// @dev Run with: forge script script/ProofGate.s.sol --rpc-url creditcoin-cc3 --broadcast
/// Required env: ORDER_BOOK_ADDRESS, FACTION_MARCH_ADDRESS, WAR_CHEST_ADDRESS. Optional:
/// SOURCE_CHAIN_KEY (default 1, Sepolia), STALENESS_WINDOW_BLOCKS (default 1200, ~4 hours of
/// Sepolia blocks), BOUNTY_PER_ORDER_WEI (default 0.0001 ether).
///
/// Deploys ProofGate, then immediately calls FactionMarch.setProofGate and
/// WarChest.setProofGate (both one-shot) — must run as the same wallet that deployed both.
/// If a wiring transaction fails to land (seen before on CC3 with no revert reason surfaced
/// — see spikes/FINDINGS.md), retry it directly:
/// `cast send <contract> "setProofGate(address)" <gate>`.
contract ProofGateScript is Script {
    function run() public returns (ProofGate gate) {
        address orderBook = vm.envAddress("ORDER_BOOK_ADDRESS");
        address factionMarchAddress = vm.envAddress("FACTION_MARCH_ADDRESS");
        address warChestAddress = vm.envAddress("WAR_CHEST_ADDRESS");
        uint64 sourceChainKey = uint64(vm.envOr("SOURCE_CHAIN_KEY", uint256(1)));
        uint64 stalenessWindowBlocks = uint64(vm.envOr("STALENESS_WINDOW_BLOCKS", uint256(1200)));
        uint256 bountyPerOrder = vm.envOr("BOUNTY_PER_ORDER_WEI", uint256(0.0001 ether));
        // Kept smaller than bountyPerOrder so a courier who successfully lands a proof stays
        // net-positive even after paying it — see ProofGate's own NatSpec on CHEST_FEE_PER_ORDER.
        uint256 chestFeePerOrder = vm.envOr("CHEST_FEE_PER_ORDER_WEI", uint256(0.00005 ether));

        vm.startBroadcast();
        gate = new ProofGate(
            orderBook,
            factionMarchAddress,
            warChestAddress,
            sourceChainKey,
            stalenessWindowBlocks,
            bountyPerOrder,
            chestFeePerOrder
        );
        FactionMarch(factionMarchAddress).setProofGate(address(gate));
        WarChest(warChestAddress).setProofGate(address(gate));
        vm.stopBroadcast();

        console.log("ProofGate deployed at:", address(gate));
        console.log("orderBook:", orderBook);
        console.log("factionMarch:", factionMarchAddress);
        console.log("warChest:", warChestAddress);
        console.log("sourceChainKey:", sourceChainKey);
        console.log("stalenessWindowBlocks:", stalenessWindowBlocks);
        console.log("bountyPerOrder (wei):", bountyPerOrder);
        console.log("chestFeePerOrder (wei):", chestFeePerOrder);
        console.log("FactionMarch.setProofGate / WarChest.setProofGate: done");
    }
}
