import hre, { deployments, ethers } from "hardhat";
import { expect } from "chai";
import { SimpleCounterERC20Fee, TrustedForwarderERC2771, MockERC20Permit } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// =============================================================================
// Gelato API Helper Functions
// These demonstrate how to get fee information from the real Gelato API
// =============================================================================

const GELATO_RPC = "https://api.gelato.cloud/rpc";

// Real chain and token for demonstrating API calls
const BASE_SEPOLIA_CHAIN_ID = 84532;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

interface Capabilities {
  feeCollector: string;
  tokens: { address: string; decimals: number }[];
}

interface FeeData {
  exchangeRate: string;
  gasPrice: string;
  quoteExpiry: number;
}

/**
 * Get fee collector and supported tokens from Gelato API
 * @param chainId - The chain ID to query
 * @param apiKey - Optional API key (not required for getCapabilities)
 */
async function getCapabilities(chainId: number, apiKey?: string): Promise<Capabilities | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const response = await fetch(GELATO_RPC, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "relayer_getCapabilities",
        params: [chainId.toString()],
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.log(`      API Error: ${JSON.stringify(data.error)}`);
      return null;
    }
    if (!data.result || !data.result[chainId.toString()]) {
      console.log(`      No capabilities found for chain ${chainId}`);
      return null;
    }
    return data.result[chainId.toString()];
  } catch (error) {
    console.log(`      Failed to fetch capabilities: ${error}`);
    return null;
  }
}

/**
 * Get fee quote from Gelato API
 * @param chainId - The chain ID
 * @param tokenAddress - The payment token address
 * @param apiKey - Optional API key
 */
async function getFeeData(chainId: number, tokenAddress: string, apiKey?: string): Promise<FeeData | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-Key"] = apiKey;

    const response = await fetch(GELATO_RPC, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "relayer_getFeeData",
        params: [chainId, tokenAddress],
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.log(`      API Error: ${JSON.stringify(data.error)}`);
      return null;
    }
    if (!data.result) {
      console.log(`      No fee data returned`);
      return null;
    }
    return data.result;
  } catch (error) {
    console.log(`      Failed to fetch fee data: ${error}`);
    return null;
  }
}

/**
 * Calculate fee amount based on estimated gas and fee data
 * @param estimatedGas - Estimated gas for the transaction
 * @param gasPrice - Current gas price from getFeeData
 * @param exchangeRate - Token exchange rate from getFeeData
 * @param bufferPercent - Safety buffer percentage (default 50%)
 */
