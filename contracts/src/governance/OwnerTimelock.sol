// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title OwnerTimelock
/// @notice The owner of the vault, the resolvers and the partner registry, and the admin of the
///         factory and the scheduler receiver. The Safe multisig is its only proposer, executor and
///         canceller, so every owner action is public on chain for `getMinDelay()` seconds before it
///         can take effect. That window is what lets LPs leave if the Safe is ever compromised
///         (audit finding F9-01). The guardian's `pauseQuoting` and the keeper's halt do not go
///         through here: stopping is always instant, only loosening is slow.
/// @dev OpenZeppelin's TimelockController with the admin fixed to nobody: the constructor cannot be
///      given an admin that could bypass the delay, and the timelock administers itself, so its own
///      delay can only change through a timelocked call to `updateDelay`. It is deployed with a
///      delay of 0 (the boot state), so that the one-time handover batch (accept ownership of every
///      contract, then `updateDelay` to the production value) runs in a single Safe session; the
///      deployment tool and `verify` treat a delay below the configured one as incomplete.
contract OwnerTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0))
    {}
}
