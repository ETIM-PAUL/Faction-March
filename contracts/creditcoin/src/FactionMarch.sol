// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FactionMarch
/// @notice The board. Three factions fight over zones with unit pools that replenish over
/// time, inside a block-number-driven OPEN -> ACTIVE -> SETTLED lifecycle.
/// @dev `resolveOrder` is restricted to `proofGate` (Phase 7) — no game state changes
/// without a proof. `proofGate` is set exactly once, by whoever deployed this contract,
/// via `setProofGate`. This breaks an unavoidable circular dependency (ProofGate's
/// constructor needs FactionMarch's address; FactionMarch needs ProofGate's address to
/// gate `resolveOrder`) with a narrow, single-use setup step rather than a standing admin
/// key: `resolveOrder` reverts for everyone until it's called once, and it can never be
/// called again afterwards. It moves no army, captures no zone, and opens no credit line —
/// it only decides which contract is later allowed to do those things.
contract FactionMarch {
    enum Faction {
        None,
        Alpha,
        Beta,
        Gamma
    }

    enum GameState {
        OPEN,
        ACTIVE,
        SETTLED
    }

    struct GameConfig {
        bool exists;
        uint16 zoneCount;
        uint64 activeStartBlock;
        uint64 settleBlock;
    }

    struct Zone {
        Faction owner; // None = never captured
        uint256 garrison;
    }

    struct UnitPool {
        uint256 balance; // balance as of lastUpdateBlock
        uint64 lastUpdateBlock; // 0 == commander has not joined
    }

    uint16 public constant DEFAULT_ZONE_COUNT = 12;
    uint16 public constant MAX_ZONE_COUNT = 100;
    uint256 public constant UNITS_PER_BLOCK = 1;
    uint256 public constant MAX_UNIT_POOL = 500;
    /// @notice Only one game may be OPEN or ACTIVE at a time (see createGame). That makes a
    /// game's duration a shared resource, not just its creator's choice — without a cap,
    /// anyone could permissionlessly lock out every future game for years by picking a huge
    /// activeDurationBlocks. These bound the lockout to a sane maximum.
    uint64 public constant MAX_OPEN_DURATION_BLOCKS = 3600;
    uint64 public constant MAX_ACTIVE_DURATION_BLOCKS = 28_800;

    address public immutable deployer;
    address public proofGate;

    uint256 public gameCount;

    mapping(uint256 => GameConfig) public games;
    mapping(uint256 => mapping(uint16 => Zone)) public zones;
    mapping(uint256 => mapping(address => Faction)) public commanderFaction;
    mapping(uint256 => mapping(uint8 => uint256)) public factionHeadcount;
    mapping(uint256 => mapping(address => UnitPool)) public unitPools;

    event GameCreated(uint256 indexed gameId, uint16 zoneCount, uint64 activeStartBlock, uint64 settleBlock);
    event CommanderJoined(uint256 indexed gameId, address indexed commander, Faction faction);
    event ZoneCaptured(
        uint256 indexed gameId, uint16 indexed zoneId, Faction previousOwner, Faction newOwner, uint256 survivors
    );
    event ZoneAttacked(uint256 indexed gameId, uint16 indexed zoneId, Faction attacker, uint256 units, uint256 garrisonRemaining);
    event ZoneReinforced(uint256 indexed gameId, uint16 indexed zoneId, Faction faction, uint256 garrison);

    error GameDoesNotExist(uint256 gameId);
    error InvalidZoneCount(uint16 zoneCount);
    error InvalidDuration();
    error PreviousGameNotSettled(uint256 gameId, GameState state);
    error GameNotOpen(uint256 gameId);
    error GameNotActive(uint256 gameId);
    error AlreadyJoined(address commander);
    error NotJoined(address commander);
    error InvalidZone(uint16 zoneId, uint16 zoneCount);
    error ZeroUnits();
    error InsufficientUnits(uint256 requested, uint256 available);
    error OnlyDeployer();
    error ProofGateAlreadySet();
    error ZeroAddress();
    error NotProofGate(address caller);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-shot wiring step: only the deployer, only once, only non-zero. See the
    /// contract-level NatSpec for why this exists and why it isn't a standing admin key.
    function setProofGate(address _proofGate) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (proofGate != address(0)) revert ProofGateAlreadySet();
        if (_proofGate == address(0)) revert ZeroAddress();
        proofGate = _proofGate;
    }

    modifier onlyProofGate() {
        if (msg.sender != proofGate) revert NotProofGate(msg.sender);
        _;
    }

    /// @notice Opens a new game. Permissionless — anyone can start one, but only one game
    /// may be unsettled (OPEN or ACTIVE) at a time: a new game can't be created until the
    /// most recent one has reached SETTLED. Games are created sequentially, so checking only
    /// the latest one is sufficient — every earlier game was itself gated by this same rule
    /// when it was created, so by induction it's already settled.
    function createGame(uint16 zoneCount, uint64 openDurationBlocks, uint64 activeDurationBlocks)
        external
        returns (uint256 gameId)
    {
        if (zoneCount == 0 || zoneCount > MAX_ZONE_COUNT) revert InvalidZoneCount(zoneCount);
        if (
            openDurationBlocks == 0 || openDurationBlocks > MAX_OPEN_DURATION_BLOCKS || activeDurationBlocks == 0
                || activeDurationBlocks > MAX_ACTIVE_DURATION_BLOCKS
        ) revert InvalidDuration();

        if (gameCount > 0) {
            GameState latestState = currentState(gameCount);
            if (latestState != GameState.SETTLED) revert PreviousGameNotSettled(gameCount, latestState);
        }

        gameId = ++gameCount;
        uint64 activeStartBlock = uint64(block.number) + openDurationBlocks;
        uint64 settleBlock = activeStartBlock + activeDurationBlocks;

        games[gameId] =
            GameConfig({exists: true, zoneCount: zoneCount, activeStartBlock: activeStartBlock, settleBlock: settleBlock});

        emit GameCreated(gameId, zoneCount, activeStartBlock, settleBlock);
    }

    /// @notice Current lifecycle state, purely a function of block.number — there is no
    /// separate "advance" transaction to call, so no operator and no cron are needed.
    function currentState(uint256 gameId) public view returns (GameState) {
        GameConfig storage g = games[gameId];
        if (!g.exists) revert GameDoesNotExist(gameId);
        if (block.number < g.activeStartBlock) return GameState.OPEN;
        if (block.number < g.settleBlock) return GameState.ACTIVE;
        return GameState.SETTLED;
    }

    /// @notice Joins a game, auto-assigned to whichever faction currently has the fewest
    /// commanders (ties broken Alpha < Beta < Gamma) so nobody can stack a team.
    function join(uint256 gameId) external {
        if (!games[gameId].exists) revert GameDoesNotExist(gameId);
        if (currentState(gameId) != GameState.OPEN) revert GameNotOpen(gameId);
        if (commanderFaction[gameId][msg.sender] != Faction.None) revert AlreadyJoined(msg.sender);

        Faction assigned = _leastPopulatedFaction(gameId);
        commanderFaction[gameId][msg.sender] = assigned;
        factionHeadcount[gameId][uint8(assigned)] += 1;
        unitPools[gameId][msg.sender] = UnitPool({balance: 0, lastUpdateBlock: uint64(block.number)});

        emit CommanderJoined(gameId, msg.sender, assigned);
    }

    /// @notice A commander's currently-available units, replenished at UNITS_PER_BLOCK since
    /// their last spend (or since joining), capped at MAX_UNIT_POOL. Zero if never joined.
    function currentUnits(uint256 gameId, address commander) public view returns (uint256) {
        UnitPool storage pool = unitPools[gameId][commander];
        if (pool.lastUpdateBlock == 0) return 0;
        uint256 replenished = pool.balance + (block.number - pool.lastUpdateBlock) * UNITS_PER_BLOCK;
        return replenished > MAX_UNIT_POOL ? MAX_UNIT_POOL : replenished;
    }

    /// @notice Resolves one order: spend units from the commander's pool, then either
    /// reinforce a zone they already own, capture an enemy/unclaimed zone (if units exceed
    /// its garrison — a tie favours the defender), or grind down its garrison.
    function resolveOrder(uint256 gameId, address commander, uint16 zoneId, uint32 units) external onlyProofGate {
        if (!games[gameId].exists) revert GameDoesNotExist(gameId);
        if (currentState(gameId) != GameState.ACTIVE) revert GameNotActive(gameId);
        if (zoneId >= games[gameId].zoneCount) revert InvalidZone(zoneId, games[gameId].zoneCount);
        if (units == 0) revert ZeroUnits();

        Faction faction = commanderFaction[gameId][commander];
        if (faction == Faction.None) revert NotJoined(commander);

        _spendUnits(gameId, commander, units);

        Zone storage zone = zones[gameId][zoneId];
        if (zone.owner == faction) {
            zone.garrison += units;
            emit ZoneReinforced(gameId, zoneId, faction, zone.garrison);
        } else if (units > zone.garrison) {
            Faction previousOwner = zone.owner;
            uint256 survivors = units - zone.garrison;
            zone.owner = faction;
            zone.garrison = survivors;
            emit ZoneCaptured(gameId, zoneId, previousOwner, faction, survivors);
        } else {
            zone.garrison -= units;
            emit ZoneAttacked(gameId, zoneId, faction, units, zone.garrison);
        }
    }

    function _leastPopulatedFaction(uint256 gameId) internal view returns (Faction) {
        uint256 countAlpha = factionHeadcount[gameId][uint8(Faction.Alpha)];
        uint256 countBeta = factionHeadcount[gameId][uint8(Faction.Beta)];
        uint256 countGamma = factionHeadcount[gameId][uint8(Faction.Gamma)];

        if (countAlpha <= countBeta && countAlpha <= countGamma) return Faction.Alpha;
        if (countBeta <= countGamma) return Faction.Beta;
        return Faction.Gamma;
    }

    function _spendUnits(uint256 gameId, address commander, uint256 amount) internal {
        uint256 available = currentUnits(gameId, commander);
        if (amount > available) revert InsufficientUnits(amount, available);
        unitPools[gameId][commander] = UnitPool({balance: available - amount, lastUpdateBlock: uint64(block.number)});
    }
}
