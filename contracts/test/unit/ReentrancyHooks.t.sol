// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultBase} from "../VaultBase.t.sol";
import {Market} from "../../src/Market.sol";
import {ConvergeVault} from "../../src/vault/ConvergeVault.sol";
import {ForwardVenue} from "../../src/vault/ForwardVenue.sol";
import {PartnerRegistry} from "../../src/partners/PartnerRegistry.sol";
import {IPartnerRegistry} from "../../src/partners/IPartnerRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {HookERC20, ITransferHook} from "../mocks/HookERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Reentrancy through token hooks (and through the native-token reward). The collateral
///         calls the depositor / receiver back in the middle of every function that moves it; the
///         hostile contract then tries every state-changing entry point of the vault, the market,
///         the venue and the partner registry. Each attempt must fail with the reentrancy guard's
///         error while the outer call completes. This covers the audit item "reentrancy, including
///         via token hooks" (docs/security/internal-audit.md section 4).
contract Attacker is ITransferHook {
    struct Call {
        address target;
        bytes data;
    }

    Call[] public calls;
    uint256 public attempts;
    uint256 public blocked; // reverted with ReentrancyGuardReentrantCall
    uint256 public succeeded; // went through (must stay 0)
    uint256[] public succeededAt; // which calls went through
    bytes4 public lastOtherRevert;
    bool internal inHook;

    function set(Call[] memory cs) external {
        delete calls;
        for (uint256 i = 0; i < cs.length; i++) {
            calls.push(cs[i]);
        }
        attempts = 0;
        blocked = 0;
        succeeded = 0;
        delete succeededAt;
        lastOtherRevert = 0;
    }

    function _run() internal {
        if (inHook) return; // our own calls move tokens too: do not recurse into ourselves
        inHook = true;
        for (uint256 i = 0; i < calls.length; i++) {
            attempts++;
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].data);
            if (ok) {
                succeeded++;
                succeededAt.push(i);
            } else if (
                ret.length >= 4
                    && bytes4(ret) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
            ) {
                blocked++;
            } else if (ret.length >= 4) {
                lastOtherRevert = bytes4(ret);
            }
        }
        inHook = false;
    }

    function onTransferHook() external {
        _run();
    }

    receive() external payable {
        _run();
    }

    function doCall(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, "outer call failed");
        return ret;
    }

    function approveAll(address token, address spender) external {
        (bool ok,) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max)
        );
        require(ok);
    }
}

