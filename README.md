# Gelato Relay Integration Guide

Build gasless transactions with Gelato Relay. This repo covers:

- **Meta-Transactions (ERC-2771)** - Users sign, relayers pay gas
- **ERC-20 Fee Payments** - Users pay fees in tokens (USDC, etc.)

## 🚨 For Existing Customers

Gelato is deprecating legacy patterns. This repo provides migration guides for:

| Legacy Pattern | New Approach | Migration Guide |
|----------------|--------------|-----------------|
| **Old Trusted Forwarder** | New ERC-2771 Forwarder | [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) |
| **SyncFee / `GelatoRelayContext`** | Direct ERC-20 Transfer | [ERC20_FEE_PAYMENT.md](./ERC20_FEE_PAYMENT.md) |

**Quick Start:** [MIGRATION_QUICK_REFERENCE.md](./MIGRATION_QUICK_REFERENCE.md)

## 📋 For New Integrations

Choose your implementation approach:
- **Trusted Forwarder** - External contract handles signatures ([Jump to](#trusted-forwarder-approach))
- **Direct Integration** - Your contract handles signatures ([Jump to](#direct-integration-approach))

## 💰 Paying with ERC-20 Tokens

Want users to pay for their own transactions with ERC-20 tokens instead of sponsoring them?

**New method:** Call Gelato API to get `feeCollector` and `fee`, then transfer tokens directly. No contract inheritance needed!

See **[ERC20_FEE_PAYMENT.md](./ERC20_FEE_PAYMENT.md)** for:
- Complete implementation guide
- Permit (EIP-2612) for gasless approvals
- Migration from old `SyncFee` / `GelatoRelayContext` pattern

---

## Table of Contents

1. [Trusted Forwarder Approach](#trusted-forwarder-approach)
2. [Direct Integration Approach](#direct-integration-approach)
3. [Testing](#testing)
4. [Project Structure](#project-structure)

## Overview

**Meta-transactions** = Users sign messages, relayers pay gas fees.

### Two Implementation Approaches

| Approach | Description | Best For |
|----------|-------------|----------|
| **Trusted Forwarder** | External contract verifies signatures | Most use cases, upgradeable contracts |
| **Direct Integration** | Your contract verifies signatures | Self-contained contracts |

### Two Execution Modes

| Mode | Replay Protection | Concurrency | Best For |
|------|------------------|-------------|----------|
| **Sequential** | Nonce (0, 1, 2...) | No | Simple operations |
| **Concurrent** | Random salt | Yes | Batch operations |

---

## Trusted Forwarder Approach

**Architecture:** Deploy separate forwarder → Your contract trusts it → Minimal changes

### 1. Deploy Forwarder

```bash
# Sequential (nonce-based)
npx hardhat deploy --tags TrustedForwarder

# Concurrent (hash-based)
npx hardhat deploy --tags TrustedForwarderConcurrent
```

### 2. Update Your Contract

```solidity
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract YourContract is ERC2771Context {
    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {}
    
    function yourFunction() external {
        address user = _msgSender();  // Gets real user, not relayer
        // Your logic
    }
}
```

**Changes needed:**
- Inherit `ERC2771Context`
- Pass forwarder address to constructor  
- Use `_msgSender()` instead of `msg.sender`

### 3. Frontend Integration

```typescript
// 1. Sign EIP-712 message for FORWARDER
const domain = {
  name: "TrustedForwarder",  // or "TrustedForwarderConcurrentERC2771"
  version: "1",
  chainId: await signer.getChainId(),
  verifyingContract: forwarderAddress  // Forwarder, not your contract!
};

const types = {
  SponsoredCallERC2771: [
    { name: "chainId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "user", type: "address" },
    { name: "userNonce", type: "uint256" },        // Sequential
    // { name: "userSalt", type: "bytes32" },      // Concurrent
    { name: "userDeadline", type: "uint256" }
  ]
};

const nonce = await forwarder.userNonce(userAddress);  // From forwarder
const message = {
  chainId: await signer.getChainId(),
  target: yourContractAddress,
  data: yourContract.interface.encodeFunctionData("yourFunction", []),
  user: userAddress,
  userNonce: nonce,
  userDeadline: 0
};

const signature = await signer.signTypedData(domain, types, message);

// 2. Send to Gelato
await gelatoRelay.sponsoredCall({
  target: forwarderAddress,  // Call forwarder, not your contract
  data: forwarder.interface.encodeFunctionData("sponsoredCallERC2771", [
    message, signature, /* other params */
  ])
});
```

**Examples:**
- Sequential: `contracts/SimpleCounterTrusted.sol` + `scripts/testSponsoredCallTrusted.ts`
- Concurrent: `contracts/SimpleCounterTrustedConcurrent.sol` + `scripts/testSponsoredCallTrustedConcurrent.ts`

---

## Direct Integration Approach

**Architecture:** No external contracts → Your contract handles everything

### 1. Update Contract Code

**Sequential mode:**
```solidity
import "./lib/EIP712MetaTransaction.sol";

contract YourContract is EIP712MetaTransaction("YourContract", "1") {
    function yourFunction() external {
        address user = msgSender();  // NO underscore!
        // Your logic
    }
}
```

**Concurrent mode:**
```solidity
import "./lib/EIP712HASHMetaTransaction.sol";

contract YourContract is EIP712HASHMetaTransaction("YourContract", "1") {
    function yourFunction() external {
        address user = msgSender();  // NO underscore!
        // Your logic
    }
}
```

**Changes needed:**
- Inherit `EIP712MetaTransaction` or `EIP712HASHMetaTransaction`
- Pass contract name and version
- Use `msgSender()` (no underscore!) instead of `msg.sender`

### 2. Frontend Integration

```typescript
// 1. Sign EIP-712 message for YOUR CONTRACT
const domain = {
  name: "YourContract",                     // Your contract name
  version: "1",
  verifyingContract: yourContractAddress,   // YOUR contract!
  salt: ethers.zeroPadValue(ethers.toBeHex(chainId), 32)  // Sequential
  // chainId: chainId                       // Concurrent
};

const types = {
  MetaTransaction: [
    { name: "nonce", type: "uint256" },              // Sequential
    // { name: "userSalt", type: "bytes32" },        // Concurrent
    { name: "from", type: "address" },
    { name: "functionSignature", type: "bytes" }
    // { name: "deadline", type: "uint256" }         // Concurrent
  ]
};

const nonce = await yourContract.getNonce(userAddress);  // From YOUR contract
const message = {
  nonce: nonce,
  from: userAddress,
  functionSignature: yourContract.interface.encodeFunctionData("yourFunction", [])
};

const signature = await signer.signTypedData(domain, types, message);
const { r, s, v } = ethers.Signature.from(signature);  // Sequential only

// 2. Send to Gelato
await gelatoRelay.sponsoredCall({
  target: yourContractAddress,  // Call YOUR contract
  data: yourContract.interface.encodeFunctionData("executeMetaTransaction",
    // Sequential:
    [userAddress, functionData, r, s, v]
    // Concurrent:
    // [userAddress, functionData, userSalt, deadline, signature]
  )
});
```

**Examples:**
- Sequential: `contracts/SimpleCounter.sol` + `scripts/testSponsoredCall.ts`
- Concurrent: `contracts/SimpleCounterHash.sol` + `scripts/testSponsoredCallHash.ts`

---

## Quick Comparison

| | Trusted Forwarder | Direct Integration |
|---|---|---|
| **Contract changes** | Minimal | Moderate |
| **External contracts** | Yes (forwarder) | No |
| **Sign for** | Forwarder | Your contract |
| **Best for** | Most use cases | Self-contained apps |
| **Contract function** | `_msgSender()` | `msgSender()` |

## Testing

```bash
# Install dependencies
npm install

# Run all tests
npx hardhat test

# Test specific implementation
npx hardhat test test/SimpleCounterTrusted.ts              # Forwarder Sequential
npx hardhat test test/SimpleCounterTrustedConcurrent.ts    # Forwarder Concurrent
npx hardhat test test/SimpleCounter.ts                     # Direct Sequential
npx hardhat test test/SimpleCounterHash.ts                 # Direct Concurrent

# Test with Gelato (requires .env with GELATO_RELAY_API_KEY)
npx ts-node scripts/testSponsoredCallTrusted.ts
npx ts-node scripts/testSponsoredCallTrustedConcurrent.ts
npx ts-node scripts/testSponsoredCall.ts
npx ts-node scripts/testSponsoredCallHash.ts
npx ts-node scripts/testERC20FeePayment.ts           # ERC20 fee payment with permit
```

### Environment Setup

1. Copy the example environment file:
```bash
cp .env-example .env
```

2. Fill in your credentials in `.env`:
```env
# Required: Your wallet private key for signing transactions
PRIVATE_KEY=your_private_key_here

# Required: Gelato API key for relay services
# Get yours at: https://app.gelato.cloud
GELATO_API_KEY=your_gelato_api_key_here


**Where to get these:**
- **PRIVATE_KEY**: Export from your wallet (MetaMask: Account Details → Export Private Key)
- **GELATO_API_KEY**: Sign up at [app.gelato.network](https://app.gelato.cloud) and create an API key

## Project Structure

```
contracts/
├── trustedForwarders/
│   ├── TrusteForwarderERC2771.sol           # Trusted Forwarder - Sequential
│   └── TrustedForwarderConcurrentERC2771.sol # Trusted Forwarder - Concurrent
├── lib/
│   ├── EIP712MetaTransaction.sol            # Direct Integration - Sequential
│   └── EIP712HASHMetaTransaction.sol        # Direct Integration - Concurrent
├── mocks/
│   └── MockERC20Permit.sol                  # Mock token for testing
├── SimpleCounterTrusted.sol                 # Example: Forwarder Sequential
├── SimpleCounterTrustedConcurrent.sol       # Example: Forwarder Concurrent
├── SimpleCounter.sol                        # Example: Direct Sequential
├── SimpleCounterHash.sol                    # Example: Direct Concurrent
└── SimpleCounterERC20Fee.sol                # Example: ERC20 Fee Payment

scripts/
├── testSponsoredCallTrusted.ts              # Gelato: Forwarder Sequential
├── testSponsoredCallTrustedConcurrent.ts    # Gelato: Forwarder Concurrent
├── testSponsoredCall.ts                     # Gelato: Direct Sequential
├── testSponsoredCallHash.ts                 # Gelato: Direct Concurrent
└── testERC20FeePayment.ts                   # Gelato: ERC20 Fee with Permit

test/
├── SimpleCounterTrusted.ts
├── SimpleCounterTrustedConcurrent.ts
├── SimpleCounter.ts
├── SimpleCounterHash.ts
└── SimpleCounterERC20Fee.ts                # ERC20 Fee Payment tests
```

---

## Documentation

- **[MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)** - For existing customers migrating from old forwarder
- **[MIGRATION_QUICK_REFERENCE.md](./MIGRATION_QUICK_REFERENCE.md)** - Quick migration checklist
- **[ERC20_FEE_PAYMENT.md](./ERC20_FEE_PAYMENT.md)** - Pay for transactions with ERC-20 tokens
- **README.md** - This file (technical overview)

---

## Support

- 📖 [Gelato Docs](https://docs.gelato.network)
- 💬 [Discord](https://discord.gg/gelato)
- 🔑 [Get API Key](https://app.gelato.network)
