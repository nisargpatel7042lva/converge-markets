// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Series
/// @notice Pure helpers for aligned UTC round boundaries. Unix time has no leap seconds, so a
///         boundary aligned to `duration` seconds is aligned to the UTC wall clock
///         (15m: :00/:15/:30/:45; 1h: top of the hour).
library Series {
    uint64 internal constant FIFTEEN_MINUTES = 15 minutes;
    uint64 internal constant ONE_HOUR = 1 hours;

    error UnsupportedDuration(uint64 duration);

    /// @notice True for the round durations Converge lists (15m, 1h).
    function isSupportedDuration(uint64 duration) internal pure returns (bool) {
        return duration == FIFTEEN_MINUTES || duration == ONE_HOUR;
    }

    /// @notice Whether `t` is a boundary of the `duration` series.
    function isAligned(uint64 t, uint64 duration) internal pure returns (bool) {
        _check(duration);
        return t % duration == 0;
    }

    /// @notice Start of the round containing `t` (largest boundary <= t).
    function roundStart(uint64 t, uint64 duration) internal pure returns (uint64) {
        _check(duration);
        return t - (t % duration);
    }

    /// @notice First boundary strictly after `t`.
    function nextBoundary(uint64 t, uint64 duration) internal pure returns (uint64) {
        return roundStart(t, duration) + duration;
    }

    function _check(uint64 duration) private pure {
        if (!isSupportedDuration(duration)) revert UnsupportedDuration(duration);
    }
}
