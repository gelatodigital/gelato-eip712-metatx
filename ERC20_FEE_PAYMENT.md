# Paying for Transactions with ERC-20 Tokens

This guide explains how to pay for relayed transactions using ERC-20 tokens instead of having a sponsor pay via Gas Tank.

## Overview

Gelato Relay supports two payment models:

| Payment Model | Who Pays | How It Works |
|---------------|----------|--------------|
| **Sponsored (Gas Tank)** | Developer | Pre-fund Gas Tank, use API key |
| **ERC-20 Token** | User | User transfers fee to Gelato's fee collector |

---

## New Method vs Old Method

### Old Method: SyncFeePayment (Deprecated)

The old approach required:
1. **Contract inheritance** from `GelatoRelayContext`
2. **Fee data encoded in calldata** - Gelato appended `fee`, `feeToken`, and `feeCollector` to the calldata
3. **On-chain fee extraction** - Contract called `_transferRelayFee()` to decode and transfer fees

```solidity
// OLD WAY - Required contract changes
contract MyContract is GelatoRelayContext {
    function myFunction() external onlyGelatoRelay {
        // Your logic here

        // Extract fee from calldata and transfer to Gelato
        _transferRelayFee();
    }
}
```

**Problems with old method:**
- Required inheriting from Gelato contracts
- Contract had to handle fee transfer logic
- More complex contract code

### New Method: Direct Transfer (Recommended)

The new approach is simpler:
1. **Call API endpoints** to get fee collector address and fee quote
2. **Include token transfer** in your transaction to the fee collector
3. **No contract inheritance needed** - your contract stays clean

**Benefits:**
- No special contract inheritance required
- Simpler contract code
- More flexibility in fee handling
- Works with any existing contract

---

## Implementation Guide

### Step 1: Get Fee Collector and Supported Tokens

Call `relayer_getCapabilities` to get the fee collector address and supported tokens for your chain.

**Request:**
```bash
curl -X POST https://api.gelato.cloud/rpc \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "id": 1,
    "jsonrpc": "2.0",
    "method": "relayer_getCapabilities",
    "params": ["84532"]
  }'
```

**Response:**
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "84532": {
      "feeCollector": "0x55f3a93f544e01ce4378d25e927d7c493b863bd6",
      "tokens": [
        {
          "address": "0x0000000000000000000000000000000000000000",
          "decimals": 18
        },
        {
          "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "decimals": 6
        }
      ]
    }
  }
}
```

### Step 2: Get Fee Quote

Call `relayer_getFeeData` to get the current fee quote for your chosen payment token.

**Request:**
```bash
curl -X POST https://api.gelato.cloud/rpc \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "id": 1,
    "jsonrpc": "2.0",
    "method": "relayer_getFeeData",
    "params": [84532, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"]
  }'
```

**Response:**
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "exchangeRate": "1000000000000000000",
    "gasPrice": "1000000000",
    "quoteExpiry": 1702656000
  }
}
```

### Step 3: Include Fee Transfer in Transaction

Your transaction must include a transfer of the fee token to the fee collector. This can be done in two ways:

#### Option A: Multicall (Recommended for Meta-Transactions)

Bundle the fee transfer with your main transaction:

```typescript
import { ethers } from "ethers";

// ERC20 interface for transfer
const erc20Abi = ["function transfer(address to, uint256 amount) returns (bool)"];
const feeToken = new ethers.Contract(FEE_TOKEN_ADDRESS, erc20Abi, signer);

// Your main contract
const myContract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, signer);

// 1. Encode fee transfer
const feeTransferData = feeToken.interface.encodeFunctionData("transfer", [
  feeCollector,  // From relayer_getCapabilities
  feeAmount      // Calculated from relayer_getFeeData
]);

// 2. Encode your main transaction
const mainTxData = myContract.interface.encodeFunctionData("yourFunction", [
  /* your params */
]);

// 3. Use multicall or batch these transactions
```

#### Option B: Contract Handles Transfer (with Permit)

**Recommended:** Use EIP-2612 permit for gasless token approvals. The user signs a permit off-chain, and your contract executes the approval + transfer atomically.

```solidity
// contracts/SimpleCounterERC20Fee.sol
contract SimpleCounterERC20Fee is ERC2771Context {
    function incrementWithPermit(
        address feeToken,
        address feeCollector,
        uint256 fee,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        address user = _msgSender();

        // Execute permit (gasless approval)
        IERC20Permit(feeToken).permit(user, address(this), fee, deadline, v, r, s);

        // Transfer fee from user to Gelato's fee collector
        IERC20(feeToken).transferFrom(user, feeCollector, fee);

        // Execute the actual operation
        counter++;
    }
}
```

