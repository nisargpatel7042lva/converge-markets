// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title MarketNaming
/// @notice Human-readable outcome token names, e.g.
///         name   "BTC UP 2026-10-01 14:15 UTC"
///         symbol "cBTC-UP-2610011415" (YYMMDDHHMM of the round start, UTC)
library MarketNaming {
    using Strings for uint256;

    /// @notice Converts a unix timestamp to its UTC calendar date and time.
    /// @dev Howard Hinnant's days_from_civil inverse ("civil_from_days"), valid for t >= 0.
    function toDateTime(uint256 t)
        internal
        pure
        returns (uint256 year, uint256 month, uint256 day, uint256 hour, uint256 minute)
    {
        // Integer division is the algorithm (calendar arithmetic), not a precision loss.
        // slither-disable-start divide-before-multiply
        // forge-lint: disable-start(divide-before-multiply)
        uint256 z = t / 1 days + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        day = doy - (153 * mp + 2) / 5 + 1;
        month = mp < 10 ? mp + 3 : mp - 9;
        year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        // forge-lint: disable-end(divide-before-multiply)
        // slither-disable-end divide-before-multiply
        uint256 secs = t % 1 days;
        hour = secs / 1 hours;
        minute = (secs % 1 hours) / 1 minutes;
    }

    /// @notice "BTC UP 2026-10-01 14:15 UTC"
    function tokenName(string memory asset, bool up, uint256 start)
        internal
        pure
        returns (string memory)
    {
        return string.concat(asset, up ? " UP " : " DOWN ", _isoMinute(start), " UTC");
    }

    /// @notice "cBTC-UP-2610011415"
    function tokenSymbol(string memory asset, bool up, uint256 start)
        internal
        pure
        returns (string memory)
    {
        return string.concat("c", asset, up ? "-UP-" : "-DOWN-", _compact(start));
    }

    /// @dev "2026-10-01 14:15"
    function _isoMinute(uint256 t) private pure returns (string memory) {
        (uint256 y, uint256 mo, uint256 d, uint256 h, uint256 mi) = toDateTime(t);
        string memory date = string.concat(y.toString(), "-", _pad2(mo), "-", _pad2(d));
        return string.concat(date, " ", _pad2(h), ":", _pad2(mi));
    }

    /// @dev "2610011415" (YYMMDDHHMM)
    function _compact(uint256 t) private pure returns (string memory) {
        (uint256 y, uint256 mo, uint256 d, uint256 h, uint256 mi) = toDateTime(t);
        return string.concat(_pad2(y % 100), _pad2(mo), _pad2(d), _pad2(h), _pad2(mi));
    }

    function _pad2(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", v.toString()) : v.toString();
    }
}