function calculateFee(
  estimatedGas: bigint,
  gasPrice: string,
  exchangeRate: string,
  bufferPercent: number = 50
): bigint {
  const gasCost = estimatedGas * BigInt(gasPrice);
  // Add buffer for safety margin
  const gasCostWithBuffer = (gasCost * BigInt(100 + bufferPercent)) / BigInt(100);
  // Convert to token amount using exchange rate (rate is in 18 decimals)
  const fee = (gasCostWithBuffer * BigInt(exchangeRate)) / BigInt(10 ** 18);
  return fee;
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Test SimpleCounterERC20Fee with ERC20 Fee Payment", function () {
  let simpleCounterERC20Fee: SimpleCounterERC20Fee;
  let trustedForwarder: TrustedForwarderERC2771;
  let mockToken: MockERC20Permit;
  let user: SignerWithAddress;
  let relayer: SignerWithAddress;
  let feeCollector: SignerWithAddress;
  let userAddress: string;
  let feeCollectorAddress: string;
  let contractAddress: string;
  let tokenAddress: string;

  // Fee amount used in tests - we'll calculate this from API in one test
  let FEE_AMOUNT: bigint;

  beforeEach("setup", async function () {
    if (hre.network.name !== "hardhat") {
      console.error("Test Suite is meant to be run on hardhat only");
      process.exit(1);
    }

    // Default fee amount (will be overridden in API test)
    FEE_AMOUNT = ethers.parseUnits("1", 6); // 1 USDC (6 decimals)

    [user, relayer, feeCollector] = await hre.ethers.getSigners();
    userAddress = await user.getAddress();
    feeCollectorAddress = await feeCollector.getAddress();

    // Deploy TrustedForwarder
    await deployments.fixture(["TrustedForwarder"]);
    const trustedForwarderAddress = (await deployments.get("TrustedForwarderERC2771")).address;
    trustedForwarder = (await hre.ethers.getContractAt(
      "TrustedForwarderERC2771",
      trustedForwarderAddress
    )) as TrustedForwarderERC2771;

    // Deploy MockERC20Permit (simulating USDC with permit)
    const MockERC20PermitFactory = await hre.ethers.getContractFactory("MockERC20Permit");
    mockToken = (await MockERC20PermitFactory.deploy(
      "Mock USDC",
      "USDC",
      6
    )) as MockERC20Permit;
    await mockToken.waitForDeployment();
    tokenAddress = await mockToken.getAddress();

    // Deploy SimpleCounterERC20Fee
    const SimpleCounterERC20FeeFactory = await hre.ethers.getContractFactory("SimpleCounterERC20Fee");
    simpleCounterERC20Fee = (await SimpleCounterERC20FeeFactory.deploy(
      trustedForwarderAddress
    )) as SimpleCounterERC20Fee;
    await simpleCounterERC20Fee.waitForDeployment();
    contractAddress = await simpleCounterERC20Fee.getAddress();

    // Mint tokens to user
    await mockToken.mint(userAddress, ethers.parseUnits("1000", 6));
  });

  // ===========================================================================
  // Gelato API Integration Test
  // ===========================================================================
  describe("Gelato API Integration", function () {
    it("#0: should demonstrate fee calculation using real Gelato API", async function () {
      console.log("\n      --- Fetching fee data from Gelato API (Base Sepolia) ---");

      // Step 1: Get capabilities (fee collector and supported tokens)
      console.log(`      Calling relayer_getCapabilities for chain ${BASE_SEPOLIA_CHAIN_ID}...`);
      const capabilities = await getCapabilities(BASE_SEPOLIA_CHAIN_ID);

      if (!capabilities) {
        console.log("      Skipping API test - could not fetch capabilities");
        this.skip();
        return;
      }

      console.log(`      Fee Collector: ${capabilities.feeCollector}`);
      console.log(`      Supported Tokens: ${capabilities.tokens.length}`);

      // Find USDC in supported tokens
      const usdcToken = capabilities.tokens.find(
        (t) => t.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase()
      );

      if (!usdcToken) {
        console.log(`      USDC (${USDC_BASE_SEPOLIA}) not found in supported tokens`);
        console.log(`      Available tokens: ${JSON.stringify(capabilities.tokens)}`);
        this.skip();
        return;
      }

      console.log(`      USDC Token: ${usdcToken.address} (${usdcToken.decimals} decimals)`);

      // Step 2: Get fee data (exchange rate and gas price)
      console.log(`      Calling relayer_getFeeData for USDC...`);
      const feeData = await getFeeData(BASE_SEPOLIA_CHAIN_ID, USDC_BASE_SEPOLIA);

      if (!feeData) {
        console.log("      Skipping API test - could not fetch fee data");
        this.skip();
        return;
      }

      console.log(`      Exchange Rate: ${feeData.exchangeRate}`);
      console.log(`      Gas Price: ${feeData.gasPrice}`);
      console.log(`      Quote Expires: ${new Date(feeData.quoteExpiry * 1000).toISOString()}`);

      // Step 3: Calculate fee for estimated gas
      const estimatedGas = BigInt(150000); // Estimated gas for incrementWithPermit
      const calculatedFee = calculateFee(
        estimatedGas,
        feeData.gasPrice,
        feeData.exchangeRate,
        50 // 50% buffer
      );

      console.log(`      Estimated Gas: ${estimatedGas}`);
      console.log(`      Calculated Fee: ${calculatedFee} (${ethers.formatUnits(calculatedFee, 6)} USDC)`);
      console.log("      --- End of API demonstration ---\n");

      // Use this calculated fee for the actual test
      // (Note: We use mock token, but fee calculation matches real API)
      FEE_AMOUNT = calculatedFee > BigInt(0) ? calculatedFee : ethers.parseUnits("0.01", 6);

      // Now perform a real transaction with the API-calculated fee
      await mockToken.connect(user).approve(contractAddress, FEE_AMOUNT);

      const initCounter = await simpleCounterERC20Fee.counter();
      const initBalance = await mockToken.balanceOf(feeCollectorAddress);

      await simpleCounterERC20Fee.connect(user).incrementWithFee(
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT
      );

      const endCounter = await simpleCounterERC20Fee.counter();
      const endBalance = await mockToken.balanceOf(feeCollectorAddress);

      expect(endCounter).to.equal(initCounter + BigInt(1));
      expect(endBalance).to.equal(initBalance + FEE_AMOUNT);

      console.log(`      Transaction successful with fee: ${ethers.formatUnits(FEE_AMOUNT, 6)} USDC`);
    });
  });

  // ===========================================================================
  // Direct Calls (no meta-transaction)
  // ===========================================================================
  describe("Direct calls (no meta-transaction)", function () {
    it("#1: should increment counter with fee payment (prior approval)", async () => {
      // Approve contract to spend user's tokens
      await mockToken.connect(user).approve(contractAddress, FEE_AMOUNT);

      const initCounter = await simpleCounterERC20Fee.counter();
      const initFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      // Call incrementWithFee
      await simpleCounterERC20Fee.connect(user).incrementWithFee(
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT
      );

      const endCounter = await simpleCounterERC20Fee.counter();
      const endFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      expect(endCounter).to.equal(initCounter + BigInt(1));
      expect(endFeeCollectorBalance).to.equal(initFeeCollectorBalance + FEE_AMOUNT);
    });

    it("#2: should increment counter with permit (gasless approval)", async () => {
      const chainId = (await hre.ethers.provider.getNetwork()).chainId;

      // Get permit nonce
      const nonce = await mockToken.nonces(userAddress);
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Sign permit
      const domain = {
        name: "Mock USDC",
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
        owner: userAddress,
        spender: contractAddress,
        value: FEE_AMOUNT,
        nonce: nonce,
        deadline: deadline,
      };

      const signature = await user.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(signature);

      const initCounter = await simpleCounterERC20Fee.counter();
      const initFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      // Call incrementWithPermit
      await simpleCounterERC20Fee.connect(user).incrementWithPermit(
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT,
        deadline,
        v,
        r,
        s
      );

      const endCounter = await simpleCounterERC20Fee.counter();
      const endFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      expect(endCounter).to.equal(initCounter + BigInt(1));
      expect(endFeeCollectorBalance).to.equal(initFeeCollectorBalance + FEE_AMOUNT);
    });

    it("#3: should emit FeePaid event", async () => {
      await mockToken.connect(user).approve(contractAddress, FEE_AMOUNT);

      const tx = await simpleCounterERC20Fee.connect(user).incrementWithFee(
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = simpleCounterERC20Fee.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "FeePaid";
        } catch {
          return false;
        }
      });

      expect(event, "FeePaid event should be emitted").to.not.be.undefined;
    });

    it("#4: should revert with invalid fee collector", async () => {
      let reverted = false;
      try {
        await simpleCounterERC20Fee.connect(user).incrementWithFee(
          tokenAddress,
          ethers.ZeroAddress,
          FEE_AMOUNT
        );
      } catch (error: any) {
        reverted = true;
        expect(error.message).to.include("InvalidFeeCollector");
      }
      expect(reverted, "Should have reverted with InvalidFeeCollector").to.be.true;
    });

    it("#5: should revert with invalid fee token", async () => {
      let reverted = false;
      try {
        await simpleCounterERC20Fee.connect(user).incrementWithFee(
          ethers.ZeroAddress,
          feeCollectorAddress,
          FEE_AMOUNT
        );
      } catch (error: any) {
        reverted = true;
        expect(error.message).to.include("InvalidFeeToken");
      }
      expect(reverted, "Should have reverted with InvalidFeeToken").to.be.true;
    });

    it("#6: should revert if user has insufficient balance", async () => {
      const hugeAmount = ethers.parseUnits("1000000", 6);
      await mockToken.connect(user).approve(contractAddress, hugeAmount);

      let reverted = false;
      try {
        await simpleCounterERC20Fee.connect(user).incrementWithFee(
          tokenAddress,
          feeCollectorAddress,
          hugeAmount
        );
      } catch {
        reverted = true;
      }
      expect(reverted, "Should have reverted due to insufficient balance").to.be.true;
    });
  });

  // ===========================================================================
  // Meta-transaction with ERC20 fee
  // ===========================================================================
  describe("Meta-transaction with ERC20 fee", function () {
    it("#7: should execute meta-transaction with permit via TrustedForwarder", async () => {
      const forwarderAddress = await trustedForwarder.getAddress();
      const chainId = (await hre.ethers.provider.getNetwork()).chainId;

      // Step 1: Sign permit for the fee token
      const permitNonce = await mockToken.nonces(userAddress);
      const permitDeadline = Math.floor(Date.now() / 1000) + 3600;

      const permitDomain = {
        name: "Mock USDC",
        version: "1",
        chainId: chainId,
        verifyingContract: tokenAddress,
      };

      const permitTypes = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const permitMessage = {
        owner: userAddress,
        spender: contractAddress,
        value: FEE_AMOUNT,
        nonce: permitNonce,
        deadline: permitDeadline,
      };

      const permitSignature = await user.signTypedData(permitDomain, permitTypes, permitMessage);
      const { v: permitV, r: permitR, s: permitS } = ethers.Signature.from(permitSignature);

      // Step 2: Encode the incrementWithPermit call
      const incrementData = simpleCounterERC20Fee.interface.encodeFunctionData("incrementWithPermit", [
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT,
        permitDeadline,
        permitV,
        permitR,
        permitS,
      ]);

      // Step 3: Sign the meta-transaction for TrustedForwarder
      const forwarderTypes = {
        SponsoredCallERC2771: [
          { name: "chainId", type: "uint256" },
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "user", type: "address" },
          { name: "userNonce", type: "uint256" },
          { name: "userDeadline", type: "uint256" },
        ],
      };

      const forwarderDomain = {
        name: "TrustedForwarder",
        version: "1",
        chainId: chainId,
        verifyingContract: forwarderAddress,
      };

      const userNonce = await trustedForwarder.userNonce(userAddress);

      const forwarderMessage = {
        chainId: chainId,
        target: contractAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      const forwarderSignature = await user.signTypedData(forwarderDomain, forwarderTypes, forwarderMessage);

      const call = {
        chainId: chainId,
        target: contractAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      // Record initial state
      const initCounter = await simpleCounterERC20Fee.counter();
      const initFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      // Step 4: Execute via TrustedForwarder (relayer pays gas)
      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        forwarderSignature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );

      // Verify results
      const endCounter = await simpleCounterERC20Fee.counter();
      const endFeeCollectorBalance = await mockToken.balanceOf(feeCollectorAddress);

      expect(endCounter).to.equal(initCounter + BigInt(1));
      expect(endFeeCollectorBalance).to.equal(initFeeCollectorBalance + FEE_AMOUNT);
    });

    it("#8: should correctly identify user via _msgSender() in meta-transaction", async () => {
      const forwarderAddress = await trustedForwarder.getAddress();
      const chainId = (await hre.ethers.provider.getNetwork()).chainId;

      // Sign permit
      const permitNonce = await mockToken.nonces(userAddress);
      const permitDeadline = Math.floor(Date.now() / 1000) + 3600;

      const permitDomain = {
        name: "Mock USDC",
        version: "1",
        chainId: chainId,
        verifyingContract: tokenAddress,
      };

      const permitTypes = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const permitMessage = {
        owner: userAddress,
        spender: contractAddress,
        value: FEE_AMOUNT,
        nonce: permitNonce,
        deadline: permitDeadline,
      };

      const permitSignature = await user.signTypedData(permitDomain, permitTypes, permitMessage);
      const { v: permitV, r: permitR, s: permitS } = ethers.Signature.from(permitSignature);

      // Encode call
      const incrementData = simpleCounterERC20Fee.interface.encodeFunctionData("incrementWithPermit", [
        tokenAddress,
        feeCollectorAddress,
        FEE_AMOUNT,
        permitDeadline,
        permitV,
        permitR,
        permitS,
      ]);

      // Sign forwarder message
      const forwarderTypes = {
        SponsoredCallERC2771: [
          { name: "chainId", type: "uint256" },
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "user", type: "address" },
          { name: "userNonce", type: "uint256" },
          { name: "userDeadline", type: "uint256" },
        ],
      };

      const forwarderDomain = {
        name: "TrustedForwarder",
        version: "1",
        chainId: chainId,
        verifyingContract: forwarderAddress,
      };

      const userNonce = await trustedForwarder.userNonce(userAddress);

      const forwarderMessage = {
        chainId: chainId,
        target: contractAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      const forwarderSignature = await user.signTypedData(forwarderDomain, forwarderTypes, forwarderMessage);

      const call = {
        chainId: chainId,
        target: contractAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      // Execute and verify the FeePaid event shows user (not relayer)
      const tx = await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        forwarderSignature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );

      const receipt = await tx.wait();

      // Find the FeePaid event
      const feePaidEvent = receipt?.logs.find((log) => {
        try {
          const parsed = simpleCounterERC20Fee.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "FeePaid";
        } catch {
          return false;
        }
      });

      expect(feePaidEvent, "FeePaid event should be emitted").to.not.be.undefined;

      // Parse the event to verify the user address
      const parsedEvent = simpleCounterERC20Fee.interface.parseLog({
        topics: feePaidEvent!.topics as string[],
        data: feePaidEvent!.data,
      });

      // Verify the user in the event is the actual user, not the relayer
      expect(parsedEvent?.args[0].toLowerCase()).to.equal(userAddress.toLowerCase());
    });
  });

  // ===========================================================================
  // Standard increment (sponsored)
  // ===========================================================================
  describe("Standard increment (sponsored)", function () {
    it("#9: should work with standard increment (no fee)", async () => {
      const initCounter = await simpleCounterERC20Fee.counter();
      await simpleCounterERC20Fee.connect(user).increment();
      const endCounter = await simpleCounterERC20Fee.counter();

      expect(endCounter).to.equal(initCounter + BigInt(1));
    });
  });
});
