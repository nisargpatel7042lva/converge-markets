// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IVerifierProxy} from "../../src/interfaces/IVerifierProxy.sol";

/// @notice TEST-ONLY stand-in for the Chainlink Data Streams VerifierProxy (Monad testnet has no
///         live verifier, see docs/EXTERNAL.md). Payload layout mirrors Chainlink's prefix
///         abi.encode(bytes32[3] reportContext, bytes reportData, ...) but the "signature" is a
///         single ECDSA signature by `signer` over keccak256(reportData), appended as a third
///         field. Never use on mainnet: whoever holds the signer key controls prices.
contract MockStreamsVerifierProxy is IVerifierProxy {
    address public immutable signer;
    /// @dev Optional fee mode (simulates Chainlink enabling an onchain FeeManager).
    uint256 public fee;
    bytes public expectedParam;

    error BadSignature();
    error FeeRequired(uint256 required, uint256 sent);
    error BadParameterPayload();

    function setFeeMode(uint256 fee_, bytes calldata expectedParam_) external {
        fee = fee_;
        expectedParam = expectedParam_;
    }

    constructor(address signer_) {
        signer = signer_;
    }

    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external
        payable
        returns (bytes memory)
    {
        if (fee != 0) {
            if (msg.value < fee) revert FeeRequired(fee, msg.value);
            if (keccak256(parameterPayload) != keccak256(expectedParam)) {
                revert BadParameterPayload();
            }
            if (msg.value > fee) {
                (bool ok,) = msg.sender.call{value: msg.value - fee}(""); // refund change
                require(ok, "refund failed");
            }
        }
        (, bytes memory reportData, bytes memory sig) =
            abi.decode(payload, (bytes32[3], bytes, bytes));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256(reportData));
        if (ECDSA.recover(digest, sig) != signer) revert BadSignature();
        return reportData;
    }
}
