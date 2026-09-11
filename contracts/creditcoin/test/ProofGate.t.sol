// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProofGate} from "../src/ProofGate.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev The block-prover precompile at 0xFD2 doesn't exist in a plain forge EVM, so these
/// tests mock it with vm.mockCall and focus on what Phase 4 actually adds: decoding an
/// OrderPlaced-shaped log out of the proven txBytes. The real precompile's own behaviour
/// (does it actually verify inclusion?) was confirmed against live Sepolia/CC3 in Phase 1
/// (see spikes/FINDINGS.md) — that's not re-tested here.
contract ProofGateTest is Test {
    address constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;

    bytes4 constant VERIFY_SELECTOR =
        bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
    bytes4 constant TX_INDEX_SELECTOR = bytes4(keccak256("calculateTxIndex((bytes32,(bytes32,bool)[]))"));
    bytes32 constant ORDER_PLACED_SIGNATURE = keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)");

    ProofGate gate;
    uint8 action;

    function setUp() public {
        gate = new ProofGate();
        action = gate.ACTION_RELAY_ORDER();
        vm.mockCall(PRECOMPILE, abi.encodeWithSelector(VERIFY_SELECTOR), abi.encode(true));
        vm.mockCall(PRECOMPILE, abi.encodeWithSelector(TX_INDEX_SELECTOR), abi.encode(uint64(0)));
    }

    function _encodeOrderPlacedTx(
        address emitter,
        address commander,
        uint256 gameId,
        uint16 zoneId,
        uint32 units,
        uint64 nonce,
        uint8 receiptStatus
    ) internal pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = ORDER_PLACED_SIGNATURE;
        topics[1] = bytes32(uint256(uint160(commander)));
        topics[2] = bytes32(gameId);
        topics[3] = bytes32(uint256(zoneId));

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(units, nonce)});

        bytes memory receiptChunk = abi.encode(receiptStatus, uint64(21000), logs, bytes(""));

        bytes[] memory chunks = new bytes[](3);
        chunks[0] = bytes("");
        chunks[1] = bytes("");
        chunks[2] = receiptChunk;

        return abi.encode(uint8(0), chunks);
    }

    function _emptyProofArgs()
        internal
        pure
        returns (bytes32 merkleRoot, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerEndpointDigest, bytes32[] memory continuityRoots)
    {
        merkleRoot = bytes32(0);
        siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
        lowerEndpointDigest = bytes32(0);
        continuityRoots = new bytes32[](0);
    }

    function test_relaysDecodedOrder() public {
        address commander = makeAddr("commander");
        address anyEmitter = makeAddr("anyEmitter");

        bytes memory encodedTx = _encodeOrderPlacedTx(anyEmitter, commander, 7, 42, 100, 3, 1);
        (bytes32 root, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerDigest, bytes32[] memory roots) =
            _emptyProofArgs();

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, 7, 42, 100, 3);

        gate.execute(action, 1, 12345, encodedTx, root, siblings, lowerDigest, roots);
    }

    function test_trap_acceptsAnyEmitter() public {
        // Documents Phase 4's deliberate gap: a log from a contract that is NOT the real
        // OrderBook still gets relayed as if it were a genuine order. Phase 5 must make
        // this test's premise false (add an emitter allowlist and re-assert it reverts).
        address commander = makeAddr("commander");
        address attackerContract = makeAddr("attackerContract");

        bytes memory encodedTx = _encodeOrderPlacedTx(attackerContract, commander, 1, 1, 999, 0, 1);
        (bytes32 root, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerDigest, bytes32[] memory roots) =
            _emptyProofArgs();

        vm.expectEmit(true, true, true, true, address(gate));
        emit ProofGate.OrderArrived(commander, 1, 1, 999, 0);

        gate.execute(action, 1, 12345, encodedTx, root, siblings, lowerDigest, roots);
    }

    function test_revert_noOrderPlacedLog() public {
        address commander = makeAddr("commander");
        bytes memory encodedTx = _encodeOrderPlacedTx(commander, commander, 1, 1, 1, 0, 1);

        // Corrupt topic0 so it no longer matches ORDER_PLACED_SIGNATURE.
        (, bytes[] memory chunks) = abi.decode(encodedTx, (uint8, bytes[]));
        (uint8 status, uint64 gasUsed, EvmV1Decoder.LogEntryTuple[] memory logs, bytes memory bloom) =
            abi.decode(chunks[2], (uint8, uint64, EvmV1Decoder.LogEntryTuple[], bytes));
        logs[0].topics[0] = keccak256("SomethingElse(address)");
        chunks[2] = abi.encode(status, gasUsed, logs, bloom);
        bytes memory tampered = abi.encode(uint8(0), chunks);

        (bytes32 root, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerDigest, bytes32[] memory roots) =
            _emptyProofArgs();

        vm.expectRevert(ProofGate.NoOrderPlacedLog.selector);
        gate.execute(action, 1, 12345, tampered, root, siblings, lowerDigest, roots);
    }

    function test_revert_sourceTxFailed() public {
        address commander = makeAddr("commander");
        bytes memory encodedTx = _encodeOrderPlacedTx(commander, commander, 1, 1, 1, 0, /* receiptStatus */ 0);

        (bytes32 root, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerDigest, bytes32[] memory roots) =
            _emptyProofArgs();

        vm.expectRevert(ProofGate.TransactionDidNotSucceed.selector);
        gate.execute(action, 1, 12345, encodedTx, root, siblings, lowerDigest, roots);
    }

    function test_revert_duplicateProofReplay() public {
        address commander = makeAddr("commander");
        bytes memory encodedTx = _encodeOrderPlacedTx(commander, commander, 1, 1, 1, 0, 1);
        (bytes32 root, INativeQueryVerifier.MerkleProofEntry[] memory siblings, bytes32 lowerDigest, bytes32[] memory roots) =
            _emptyProofArgs();

        gate.execute(action, 1, 12345, encodedTx, root, siblings, lowerDigest, roots);

        vm.expectRevert("Query already processed");
        gate.execute(action, 1, 12345, encodedTx, root, siblings, lowerDigest, roots);
    }
}
