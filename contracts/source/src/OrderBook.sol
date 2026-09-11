// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrderBook
/// @notice The order-issuing surface on Ethereum Sepolia for Faction March. Emits
/// OrderPlaced events that couriers prove to Creditcoin; this contract decides
/// nothing about game state. No admin key: fees flow to an immutable treasury
/// via a permissionless sweep.
contract OrderBook {
    event OrderPlaced(
        address indexed commander,
        uint256 indexed gameId,
        uint16 indexed zoneId,
        uint32 units,
        uint64 nonce
    );

    event Withdrawn(uint256 amount);

    error IncorrectFee(uint256 sent, uint256 required);
    error ZeroUnits();
    error ZeroTreasury();
    error WithdrawFailed();

    /// @notice Exact ETH amount required to place an order. Free orders mean spam.
    uint256 public immutable orderFee;

    /// @notice Fixed at deploy time. Nobody can redirect fees after that.
    address public immutable treasury;

    /// @notice Per-commander monotonic counter. This is the first replay defence;
    /// the second lives in ProofGate on Creditcoin (Phase 5).
    mapping(address => uint64) public nonces;

    constructor(uint256 _orderFee, address _treasury) {
        if (_treasury == address(0)) revert ZeroTreasury();
        orderFee = _orderFee;
        treasury = _treasury;
    }

    function placeOrder(uint256 gameId, uint16 zoneId, uint32 units) external payable {
        if (msg.value != orderFee) revert IncorrectFee(msg.value, orderFee);
        if (units == 0) revert ZeroUnits();

        uint64 nonce = nonces[msg.sender]++;

        emit OrderPlaced(msg.sender, gameId, zoneId, units, nonce);
    }

    /// @notice Sweeps accumulated fees to the immutable treasury. Callable by
    /// anyone — there is no privileged account in this contract.
    function withdraw() external {
        uint256 balance = address(this).balance;
        (bool ok, ) = treasury.call{value: balance}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(balance);
    }
}
