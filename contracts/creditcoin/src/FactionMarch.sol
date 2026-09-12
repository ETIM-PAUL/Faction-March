// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FactionMarch
/// @notice The board. Three factions fight over zones with unit pools that replenish over
/// time, inside a block-number-driven OPEN -> ACTIVE -> SETTLED lifecycle. No cross-chain
/// anything lives here (Phase 6) — `resolveOrder` is exercised by tests via direct calls.
/// @dev UNGATED as of Phase 6: `resolveOrder` has no access control, so anyone can move any
/// commander's units right now. Phase 7 restricts it to the deployed ProofGate contract —
/// do not treat this contract as safe to point real players at before that lands.
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
    error GameNotOpen(uint256 gameId);
    error GameNotActive(uint256 gameId);
    error AlreadyJoined(address commander);
    error NotJoined(address commander);
    error InvalidZone(uint16 zoneId, uint16 zoneCount);
    error ZeroUnits();
    error InsufficientUnits(uint256 requested, uint256 available);

    /// @notice Opens a new game. Permissionless — anyone can start one.
    function createGame(uint16 zoneCount, uint64 openDurationBlocks, uint64 activeDurationBlocks)
        external
        returns (uint256 gameId)
    {
        if (zoneCount == 0 || zoneCount > MAX_ZONE_COUNT) revert InvalidZoneCount(zoneCount);
        if (openDurationBlocks == 0 || activeDurationBlocks == 0) revert InvalidDuration();

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
    /// @dev No access control. Phase 7 makes this callable only by ProofGate.
    function resolveOrder(uint256 gameId, address commander, uint16 zoneId, uint32 units) external {
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
