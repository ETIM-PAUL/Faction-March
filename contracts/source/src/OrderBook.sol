// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrderBook
/// @notice The order-issuing surface on Ethereum Sepolia for Faction March. Two-phase
/// commit/reveal, not a single placeOrder: `commitOrder` locks in a zone and pays the fee
/// without exposing how many units are being sent, `revealOrder` exposes the real unit count
/// later, whenever the commander chooses. `OrderRevealed` is the event couriers actually
/// prove to Creditcoin (same shape ProofGate already decoded from the old single-phase
/// OrderPlaced) — this contract still decides nothing about game state.
/// @dev Why two phases instead of hiding units end-to-end: FactionMarch resolves combat live,
/// during ACTIVE, the moment a proof lands — that's the entire mechanic ("arrival order is
/// authority", zones flip in real time, couriers race each other). Hiding units until the
/// *game* ends would require batching every order's resolution into one pass at SETTLED,
/// which is a different game. Hiding them until *reveal* instead keeps every existing
/// resolution mechanic intact, while still denying an opponent the one piece of information
/// that would let them out-reinforce an incoming attack before it lands: how many units it
/// actually is. The commander controls the reveal, so they choose how long to sit on it
/// (bounded in practice by ProofGate's staleness window on the reveal transaction) — proving
/// stays fully permissionless once revealed, same as before.
contract OrderBook {
    struct Commitment {
        bytes32 commitHash;
        uint256 gameId;
        uint16 zoneId;
        bool revealed;
    }

    event OrderCommitted(
        address indexed commander, uint256 indexed gameId, uint16 indexed zoneId, bytes32 commitHash, uint64 nonce
    );
    event OrderRevealed(
        address indexed commander, uint256 indexed gameId, uint16 indexed zoneId, uint32 units, uint64 nonce
    );
    event Withdrawn(uint256 amount);

    error IncorrectFee(uint256 sent, uint256 required);
    error ZeroUnits();
    error ZeroTreasury();
    error WithdrawFailed();
    error UnknownCommitment(address commander, uint64 nonce);
    error AlreadyRevealed(address commander, uint64 nonce);
    error CommitmentMismatch(bytes32 expected, bytes32 provided);

    /// @notice Exact ETH amount required to commit an order. Free orders mean spam. Paid in
    /// full at commit time; reveal is free (just gas).
    uint256 public immutable orderFee;

    /// @notice Fixed at deploy time. Nobody can redirect fees after that.
    address public immutable treasury;

    /// @notice Per-commander monotonic counter, shared by commit and reveal (the nonce a
    /// commitment is created under is the same one its reveal must reference).
    mapping(address => uint64) public nonces;

    mapping(address => mapping(uint64 => Commitment)) public commitments;

    constructor(uint256 _orderFee, address _treasury) {
        if (_treasury == address(0)) revert ZeroTreasury();
        orderFee = _orderFee;
        treasury = _treasury;
    }

    /// @notice Locks in a zone and pays the fee without exposing the unit count. commitHash
    /// must be keccak256(abi.encode(units, salt)) for whatever (units, salt) will later be
    /// passed to revealOrder — pick a random salt and keep both secret until you're ready to
    /// reveal, or anyone watching this transaction's calldata learns nothing, but anyone you
    /// later reveal to (including, unavoidably, the public once revealOrder is called) does.
    function commitOrder(uint256 gameId, uint16 zoneId, bytes32 commitHash) external payable returns (uint64 nonce) {
        if (msg.value != orderFee) revert IncorrectFee(msg.value, orderFee);

        nonce = nonces[msg.sender]++;
        commitments[msg.sender][nonce] = Commitment({commitHash: commitHash, gameId: gameId, zoneId: zoneId, revealed: false});

        emit OrderCommitted(msg.sender, gameId, zoneId, commitHash, nonce);
    }

    /// @notice Exposes the real unit count for a prior commitment. Only the original
    /// committer can reveal their own nonce (commitments are keyed per-address, not
    /// globally), and only once — the (units, salt) pair must hash to exactly what was
    /// committed, or this reverts without touching state.
    function revealOrder(uint64 nonce, uint32 units, bytes32 salt) external {
        Commitment storage c = commitments[msg.sender][nonce];
        if (c.commitHash == bytes32(0)) revert UnknownCommitment(msg.sender, nonce);
        if (c.revealed) revert AlreadyRevealed(msg.sender, nonce);
        if (units == 0) revert ZeroUnits();

        bytes32 expected = keccak256(abi.encode(units, salt));
        if (expected != c.commitHash) revert CommitmentMismatch(c.commitHash, expected);

        c.revealed = true;
        emit OrderRevealed(msg.sender, c.gameId, c.zoneId, units, nonce);
    }

    /// @notice Sweeps accumulated fees to the immutable treasury. Callable by
    /// anyone — there is no privileged account in this contract.
    function withdraw() external {
        uint256 balance = address(this).balance;
        (bool ok,) = treasury.call{value: balance}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(balance);
    }
}