#### Option C: Contract Handles Transfer (with prior approval)

If permit is not supported by the token, require prior approval:

```solidity
function incrementWithFee(
    address feeToken,
    address feeCollector,
    uint256 fee
) external {
    address user = _msgSender();

    // Requires user to have approved this contract beforehand
    IERC20(feeToken).transferFrom(user, feeCollector, fee);

    // Execute the actual operation
    counter++;
}
```

### Step 4: Submit Transaction

Submit the signed transaction to Gelato Relay with ERC-20 payment type:

**Request:**
```bash
curl -X POST https://api.gelato.cloud/rpc \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "id": 1,
    "jsonrpc": "2.0",
    "method": "relayer_sendTransaction",
    "params": [
      84532,
      "0xSIGNED_TRANSACTION_DATA",
      {
        "type": "token",
        "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      }
    ]
  }'
```

**Response:**
```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "result": {
    "taskId": "0x1234567890abcdef...",
    "status": "submitted"
  }
}
```

---

## Complete TypeScript Example

```typescript
import { ethers } from "ethers";

const GELATO_RPC = "https://api.gelato.cloud/rpc";
const API_KEY = process.env.GELATO_RELAY_API_KEY!;

interface Capabilities {
  feeCollector: string;
  tokens: { address: string; decimals: number }[];
}

interface FeeData {
  exchangeRate: string;
  gasPrice: string;
  quoteExpiry: number;
}

// Step 1: Get capabilities
async function getCapabilities(chainId: number): Promise<Capabilities> {
  const response = await fetch(GELATO_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "relayer_getCapabilities",
      params: [chainId.toString()],
    }),
  });

  const data = await response.json();
  return data.result[chainId.toString()];
}

// Step 2: Get fee data
async function getFeeData(chainId: number, tokenAddress: string): Promise<FeeData> {
  const response = await fetch(GELATO_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "relayer_getFeeData",
      params: [chainId, tokenAddress],
    }),
  });

  const data = await response.json();
  return data.result;
}

// Step 3: Calculate fee amount
function calculateFee(
  estimatedGas: bigint,
  gasPrice: string,
  exchangeRate: string
): bigint {
  const gasCost = estimatedGas * BigInt(gasPrice);
  // Add buffer for safety (e.g., 20%)
  const gasCostWithBuffer = (gasCost * 120n) / 100n;
  // Convert to token amount using exchange rate
  return (gasCostWithBuffer * BigInt(exchangeRate)) / BigInt(10 ** 18);
}

// Full example
async function relayWithERC20Payment() {
  const chainId = 84532; // Base Sepolia
  const feeTokenAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC

  // Get fee collector and verify token is supported
  const capabilities = await getCapabilities(chainId);
  console.log("Fee Collector:", capabilities.feeCollector);

  const supportedToken = capabilities.tokens.find(
    t => t.address.toLowerCase() === feeTokenAddress.toLowerCase()
  );
  if (!supportedToken) {
    throw new Error("Token not supported for fee payment");
  }

  // Get current fee quote
  const feeData = await getFeeData(chainId, feeTokenAddress);
  console.log("Fee Quote Expires:", new Date(feeData.quoteExpiry * 1000));

  // Estimate gas for your transaction (example: 100,000 gas)
  const estimatedGas = 100000n;
  const feeAmount = calculateFee(
    estimatedGas,
    feeData.gasPrice,
    feeData.exchangeRate
  );
  console.log("Fee Amount:", feeAmount.toString());

  // Now include a transfer of `feeAmount` to `capabilities.feeCollector`
  // in your transaction before submitting to Gelato
}

relayWithERC20Payment();
```

---

## Complete Example with Permit (Recommended)

This example shows the full flow: user signs a permit for gasless approval, and the transaction is relayed with ERC20 fee payment.

### Smart Contract

See `contracts/SimpleCounterERC20Fee.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

contract SimpleCounterERC20Fee is ERC2771Context {
    uint256 public counter;

    event IncrementCounter(address indexed user, uint256 newCounterValue, uint256 timestamp);
    event FeePaid(address indexed user, address indexed feeToken, address indexed feeCollector, uint256 fee);

    constructor(address _trustedForwarder) ERC2771Context(_trustedForwarder) {}

    /**
     * @notice Increment counter with ERC20 fee payment using permit (gasless approval)
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
        address user = _msgSender();

        // Execute permit to approve this contract to spend user's tokens
        IERC20Permit(feeToken).permit(user, address(this), fee, deadline, v, r, s);

        // Transfer fee from user to Gelato's fee collector
        IERC20(feeToken).transferFrom(user, feeCollector, fee);

        emit FeePaid(user, feeToken, feeCollector, fee);

        // Execute the actual operation
        counter++;
        emit IncrementCounter(user, counter, block.timestamp);
    }
}
```

