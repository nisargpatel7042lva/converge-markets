// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What the vault reads from the PartnerRegistry (docs/adr/ADR-008).
interface IPartnerRegistry {
    /// @param exists Whether the registry created the market.
    /// @param active Whether new allocation and quoting are allowed right now.
    /// @param partner The creating partner.
    /// @param partnerCap The partner's exposure cap in collateral units (0 when inactive).
    /// @param globalCap The cap on all partner markets together.
    struct Limits {
        bool exists;
        bool active;
        address partner;
        uint256 partnerCap;
        uint256 globalCap;
    }

    function limits(address market) external view returns (Limits memory);
}
