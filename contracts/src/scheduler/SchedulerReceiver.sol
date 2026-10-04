// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MarketFactory} from "../MarketFactory.sol";
import {Market} from "../Market.sol";

/// @notice Chainlink CRE consumer interface, as documented in
///         https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts
///         (read 2026-10-04). The KeystoneForwarder calls onReport after verifying DON signatures.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title SchedulerReceiver
/// @notice Onchain end of the Converge scheduler (Phase 2). Receives CRE workflow reports via the
///         Chainlink KeystoneForwarder and executes a batch of idempotent market actions:
///         create (needs this contract to hold the factory's CREATOR_ROLE), open, resolve,
///         invalidate. Open/resolve only forward oracle evidence (round ids / signed reports) that
///         the market's resolver verifies, so the scheduler can never choose an outcome.
///         Also stores the scheduler leader flag (CRE or FALLBACK) that both schedulers read.
/// @dev Report payload: abi.encode(uint256 chainId, uint64 scheduledTime, Action[] actions).
///      Reports for another chain or older than maxReportAge are rejected (replay protection, per
///      the CRE docs' "Replay attacks" guidance). Every action is try/caught so one failing action
///      never blocks the rest; results are emitted for monitoring.
contract SchedulerReceiver is IReceiver, AccessControl {
    /// @notice Can switch the leader (ops runbook: leader switch).
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice An action is only started with at least this much gas left (a market creation
    ///         costs ~540k), so an oversized batch degrades (remaining actions skipped and retried
    ///         next run) instead of reverting the whole report.
    uint256 public constant ACTION_GAS_RESERVE = 750_000;
    /// @notice Reports may be timestamped at most this far ahead of the block (clock skew).
    uint64 public constant MAX_FUTURE_SKEW = 60;

    enum Leader {
        CRE,
        FALLBACK
    }

    enum Kind {
        CREATE,
        OPEN,
        RESOLVE,
        INVALIDATE
    }

    struct Action {
        Kind kind;
        bytes32 assetId;
        uint64 duration;
        uint64 startTime;
        bytes evidence;
    }

    /// @notice Chainlink KeystoneForwarder for this chain (docs/EXTERNAL.md).
    address public immutable forwarder;
    MarketFactory public immutable factory;

    /// @notice Only reports from this workflow owner are accepted (must be set before use).
    address public expectedWorkflowOwner;
    /// @notice If non-zero, only reports from this workflow id are accepted.
    bytes32 public expectedWorkflowId;
    /// @notice Reports whose scheduled time is older than this are rejected.
    uint64 public maxReportAge = 5 minutes;
    /// @notice Which scheduler acts. The other stays passive (and alerts if actions are late).
    Leader public leader;

    event LeaderSet(Leader leader);
    event WorkflowSet(address owner, bytes32 workflowId);
    event MaxReportAgeSet(uint64 maxAge);
    event ReportIgnored(uint64 scheduledTime, Leader leader);
    event ReportProcessed(uint64 scheduledTime, uint256 actions, uint256 failed);
    /// @notice Gas ran low: `skipped` trailing actions were not attempted (retried next run).
    event ActionsSkipped(uint64 scheduledTime, uint256 skipped);
    event ActionExecuted(
        Kind indexed kind,
        bytes32 indexed assetId,
        uint64 duration,
        uint64 startTime,
        bool ok,
        bytes4 errorSelector
    );

    error InvalidSender(address sender);
    error WorkflowNotConfigured();
    error InvalidWorkflowOwner(address owner);
    error InvalidWorkflowId(bytes32 workflowId);
    error BadMetadata();
    error WrongChain(uint256 chainId);
    error StaleReport(uint64 scheduledTime);
    error ZeroAddress();
    error MarketNotFound(bytes32 assetId, uint64 duration, uint64 startTime);
    error FutureReport(uint64 scheduledTime);
    error InvalidMaxReportAge();

    constructor(address forwarder_, MarketFactory factory_, address admin) {
        if (forwarder_ == address(0) || address(factory_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        forwarder = forwarder_;
        factory = factory_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    function setWorkflow(address owner, bytes32 workflowId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (owner == address(0)) revert ZeroAddress();
        expectedWorkflowOwner = owner;
        expectedWorkflowId = workflowId;
        emit WorkflowSet(owner, workflowId);
    }

    function setMaxReportAge(uint64 maxAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxAge == 0) revert InvalidMaxReportAge();
        maxReportAge = maxAge;
        emit MaxReportAgeSet(maxAge);
    }

    function setLeader(Leader leader_) external onlyRole(OPERATOR_ROLE) {
        leader = leader_;
        emit LeaderSet(leader_);
    }

    // ------------------------------------------------------------------ CRE entry point

    /// @inheritdoc IReceiver
    /// @dev metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner)
    ///      (62 bytes; production forwarders append a 2-byte reportId, so >= 62 is accepted).
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender);
        address owner = expectedWorkflowOwner;
        if (owner == address(0)) revert WorkflowNotConfigured();
        if (metadata.length < 62) revert BadMetadata();
        bytes32 workflowId = bytes32(metadata[0:32]);
        address workflowOwner = address(bytes20(metadata[42:62]));
        if (workflowOwner != owner) revert InvalidWorkflowOwner(workflowOwner);
        bytes32 expectedId = expectedWorkflowId;
        if (expectedId != bytes32(0) && workflowId != expectedId) {
            revert InvalidWorkflowId(workflowId);
        }

        (uint256 chainId, uint64 scheduledTime, Action[] memory actions) =
            abi.decode(report, (uint256, uint64, Action[]));
        if (chainId != block.chainid) revert WrongChain(chainId);
        if (uint256(scheduledTime) + maxReportAge < block.timestamp) {
            revert StaleReport(scheduledTime);
        }
        if (scheduledTime > block.timestamp + MAX_FUTURE_SKEW) revert FutureReport(scheduledTime);
        if (leader != Leader.CRE) {
            emit ReportIgnored(scheduledTime, leader);
            return;
        }
        uint256 failed = 0;
        uint256 i = 0;
        for (; i < actions.length; ++i) {
            if (gasleft() < ACTION_GAS_RESERVE) break;
            if (!_execute(actions[i])) failed += 1;
        }
        if (i < actions.length) {
            // forge-lint: disable-next-line(reentrancy-events)
            emit ActionsSkipped(scheduledTime, actions.length - i);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(scheduledTime, i, failed);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Executes one action; never reverts. Failures (e.g. "already created", "already
    ///      resolved", "price not final yet") are expected under idempotent re-runs.
    // Batched external calls are the purpose of this contract; the batch size is bounded by the
    // workflow (one action per due market) and every call is to our own factory/markets.
    // forge-lint: disable-start(calls-loop)
    // slither-disable-next-line unused-return
    function _execute(Action memory a) private returns (bool ok) {
        bytes4 sel = bytes4(0);
        if (a.kind == Kind.CREATE) {
            try factory.createMarket(a.assetId, a.duration, a.startTime) returns (address) {
                ok = true;
            } catch (bytes memory err) {
                sel = _selector(err);
            }
        } else {
            address m = factory.getMarket(a.assetId, a.duration, a.startTime);
            if (m == address(0)) {
                sel = MarketNotFound.selector;
            } else if (a.kind == Kind.OPEN) {
                try Market(m).open(a.evidence) {
                    ok = true;
                } catch (bytes memory err) {
                    sel = _selector(err);
                }
            } else if (a.kind == Kind.RESOLVE) {
                try Market(m).resolve(a.evidence) {
                    ok = true;
                } catch (bytes memory err) {
                    sel = _selector(err);
                }
            } else {
                try Market(m).invalidate() {
                    ok = true;
                } catch (bytes memory err) {
                    sel = _selector(err);
                }
            }
        }
        // Monitoring event after calls to our own factory/markets only.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ActionExecuted(a.kind, a.assetId, a.duration, a.startTime, ok, sel);
    }
    // forge-lint: disable-end(calls-loop)

    function _selector(bytes memory err) private pure returns (bytes4 sel) {
        if (err.length >= 4) {
            assembly {
                sel := mload(add(err, 0x20))
            }
        }
    }
}
