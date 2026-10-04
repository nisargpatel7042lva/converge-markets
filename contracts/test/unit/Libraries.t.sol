// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Series} from "../../src/libraries/Series.sol";
import {MarketNaming} from "../../src/libraries/MarketNaming.sol";

/// @dev External wrappers so reverts from internal library functions can be asserted.
contract SeriesHarness {
    function isAligned(uint64 t, uint64 d) external pure returns (bool) {
        return Series.isAligned(t, d);
    }

    function roundStart(uint64 t, uint64 d) external pure returns (uint64) {
        return Series.roundStart(t, d);
    }

    function nextBoundary(uint64 t, uint64 d) external pure returns (uint64) {
        return Series.nextBoundary(t, d);
    }
}

contract LibrariesTest is Test {
    SeriesHarness h = new SeriesHarness();

    function test_series_boundaries() public view {
        uint64 t = 1_790_864_100 + 7 minutes; // 2026-10-01 14:22 UTC
        assertEq(h.roundStart(t, 15 minutes), 1_790_864_100); // 14:15
        assertEq(h.nextBoundary(t, 15 minutes), 1_790_864_100 + 15 minutes); // 14:30
        assertEq(h.roundStart(t, 1 hours), 1_790_863_200); // 14:00
        assertEq(h.nextBoundary(t, 1 hours), 1_790_866_800); // 15:00
        assertTrue(h.isAligned(1_790_864_100, 15 minutes));
        assertFalse(h.isAligned(1_790_864_100, 1 hours));
        assertTrue(Series.isSupportedDuration(1 hours));
        assertFalse(Series.isSupportedDuration(30 minutes));
    }

    function test_series_rejectsUnsupported() public {
        vm.expectRevert(abi.encodeWithSelector(Series.UnsupportedDuration.selector, uint64(60)));
        h.roundStart(100, 60);
        vm.expectRevert(abi.encodeWithSelector(Series.UnsupportedDuration.selector, uint64(0)));
        h.isAligned(100, 0);
    }

    function testFuzz_series_roundStartProperties(uint64 t, bool hourly) public view {
        uint64 d = hourly ? 1 hours : 15 minutes;
        t = uint64(bound(t, 0, type(uint64).max - 2 hours));
        uint64 s = h.roundStart(t, d);
        assertTrue(h.isAligned(s, d));
        assertLe(s, t);
        assertGt(s + d, t);
        assertEq(h.nextBoundary(t, d), s + d);
    }

    function test_dateTime_vectors() public pure {
        _check(0, 1970, 1, 1, 0, 0);
        _check(951_782_400, 2000, 2, 29, 0, 0); // leap day, century divisible by 400
        _check(1_709_164_800, 2024, 2, 29, 0, 0);
        _check(1_709_251_200, 2024, 3, 1, 0, 0);
        _check(1_790_864_100, 2026, 10, 1, 14, 15);
        _check(1_798_761_599, 2026, 12, 31, 23, 59);
        _check(4_107_542_400, 2100, 3, 1, 0, 0); // 2100 is not a leap year
    }

    function test_names() public pure {
        assertEq(MarketNaming.tokenName("BTC", true, 1_790_864_100), "BTC UP 2026-10-01 14:15 UTC");
        assertEq(MarketNaming.tokenSymbol("ETH", false, 1_709_164_800), "cETH-DOWN-2402290000");
        assertEq(
            MarketNaming.tokenName("MON", false, 4_107_542_400), "MON DOWN 2100-03-01 00:00 UTC"
        );
    }

    function _check(uint256 t, uint256 y, uint256 mo, uint256 d, uint256 hh, uint256 mi)
        internal
        pure
    {
        (uint256 Y, uint256 M, uint256 D, uint256 H, uint256 Mi) = MarketNaming.toDateTime(t);
        assertEq(Y, y);
        assertEq(M, mo);
        assertEq(D, d);
        assertEq(H, hh);
        assertEq(Mi, mi);
    }
}
