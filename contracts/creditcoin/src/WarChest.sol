// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FactionMarch} from "./FactionMarch.sol";

/// @title WarChest
/// @notice The Creditcoin thesis layer: an undercollateralised credit primitive backed by
/// proven territory, played rather than pitched. Reads territory straight from FactionMarch
/// (no changes needed there — this is a pure consumer) and is wired for reputation integrity
/// from ProofGate the same way FactionMarch is (Phase 7's one-shot setProofGate pattern).
/// @dev One deliberate, documented simplification, inherited from Phase 8's bounty design:
/// there is no audited, trustless way yet to move the Sepolia ETH order fee onto Creditcoin
/// (Attestcoin's writability primitives are still pre-audit), so the chest's CTC comes from
/// a permissionless depositToChest(), not literally the bridged Sepolia fee. depositToChest
/// itself is called two ways: directly (a manual top-up) and by ProofGate, once per proven
/// order, for that order's (discount-adjusted) chest fee — see CHEST_FEE_PER_ORDER.
///
/// Territory does three things now, not two: discountBps cheapens getting your own orders
/// proven (wired into ProofGate's fee calc), creditLimit scales borrowing power, and — the
/// direct payout — every depositToChest call immediately splits YIELD_SHARE_BPS of what
/// just arrived across factions by *current* territory, credited to claimableYield. The
/// other two are indirect (cheaper fees, bigger loan ceiling with default risk); this one is
/// real CTC for holding ground, funded by the game's own activity rather than freshly
/// minted. Splitting at the instant funds land, not on a claim snapshot, is what makes
/// sniping a zone right before a big deposit unprofitable for that deposit specifically: you
/// only ever earn a share of CTC that arrives after you already held the zone.
contract WarChest {
    FactionMarch public immutable FACTION_MARCH;

    /// @notice CTC credit granted per zone held, before repayment/default adjustments.
    uint256 public constant BASE_CREDIT_PER_ZONE = 0.001 ether;
    /// @notice Credit multiplier bonus per completed repayment (repeated good behaviour
    /// compounds — no cap, this is a demo-scale primitive).
    uint256 public constant REPAY_BONUS_BPS = 200; // +2%
    /// @notice Credit multiplier penalty per lifetime default — permanent, survives clearing.
    uint256 public constant DEFAULT_PENALTY_BPS = 3000; // -30%
    /// @notice A single borrow can't take more than this fraction of the chest's *current*
    /// balance, so one faction can't drain it and lock the others out.
    uint256 public constant MAX_DRAW_BPS_OF_CHEST = 2000; // 20%
    /// @notice Blocks a draw has to be repaid within before the line is considered defaulted.
    uint64 public immutable REPAYMENT_WINDOW_BLOCKS;
    /// @notice Fraction of every depositToChest inflow immediately split across factions by
    /// current territory (see claimableYield) instead of backing the shared credit line. The
    /// remainder (70%) still funds chestBalance -- this trades some collective borrowing
    /// power for a direct, ongoing reward the current territory-tiered discount/credit-limit
    /// incentives don't provide. Debt repayments are exempt (see repay): that CTC already
    /// passed through this split once, when it first entered the chest.
    uint256 public constant YIELD_SHARE_BPS = 3000; // 30%

    uint256 public constant TIER_1_ZONES = 3;
    uint256 public constant TIER_2_ZONES = 6;
    uint256 public constant TIER_3_ZONES = 9;
    uint256 public constant TIER_1_DISCOUNT_BPS = 500; // 5%
    uint256 public constant TIER_2_DISCOUNT_BPS = 1000; // 10%
    uint256 public constant TIER_3_DISCOUNT_BPS = 2000; // 20%

    address public immutable deployer;
    address public proofGate;

    struct FactionCredit {
        uint256 borrowed;
        uint256 repaidCount;
        uint256 defaultCount; // permanent; survives a cleared default
        uint64 dueBlock;
    }

    struct Reputation {
        uint256 ordersIssuedLowerBound; // highest proven Sepolia nonce + 1; a lower bound,
        // not a cryptographic count — Creditcoin can't observe orders that were issued on
        // Sepolia but never proven.
        uint256 ordersProven;
        uint256 bountiesClaimed;
        uint256 debtsRepaid;
    }

    mapping(uint256 => uint256) public chestBalance;
    mapping(uint256 => mapping(uint8 => FactionCredit)) public factionCredit;
    mapping(address => Reputation) public reputations;
    /// @notice CTC a faction has earned from territory yield but not yet claimed.
    mapping(uint256 => mapping(uint8 => uint256)) public claimableYield;

    event ChestFunded(uint256 indexed gameId, address indexed funder, uint256 amount);
    event YieldAccrued(uint256 indexed gameId, FactionMarch.Faction indexed faction, uint256 amount);
    event YieldClaimed(uint256 indexed gameId, FactionMarch.Faction indexed faction, address indexed claimant, uint256 amount);
    event CreditBorrowed(
        uint256 indexed gameId, FactionMarch.Faction indexed faction, address indexed borrower, uint256 amount, uint64 dueBlock
    );
    event CreditRepaid(uint256 indexed gameId, FactionMarch.Faction indexed faction, address indexed payer, uint256 amount);
    event CreditLineCleared(uint256 indexed gameId, FactionMarch.Faction indexed faction, uint256 defaultCount);
    event OrderRecorded(uint256 indexed gameId, address indexed commander, address indexed courier, bool bountyPaid);

    error OnlyDeployer();
    error ProofGateAlreadySet();
    error ZeroAddress();
    error NotProofGate(address caller);
    error NotFactionMember(address caller, FactionMarch.Faction faction);
    error CreditLineInDefault(uint256 gameId, FactionMarch.Faction faction);
    error ExceedsAvailableCredit(uint256 requested, uint256 available);
    error ExceedsPerDrawCap(uint256 requested, uint256 cap);
    error InsufficientChestBalance(uint256 requested, uint256 available);
    error BorrowTransferFailed();
    error RefundFailed();
    error NoYieldToClaim();
    error YieldTransferFailed();

    constructor(address factionMarch, uint64 repaymentWindowBlocks) {
        FACTION_MARCH = FactionMarch(factionMarch);
        REPAYMENT_WINDOW_BLOCKS = repaymentWindowBlocks;
        deployer = msg.sender;
    }

    /// @notice One-shot wiring step, identical in spirit to FactionMarch's: only the
    /// deployer, only once. Until called, recordOrderResolution is unusable by anyone.
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

    /// @notice Tops up a game's chest. Permissionless. Called directly for a manual deposit,
    /// or by ProofGate once per proven order for that order's chest fee -- either way,
    /// YIELD_SHARE_BPS of what arrives is split across factions by territory before the rest
    /// lands in chestBalance.
    function depositToChest(uint256 gameId) external payable {
        emit ChestFunded(gameId, msg.sender, msg.value);
        uint256 yieldPortion = (msg.value * YIELD_SHARE_BPS) / 10_000;
        uint256 distributed = _distributeYield(gameId, yieldPortion);
        chestBalance[gameId] += msg.value - distributed;
    }

    /// @dev Splits `yieldPortion` across Alpha/Beta/Gamma proportional to zones held *right
    /// now*, crediting claimableYield. Returns what was actually distributed so the caller
    /// can route any remainder (no territory yet, or integer-division dust) back into
    /// chestBalance instead of losing it. One pass over zones, not one call to
    /// territoryHeld() per faction, to keep this from tripling the O(zoneCount) cost on
    /// every single deposit -- zoneCount is bounded by FactionMarch.MAX_ZONE_COUNT (100), so
    /// this is a real, disclosed gas cost per proof, not an unbounded one.
    function _distributeYield(uint256 gameId, uint256 yieldPortion) internal returns (uint256 distributed) {
        if (yieldPortion == 0) return 0;
        (, uint16 zoneCount,,) = FACTION_MARCH.games(gameId);
        if (zoneCount == 0) return 0;

        uint256[4] memory heldBy; // index by Faction enum; [0] (None) never accrues
        uint256 totalHeld;
        for (uint16 z = 0; z < zoneCount; z++) {
            (FactionMarch.Faction owner,) = FACTION_MARCH.zones(gameId, z);
            if (owner != FactionMarch.Faction.None) {
                heldBy[uint8(owner)]++;
                totalHeld++;
            }
        }
        if (totalHeld == 0) return 0;

        for (uint8 f = 1; f <= 3; f++) {
            if (heldBy[f] == 0) continue;
            uint256 share = (yieldPortion * heldBy[f]) / totalHeld;
            if (share == 0) continue;
            claimableYield[gameId][f] += share;
            distributed += share;
            emit YieldAccrued(gameId, FactionMarch.Faction(f), share);
        }
    }

    /// @notice Claims a faction's accrued territory yield. Only a member of `faction` can
    /// claim, but funds go to whoever calls -- same "no admin key, permissionless within
    /// membership" shape as borrow/repay.
    function claimYield(uint256 gameId, FactionMarch.Faction faction) external {
        if (FACTION_MARCH.commanderFaction(gameId, msg.sender) != faction) {
            revert NotFactionMember(msg.sender, faction);
        }
        uint256 amount = claimableYield[gameId][uint8(faction)];
        if (amount == 0) revert NoYieldToClaim();
        claimableYield[gameId][uint8(faction)] = 0;

        emit YieldClaimed(gameId, faction, msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert YieldTransferFailed();
    }

    /// @notice Zones currently held by a faction, read live from FactionMarch. O(zoneCount),
    /// bounded by MAX_ZONE_COUNT (100) — fine for a view call.
    function territoryHeld(uint256 gameId, FactionMarch.Faction faction) public view returns (uint256 count) {
        (, uint16 zoneCount,,) = FACTION_MARCH.games(gameId);
        for (uint16 z = 0; z < zoneCount; z++) {
            (FactionMarch.Faction owner,) = FACTION_MARCH.zones(gameId, z);
            if (owner == faction) count++;
        }
    }

    /// @notice Informational: the order-cost discount this faction's territory would earn,
    /// if anything on Sepolia were able to apply it. See contract-level NatSpec.
    function discountBps(uint256 gameId, FactionMarch.Faction faction) public view returns (uint256) {
        uint256 zones = territoryHeld(gameId, faction);
        if (zones >= TIER_3_ZONES) return TIER_3_DISCOUNT_BPS;
        if (zones >= TIER_2_ZONES) return TIER_2_DISCOUNT_BPS;
        if (zones >= TIER_1_ZONES) return TIER_1_DISCOUNT_BPS;
        return 0;
    }

    /// @notice True while a faction's outstanding draw is past its repayment window — the
    /// line is closed (creditLimit returns 0) for as long as this holds. Computed, not
    /// stored: no separate "declare default" transaction for anyone to forget to call.
    function isInDefault(uint256 gameId, FactionMarch.Faction faction) public view returns (bool) {
        FactionCredit storage credit = factionCredit[gameId][uint8(faction)];
        return credit.borrowed > 0 && block.number > credit.dueBlock;
    }

    /// @notice Function of zones held and repayment history, per the build plan. A live
    /// default zeroes it outright; every past default permanently shaves the multiplier,
    /// even after the line is cleared — "pays a higher tier until it clears" plus a lasting
    /// scar, not just a temporary lockout.
    function creditLimit(uint256 gameId, FactionMarch.Faction faction) public view returns (uint256) {
        if (isInDefault(gameId, faction)) return 0;

        FactionCredit storage credit = factionCredit[gameId][uint8(faction)];
        uint256 base = territoryHeld(gameId, faction) * BASE_CREDIT_PER_ZONE;

        uint256 bonusBps = credit.repaidCount * REPAY_BONUS_BPS;
        uint256 penaltyBps = credit.defaultCount * DEFAULT_PENALTY_BPS;
        uint256 multiplierBps = 10_000 + bonusBps;
        if (penaltyBps >= multiplierBps) return 0;
        multiplierBps -= penaltyBps;

        return (base * multiplierBps) / 10_000;
    }

    function availableCredit(uint256 gameId, FactionMarch.Faction faction) public view returns (uint256) {
        uint256 limit = creditLimit(gameId, faction);
        uint256 borrowed = factionCredit[gameId][uint8(faction)].borrowed;
        return limit > borrowed ? limit - borrowed : 0;
    }

    /// @notice Borrow against proven territory to fund an offensive beyond the chest
    /// balance. Only a member of `faction` can draw on its line; funds go to the caller.
    function borrow(uint256 gameId, FactionMarch.Faction faction, uint256 amount) external {
        if (FACTION_MARCH.commanderFaction(gameId, msg.sender) != faction) {
            revert NotFactionMember(msg.sender, faction);
        }
        if (isInDefault(gameId, faction)) revert CreditLineInDefault(gameId, faction);

        uint256 available = availableCredit(gameId, faction);
        if (amount > available) revert ExceedsAvailableCredit(amount, available);

        uint256 drawCap = (chestBalance[gameId] * MAX_DRAW_BPS_OF_CHEST) / 10_000;
        if (amount > drawCap) revert ExceedsPerDrawCap(amount, drawCap);
        if (amount > chestBalance[gameId]) revert InsufficientChestBalance(amount, chestBalance[gameId]);

        FactionCredit storage credit = factionCredit[gameId][uint8(faction)];
        chestBalance[gameId] -= amount;
        credit.borrowed += amount;
        credit.dueBlock = uint64(block.number) + REPAYMENT_WINDOW_BLOCKS;

        emit CreditBorrowed(gameId, faction, msg.sender, amount, credit.dueBlock);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert BorrowTransferFailed();
    }

    /// @notice Repays a faction's outstanding debt. Permissionless — anyone can repay on a
    /// faction's behalf, matching every other "no admin key" surface in this codebase.
    /// Fully clearing a defaulted line reopens it (permanently scarred — see creditLimit).
    /// Any overpayment beyond the outstanding balance is refunded.
    function repay(uint256 gameId, FactionMarch.Faction faction) external payable {
        FactionCredit storage credit = factionCredit[gameId][uint8(faction)];
        bool wasInDefault = isInDefault(gameId, faction);

        uint256 applied = msg.value > credit.borrowed ? credit.borrowed : msg.value;
        credit.borrowed -= applied;

        if (applied > 0) {
            credit.repaidCount += 1;
            // No yield split here, deliberately -- this CTC already passed through
            // _distributeYield once, when it first entered the chest as a deposit or proof
            // fee. Splitting it again on the way back would tax the same principal twice.
            chestBalance[gameId] += applied;
            reputations[msg.sender].debtsRepaid += 1;
            emit CreditRepaid(gameId, faction, msg.sender, applied);
        }

        if (wasInDefault && credit.borrowed == 0) {
            credit.defaultCount += 1;
            emit CreditLineCleared(gameId, faction, credit.defaultCount);
        }

        uint256 refund = msg.value - applied;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Called by ProofGate in the same transaction as order resolution — the only
    /// authentic (non-self-reported) source for `ordersProven`/`bountiesClaimed`.
    function recordOrderResolution(uint256 gameId, address commander, address courier, uint64 nonce, bool bountyPaid)
        external
        onlyProofGate
    {
        Reputation storage rep = reputations[commander];
        rep.ordersProven += 1;
        if (nonce + 1 > rep.ordersIssuedLowerBound) {
            rep.ordersIssuedLowerBound = nonce + 1;
        }
        if (bountyPaid) {
            reputations[courier].bountiesClaimed += 1;
        }
        emit OrderRecorded(gameId, commander, courier, bountyPaid);
    }
}
