// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ASCBase} from "@gluwa/asc-contracts/contracts/readability/ASCBase.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @title ProofGate
/// @notice Phase 4 thin vertical slice: verify a proof against the native block-prover
/// precompile (via ASCBase), decode an OrderPlaced-shaped log from it, and emit
/// OrderArrived with the decoded fields.
/// @dev DELIBERATELY UNGUARDED. It does not check which contract emitted the log, does
/// not check topic count, does not bind to a game. Any transaction on the configured
/// source chain containing a log whose topic0 matches ORDER_PLACED_SIGNATURE will be
/// accepted and relayed — including one forged by an attacker's own contract. Phase 5
/// adds the emitter allowlist, topic-count check, gameId binding, and staleness window.
/// Do not build game logic on top of this contract until Phase 5 lands.
contract ProofGate is ASCBase {
    /// @dev keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)")
    bytes32 public constant ORDER_PLACED_SIGNATURE =
        keccak256("OrderPlaced(address,uint256,uint16,uint32,uint64)");

    uint8 public constant ACTION_RELAY_ORDER = 0;

    event OrderArrived(
        address indexed commander,
        uint256 indexed gameId,
        uint16 indexed zoneId,
        uint32 units,
        uint64 nonce
    );

    error NoOrderPlacedLog();
    error TransactionDidNotSucceed();

    function _processAndEmitEvent(
        uint8, /* action — single action in Phase 4, kept for ASCBase's shape */
        bytes32, /* queryId — dedup already enforced by ASCBase.execute */
        bytes memory encodedTransaction
    ) internal override {
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionDidNotSucceed();

        EvmV1Decoder.LogEntry[] memory orderLogs =
            EvmV1Decoder.getLogsByEventSignature(receipt, ORDER_PLACED_SIGNATURE);
        if (orderLogs.length == 0) revert NoOrderPlacedLog();

        // Phase 5 trap: no check that topics.length == 4, no emitter allowlist. First
        // match wins, from whatever contract emitted it.
        EvmV1Decoder.LogEntry memory log = orderLogs[0];

        address commander = address(uint160(uint256(log.topics[1])));
        uint256 gameId = uint256(log.topics[2]);
        uint16 zoneId = uint16(uint256(log.topics[3]));
        (uint32 units, uint64 nonce) = abi.decode(log.data, (uint32, uint64));

        emit OrderArrived(commander, gameId, zoneId, units, nonce);
    }
}
