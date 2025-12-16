// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title SimpleCounterERC20Fee
 * @notice A counter that accepts ERC20 fee payments for relayed transactions
 * @dev Users pay for relay fees in ERC20 tokens instead of native currency.
 *
 * This demonstrates the NEW way to pay for Gelato Relay transactions:
 * - No need to inherit from GelatoRelayContext (old SyncFee method)
 * - Frontend gets feeCollector and fee from Gelato API
 * - Contract simply transfers the fee to the collector
 *
 * Supports two token transfer methods:
 * 1. permit() - Gasless approval via EIP-2612 signature (recommended)
 * 2. transferFrom() - Requires prior approval transaction
 */
contract SimpleCounterERC20Fee is ERC2771Context {
    uint256 public counter;

    event IncrementCounter(
        address indexed user,
        uint256 newCounterValue,
        uint256 timestamp
    );

    event FeePaid(
        address indexed user,
        address indexed feeToken,
        address indexed feeCollector,
        uint256 fee
    );

    error FeeTransferFailed();
    error InvalidFeeCollector();
    error InvalidFeeToken();

    constructor(address _trustedForwarder) ERC2771Context(_trustedForwarder) {}

    /**
     * @notice Increment counter with ERC20 fee payment using permit (gasless approval)
     * @param feeToken The ERC20 token used to pay the fee
     * @param feeCollector The address to receive the fee (from Gelato API)
     * @param fee The fee amount (from Gelato API)
     * @param deadline The permit signature deadline
     * @param v The permit signature v component
     * @param r The permit signature r component
     * @param s The permit signature s component
     */
    function incrementWithPermit(
        address feeToken,
        address feeCollector,
        uint256 fee,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (feeCollector == address(0)) revert InvalidFeeCollector();
        if (feeToken == address(0)) revert InvalidFeeToken();

        address user = _msgSender();

        // Execute permit to approve this contract to spend user's tokens
        IERC20Permit(feeToken).permit(user, address(this), fee, deadline, v, r, s);

        // Transfer fee from user to Gelato's fee collector
        bool success = IERC20(feeToken).transferFrom(user, feeCollector, fee);
        if (!success) revert FeeTransferFailed();

        emit FeePaid(user, feeToken, feeCollector, fee);

        // Execute the actual operation
        counter++;
        emit IncrementCounter(user, counter, block.timestamp);
    }

    /**
     * @notice Increment counter with ERC20 fee payment (requires prior approval)
     * @param feeToken The ERC20 token used to pay the fee
     * @param feeCollector The address to receive the fee (from Gelato API)
     * @param fee The fee amount (from Gelato API)
     */
    function incrementWithFee(
        address feeToken,
        address feeCollector,
        uint256 fee
    ) external {
        if (feeCollector == address(0)) revert InvalidFeeCollector();
        if (feeToken == address(0)) revert InvalidFeeToken();

        address user = _msgSender();

        // Transfer fee from user to Gelato's fee collector
        // Requires user to have approved this contract beforehand
        bool success = IERC20(feeToken).transferFrom(user, feeCollector, fee);
        if (!success) revert FeeTransferFailed();

        emit FeePaid(user, feeToken, feeCollector, fee);

        // Execute the actual operation
        counter++;
        emit IncrementCounter(user, counter, block.timestamp);
    }

    /**
     * @notice Standard increment (for sponsored/gas tank payments)
     */
    function increment() external {
        counter++;
        emit IncrementCounter(_msgSender(), counter, block.timestamp);
    }
}