contract ReentrancyHooksTest is VaultBase {
    HookERC20 internal hook;
    Attacker internal mallory;
    PartnerRegistry internal reg;
    address internal pOwner = makeAddr("pOwner");
    address internal pTreasury = makeAddr("pTreasury");

    function _newCollateral() internal override returns (MockERC20) {
        hook = new HookERC20();
        return hook;
    }

    function setUp() public override {
        super.setUp();
        mallory = new Attacker();
        hook.setHooked(address(mallory), true);
        reg = new PartnerRegistry(factory, pOwner, pOwner, pTreasury);
        vm.startPrank(pOwner);
        reg.setConfig(10 * U, 500 * U, 50, pTreasury, pTreasury);
        reg.setVault(address(vault));
        reg.setFeed(ETH, true);
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        reg.approvePartner(address(mallory), 40 * U, 3000, feeds);
        vm.stopPrank();
        vm.prank(vOwner);
        vault.setPartnerRegistry(IPartnerRegistry(address(reg)));
        _fund(alice, 1000 * U);
        _setSigma(0.6e18);
    }

    // ------------------------------------------------------------------ helpers

    function _c(address target, bytes memory data) internal pure returns (Attacker.Call memory c) {
        c = Attacker.Call(target, data);
    }

    /// @dev Everything an attacker could try against the vault and its venue.
    function _vaultAttacks(Market m) internal view returns (Attacker.Call[] memory cs) {
        cs = new Attacker.Call[](11);
        cs[0] = _c(address(vault), abi.encodeCall(ConvergeVault.requestDeposit, (11 * U)));
        cs[1] = _c(address(vault), abi.encodeCall(ConvergeVault.requestRedeem, (1)));
        cs[2] =
            _c(address(vault), abi.encodeCall(ConvergeVault.claimDeposit, (0, address(mallory))));
        cs[3] = _c(address(vault), abi.encodeCall(ConvergeVault.claimRedeem, (0, address(mallory))));
        cs[4] = _c(address(vault), abi.encodeCall(ConvergeVault.settleEpoch, (0, _noReports())));
        cs[5] = _c(address(vault), abi.encodeCall(ConvergeVault.checkpoint, (_noReports())));
        cs[6] = _c(address(vault), abi.encodeCall(ConvergeVault.redeemResolved, (m)));
        cs[7] = _c(address(vault), abi.encodeCall(ConvergeVault.pruneEmpty, (m)));
        cs[8] = _c(address(vault), abi.encodeCall(ConvergeVault.mergeInventory, (m, 1)));
        cs[9] = _c(address(vault), abi.encodeCall(ConvergeVault.splitForInventory, (m, 1)));
        cs[10] = _c(
            address(vault),
            abi.encodeCall(
                ConvergeVault.venueFill,
                (ConvergeVault.FillParams({
                        market: m,
                        upToken: true,
                        vaultSells: true,
                        units: 1,
                        premium: 1,
                        taker: address(mallory),
                        refPrice: 1,
                        refObs: 1
                    }))
            )
        );
    }

    function _marketAttacks(Market m) internal pure returns (Attacker.Call[] memory cs) {
        cs = new Attacker.Call[](6);
        cs[0] = _c(address(m), abi.encodeCall(Market.split, (1)));
        cs[1] = _c(address(m), abi.encodeCall(Market.merge, (1)));
        cs[2] = _c(address(m), abi.encodeCall(Market.redeem, ()));
        cs[3] = _c(address(m), abi.encodeCall(Market.open, ("")));
        cs[4] = _c(address(m), abi.encodeCall(Market.resolve, ("")));
        cs[5] = _c(address(m), abi.encodeCall(Market.claimFees, ()));
    }

    function _venueAttacks(Market m) internal view returns (Attacker.Call[] memory cs) {
        cs = new Attacker.Call[](4);
        cs[0] = _c(
            address(venue),
            abi.encodeCall(ForwardVenue.placeOrder, (m, ForwardVenue.Kind.BUY_UP, 1 * U, 0.6e18))
        );
        cs[1] = _c(address(venue), abi.encodeCall(ForwardVenue.executeOrder, (1, "")));
        cs[2] = _c(address(venue), abi.encodeCall(ForwardVenue.expireOrder, (1)));
        cs[3] = _c(
            address(venue),
            abi.encodeCall(ForwardVenue.placeOrder, (m, ForwardVenue.Kind.SELL_UP, 1, 0.4e18))
        );
    }

    function _registryAttacks(Market m) internal view returns (Attacker.Call[] memory cs) {
        cs = new Attacker.Call[](7);
        cs[0] = _c(address(reg), abi.encodeCall(PartnerRegistry.postBond, (1)));
        cs[1] = _c(address(reg), abi.encodeCall(PartnerRegistry.withdrawFees, (address(mallory))));
        cs[2] = _c(
            address(reg), abi.encodeCall(PartnerRegistry.executeBondWithdrawal, (address(mallory)))
        );
        cs[3] = _c(address(reg), abi.encodeCall(PartnerRegistry.collectFees, (m)));
        cs[4] = _c(address(reg), abi.encodeCall(PartnerRegistry.slash, (address(mallory), 1, 0)));
        cs[5] = _c(address(reg), abi.encodeCall(PartnerRegistry.sweepStray, ()));
        cs[6] = _c(
            address(reg),
            abi.encodeCall(
                PartnerRegistry.createThresholdMarket,
                (ETH, 3000e18, uint64(block.timestamp + 1 hours))
            )
        );
    }

    function _concat(Attacker.Call[] memory a, Attacker.Call[] memory b)
        internal
        pure
        returns (Attacker.Call[] memory r)
    {
        r = new Attacker.Call[](a.length + b.length);
        for (uint256 i = 0; i < a.length; i++) {
            r[i] = a[i];
        }
        for (uint256 i = 0; i < b.length; i++) {
            r[a.length + i] = b[i];
        }
    }

    function _assertBlocked(string memory what) internal {
        for (uint256 i = 0; i < mallory.succeeded(); i++) {
            emit log_named_uint(
                string.concat(what, " went through, call index"), mallory.succeededAt(i)
            );
        }
        assertGt(mallory.attempts(), 0, string.concat(what, ": the hook never ran"));
        assertEq(mallory.succeeded(), 0, string.concat(what, ": a reentrant call went through"));
        assertEq(
            mallory.blocked(),
            mallory.attempts(),
            string.concat(what, ": some call failed for another reason")
        );
    }

    /// @dev The guards are per contract: entering one contract blocks that contract's functions,
    ///      and a call into ANOTHER contract is a different (cross-contract) question, answered by
    ///      the solvency tests below. The venue executes through the vault, so both are locked
    ///      during an order's execution.
    function _vaultOnly(Market m) internal view returns (Attacker.Call[] memory) {
        return _vaultAttacks(m);
    }

    function _vaultAndVenue(Market m) internal view returns (Attacker.Call[] memory) {
        return _concat(_vaultAttacks(m), _venueAttacks(m));
    }

    function _everything(Market m) internal view returns (Attacker.Call[] memory) {
        return _concat(
            _concat(_vaultAttacks(m), _marketAttacks(m)),
            _concat(_venueAttacks(m), _registryAttacks(m))
        );
    }

    /// @dev Nothing a hostile hook did can leave a contract owing more than it holds.
    function _assertSolvent(Market m) internal view {
        assertGe(
            hook.balanceOf(address(vault)),
            vault.pendingDeposits() + vault.claimableAssets(),
            "vault owes more than it holds"
        );
        if (m.state() == Market.State.OPEN || m.state() == Market.State.CREATED) {
            assertEq(
                hook.balanceOf(address(m)), m.up().totalSupply(), "market collateral != UP supply"
            );
            assertEq(m.up().totalSupply(), m.down().totalSupply(), "UP and DOWN supplies differ");
        }
        assertEq(hook.balanceOf(address(reg)), reg.liabilities(), "registry books do not match");
    }

    function _market() internal returns (Market m) {
        m = _openEth(T0, M15, 3000e18);
        vm.warp(T0 + 5);
    }

    // ------------------------------------------------------------------ vault

    function test_hook_duringRequestDeposit() public {
        Market m = _market();
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(vault));
        mallory.set(_vaultOnly(m));
        mallory.doCall(address(vault), abi.encodeCall(ConvergeVault.requestDeposit, (20 * U)));
        _assertBlocked("requestDeposit");
        assertEq(vault.pendingDeposits(), 20 * U); // the outer deposit was recorded exactly once
    }

    function test_hook_duringClaimRedeemPayout() public {
        Market m = _market();
        // mallory becomes an LP and requests a redemption; the payout transfer calls it back
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(vault));
        mallory.set(new Attacker.Call[](0));
        mallory.doCall(address(vault), abi.encodeCall(ConvergeVault.requestDeposit, (50 * U)));
        _toEpochEnd(vault.currentEpoch());
        vault.settleEpoch(0 + vault.currentEpoch() - 1, _noReports());
        uint256 e = vault.currentEpoch() - 1;
        mallory.doCall(
            address(vault), abi.encodeCall(ConvergeVault.claimDeposit, (e, address(mallory)))
        );
        uint256 shares = vault.balanceOf(address(mallory));
        assertGt(shares, 0);
        mallory.doCall(address(vault), abi.encodeCall(ConvergeVault.requestRedeem, (shares)));
        uint256 e2 = vault.currentEpoch();
        _toEpochEnd(e2);
        vault.settleEpoch(e2, _noReports());
        mallory.set(_vaultOnly(m));
        mallory.doCall(
            address(vault), abi.encodeCall(ConvergeVault.claimRedeem, (e2, address(mallory)))
        );
        _assertBlocked("claimRedeem payout");
        assertGt(hook.balanceOf(address(mallory)), 90 * U); // it was paid, once
    }

    // ------------------------------------------------------------------ market

    function test_hook_duringMarketSplit() public {
        Market m = _market();
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(m));
        mallory.set(_marketAttacks(m));
        mallory.doCall(address(m), abi.encodeCall(Market.split, (10 * U)));
        _assertBlocked("Market.split");
        assertEq(m.up().balanceOf(address(mallory)), 10 * U);
        assertEq(m.down().balanceOf(address(mallory)), 10 * U);
    }

    function test_hook_duringMarketRedeemPayout() public {
        Market m = _market();
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(m));
        mallory.set(new Attacker.Call[](0));
        mallory.doCall(address(m), abi.encodeCall(Market.split, (10 * U)));
        vm.warp(T0 + M15 + 1);
        streamsResolver.submit(
            ETH, T0 + M15, _report(ETH_FEED, uint32(T0 + M15 - 1), uint32(T0 + M15 + 1), 3100e18)
        );
        vm.warp(T0 + M15 + WINDOW + 1);
        m.resolve("");
        mallory.set(_marketAttacks(m));
        mallory.doCall(address(m), abi.encodeCall(Market.redeem, ()));
        _assertBlocked("Market.redeem payout");
        assertEq(hook.balanceOf(address(mallory)), 100 * U); // paid once, not twice
    }

    function test_hook_duringMarketMerge() public {
        Market m = _market();
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(m));
        mallory.set(new Attacker.Call[](0));
        mallory.doCall(address(m), abi.encodeCall(Market.split, (10 * U)));
        mallory.set(_marketAttacks(m));
        mallory.doCall(address(m), abi.encodeCall(Market.merge, (10 * U)));
        _assertBlocked("Market.merge payout");
        assertEq(hook.balanceOf(address(mallory)), 100 * U);
    }

    // ------------------------------------------------------------------ venue

    function test_hook_duringPlaceOrderAndRefund() public {
        Market m = _market();
        _enableTrading(m, 100 * U);
        vm.deal(address(mallory), 1 ether);
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(venue));
        mallory.set(_venueAttacks(m));
        mallory.doCall{value: 0.001 ether}(
            address(venue),
            abi.encodeCall(ForwardVenue.placeOrder, (m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.7e18))
        );
        _assertBlocked("placeOrder escrow");
        (,,, uint64 at,,,,,) = venue.orders(1);
        vm.warp(at);
        // the refund and the reward both call mallory back: execute with mallory as the executor
        mallory.set(_venueAttacks(m));
        mallory.doCall(
            address(venue),
            abi.encodeCall(
                ForwardVenue.executeOrder, (1, _repWindow(at - 1, at + 1, 3000e18, at + 1 days))
            )
        );
        _assertBlocked("executeOrder refund and reward");
    }

    function test_nativeRewardCallbackDuringExpireOrder() public {
        Market m = _market();
        _enableTrading(m, 100 * U);
        uint256 id = _placeAs(taker, m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.7e18);
        (,,, uint64 at,,,,,) = venue.orders(id);
        vm.warp(at + 100);
        mallory.set(_venueAttacks(m));
        hook.setHooked(address(mallory), false); // only the ETH reward calls back here
        mallory.doCall(address(venue), abi.encodeCall(ForwardVenue.expireOrder, (id)));
        _assertBlocked("expireOrder reward");
    }

    // ------------------------------------------------------------------ registry

    function test_hook_duringRegistryBondAndWithdrawals() public {
        Market m = _market();
        hook.mint(address(mallory), 100 * U);
        mallory.approveAll(address(hook), address(reg));
        mallory.set(_registryAttacks(m));
        mallory.doCall(address(reg), abi.encodeCall(PartnerRegistry.postBond, (20 * U)));
        _assertBlocked("postBond");
        assertEq(reg.partnerOf(address(mallory)).bond, 20 * U);

        mallory.set(new Attacker.Call[](0));
        mallory.doCall(
            address(reg), abi.encodeCall(PartnerRegistry.requestBondWithdrawal, (20 * U))
        );
        vm.warp(block.timestamp + 8 days);
        mallory.set(_registryAttacks(m));
        mallory.doCall(
            address(reg), abi.encodeCall(PartnerRegistry.executeBondWithdrawal, (address(mallory)))
        );
        _assertBlocked("executeBondWithdrawal payout");
        assertEq(hook.balanceOf(address(mallory)), 100 * U);
    }

    // ------------------------------------------------------------------ cross-contract

    /// @dev Reentering a DIFFERENT contract is allowed by design (each has its own guard), so the
    ///      property is solvency: whatever the hostile hook does to the other contracts while one is
    ///      mid-call, no contract ends up owing more than it holds.
    function test_crossContract_hookDuringVaultDepositKeepsEverythingSolvent() public {
        Market m = _market();
        _enableTrading(m, 100 * U);
        vm.deal(address(mallory), 1 ether);
        hook.mint(address(mallory), 500 * U);
        mallory.approveAll(address(hook), address(vault));
        mallory.approveAll(address(hook), address(m));
        mallory.approveAll(address(hook), address(venue));
        mallory.approveAll(address(hook), address(reg));
        mallory.set(_concat(_marketAttacks(m), _concat(_venueAttacks(m), _registryAttacks(m))));
        mallory.doCall(address(vault), abi.encodeCall(ConvergeVault.requestDeposit, (20 * U)));
        assertEq(mallory.attempts() > 0, true);
        _assertSolvent(m);
    }

    function test_crossContract_hookDuringMarketSplitKeepsEverythingSolvent() public {
        Market m = _market();
        _enableTrading(m, 100 * U);
        vm.deal(address(mallory), 1 ether);
        hook.mint(address(mallory), 500 * U);
        mallory.approveAll(address(hook), address(vault));
        mallory.approveAll(address(hook), address(m));
        mallory.approveAll(address(hook), address(venue));
        mallory.approveAll(address(hook), address(reg));
        mallory.set(_concat(_vaultAttacks(m), _concat(_venueAttacks(m), _registryAttacks(m))));
        mallory.doCall(address(m), abi.encodeCall(Market.split, (10 * U)));
        assertEq(mallory.attempts() > 0, true);
        _assertSolvent(m);
    }

    function test_crossContract_hookDuringExecutionKeepsEverythingSolvent() public {
        Market m = _market();
        _enableTrading(m, 100 * U);
        vm.deal(address(mallory), 1 ether);
        hook.mint(address(mallory), 500 * U);
        mallory.approveAll(address(hook), address(vault));
        mallory.approveAll(address(hook), address(m));
        mallory.approveAll(address(hook), address(venue));
        mallory.approveAll(address(hook), address(reg));
        mallory.set(new Attacker.Call[](0));
        mallory.doCall{value: 0.001 ether}(
            address(venue),
            abi.encodeCall(ForwardVenue.placeOrder, (m, ForwardVenue.Kind.BUY_UP, 2 * U, 0.7e18))
        );
        (,,, uint64 at,,,,,) = venue.orders(1);
        vm.warp(at);
        mallory.set(_concat(_marketAttacks(m), _registryAttacks(m)));
        mallory.doCall(
            address(venue),
            abi.encodeCall(
                ForwardVenue.executeOrder, (1, _repWindow(at - 1, at + 1, 3000e18, at + 1 days))
            )
        );
        assertEq(mallory.attempts() > 0, true);
        _assertSolvent(m);
    }
}