### Frontend Script

See `scripts/testERC20FeePayment.ts` for the complete implementation. Key steps:

```typescript
import { GelatoRelay, SponsoredCallRequest } from "@gelatonetwork/relay-sdk";
import { ethers } from "ethers";

// Step 1: Get fee collector from Gelato API
const capabilities = await getCapabilities(chainId);
const feeCollector = capabilities.feeCollector;

// Step 2: Get fee quote
const feeData = await getFeeData(chainId, FEE_TOKEN_ADDRESS);
const fee = calculateFee(estimatedGas, feeData.gasPrice, feeData.exchangeRate);

// Step 3: Sign EIP-2612 permit (gasless approval)
async function signPermit(signer, tokenAddress, spender, value, deadline) {
  const domain = {
    name: await token.name(),
    version: "1",
    chainId: chainId,
    verifyingContract: tokenAddress,
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner: signer.address,
    spender: spender,
    value: value,
    nonce: await token.nonces(signer.address),
    deadline: deadline,
  };

  const signature = await signer.signTypedData(domain, types, message);
  return ethers.Signature.from(signature);
}

const deadline = Math.floor(Date.now() / 1000) + 3600;
const { v, r, s } = await signPermit(signer, FEE_TOKEN_ADDRESS, CONTRACT_ADDRESS, fee, deadline);

// Step 4: Encode transaction with permit parameters
const txData = contract.interface.encodeFunctionData("incrementWithPermit", [
  FEE_TOKEN_ADDRESS,
  feeCollector,
  fee,
  deadline,
  v,
  r,
  s,
]);

// Step 5: Submit to Gelato Relay
const request: SponsoredCallRequest = {
  chainId: BigInt(chainId),
  target: CONTRACT_ADDRESS,
  data: txData,
};

const response = await relay.sponsoredCall(request, GELATO_RELAY_API_KEY);
console.log(`Task ID: ${response.taskId}`);
```

### Run the Example

```bash
# Deploy the contract first
npx hardhat deploy --tags SimpleCounterERC20Fee

# Update the contract address in the script, then run:
npx ts-node scripts/testERC20FeePayment.ts
```

---

## API Reference

### Base URLs

| Environment | URL |
|-------------|-----|
| Mainnet | `https://api.gelato.cloud/rpc` |
| Testnet | `https://api.t.gelato.cloud/rpc` |

### Methods

| Method | Description |
|--------|-------------|
| `relayer_getCapabilities` | Get supported tokens and fee collector per chain |
| `relayer_getFeeData` | Get fee quote with exchange rate |
| `relayer_sendTransaction` | Submit transaction for relay |
| `relayer_sendTransactionSync` | Submit and wait for confirmation |
| `relayer_getStatus` | Check transaction status |

### Transaction Status Codes

| Code | Status |
|------|--------|
| 100 | Pending |
| 110 | Submitted |
| 200 | Included (confirmed) |
| 400 | Rejected |
| 500 | Reverted |

---

## Migration from SyncFeePayment

If you're migrating from the old `callWithSyncFee` method:

| Old (SyncFeePayment) | New (Direct Transfer) |
|---------------------|----------------------|
| Inherit `GelatoRelayContext` | No inheritance needed |
| Call `_transferRelayFee()` | Transfer to fee collector directly |
| Fee encoded in calldata | Fee from API endpoints |
| `onlyGelatoRelay` modifier | Not required |

### Migration Steps

1. **Remove** `GelatoRelayContext` inheritance from your contracts
2. **Remove** `_transferRelayFee()` calls
3. **Remove** `onlyGelatoRelay` modifiers (unless needed for other reasons)
4. **Update frontend** to:
   - Call `relayer_getCapabilities` to get fee collector
   - Call `relayer_getFeeData` to get fee quote
   - Include fee transfer in transaction
5. **Redeploy** your simplified contracts

---

## Support

- [Gelato Docs](https://docs.gelato.network)
- [Discord](https://discord.gg/gelato)
- [Get API Key](https://app.gelato.network)
