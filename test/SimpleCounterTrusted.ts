import hre, { deployments, ethers } from "hardhat";
import { expect } from "chai";
import { SimpleCounterTrusted, TrustedForwarderERC2771 } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

let simpleCounterTrustedAddress: string;
let trustedForwarderAddress: string;

describe("Test SimpleCounterTrusted with TrustedForwarder (ERC-2771)", function () {
  let simpleCounterTrusted: SimpleCounterTrusted;
  let trustedForwarder: TrustedForwarderERC2771;
  let user: SignerWithAddress;
  let userAddress: string;
  let relayer: SignerWithAddress;

  beforeEach("tests", async function () {
    if (hre.network.name !== "hardhat") {
      console.error("Test Suite is meant to be run on hardhat only");
      process.exit(1);
    }
    await deployments.fixture(["TrustedForwarder", "SimpleCounterTrusted"]);

    [user, relayer] = await hre.ethers.getSigners();
    userAddress = await user.getAddress();

    trustedForwarderAddress = (await deployments.get("TrustedForwarderERC2771")).address;
    simpleCounterTrustedAddress = (await deployments.get("SimpleCounterTrusted")).address;

    trustedForwarder = (await hre.ethers.getContractAt(
      "TrustedForwarderERC2771",
      trustedForwarderAddress
    )) as TrustedForwarderERC2771;

    simpleCounterTrusted = (await hre.ethers.getContractAt(
      "SimpleCounterTrusted",
      simpleCounterTrustedAddress
    )) as SimpleCounterTrusted;
  });

  it("#1: direct increment (no meta-transaction)", async () => {
    const initCounter = +(await simpleCounterTrusted.counter()).toString();
    await simpleCounterTrusted.increment();
    const endCounter = +(await simpleCounterTrusted.counter()).toString();
    expect(initCounter + 1 == endCounter, "Counter not increased").to.be.true;
  });

  it("#2: should verify trusted forwarder is set correctly", async () => {
    const isTrusted = await simpleCounterTrusted.isTrustedForwarder(trustedForwarderAddress);
    expect(isTrusted).to.be.true;

    const isNotTrusted = await simpleCounterTrusted.isTrustedForwarder(userAddress);
    expect(isNotTrusted).to.be.false;
  });

  it("#3: should execute meta-transaction via TrustedForwarder", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    // EIP-712 types for SponsoredCallERC2771 (matching TrustedForwarder)
    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    // Domain data for TrustedForwarder
    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    // Get user's nonce from the forwarder
    const userNonce = await trustedForwarder.userNonce(userAddress);

    // Prepare the function call data for increment()
    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    // Create the message to sign
    const message = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0, // No expiry
    };

    // Sign the typed data (packed signature)
    const signature = await user.signTypedData(domainData, types, message);

    // Create the call struct
    const call = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    // Execute via TrustedForwarder (relayer pays gas)
    await trustedForwarder.connect(relayer).sponsoredCallERC2771(
      call,
      userAddress, // sponsor
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // feeToken (native)
      chainId, // oneBalanceChainId
      signature,
      1, // nativeToFeeTokenXRateNumerator
      1, // nativeToFeeTokenXRateDenominator
      ethers.hexlify(ethers.randomBytes(32)) // correlationId
    );

    const newCounter = await simpleCounterTrusted.counter();
    expect(newCounter.toString()).to.equal("1");

    // Verify nonce was incremented
    const newNonce = await trustedForwarder.userNonce(userAddress);
    expect(newNonce.toString()).to.equal("1");
  });

  it("#4: should reject replay attack (same nonce)", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    const userNonce = await trustedForwarder.userNonce(userAddress);
    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    // First execution should succeed
    await trustedForwarder.connect(relayer).sponsoredCallERC2771(
      call,
      userAddress,
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      chainId,
      signature,
      1,
      1,
      ethers.hexlify(ethers.randomBytes(32))
    );

    // Second execution with same signature should fail (nonce already used)
    let reverted = false;
    try {
      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    } catch (error) {
      reverted = true;
    }
    expect(reverted, "Should have reverted on replay attack").to.be.true;
  });

  it("#5: should reject expired deadline", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    const userNonce = await trustedForwarder.userNonce(userAddress);
    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    // Set deadline in the past
    const expiredDeadline = 1; // Unix timestamp 1 (way in the past)

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: expiredDeadline,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: expiredDeadline,
    };

    let reverted = false;
    try {
      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    } catch (error) {
      reverted = true;
    }
    expect(reverted, "Should have reverted on expired deadline").to.be.true;
  });

  it("#6: should reject invalid signature", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    const userNonce = await trustedForwarder.userNonce(userAddress);
    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    // Relayer signs instead of user (wrong signer)
    const signature = await relayer.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    let reverted = false;
    try {
      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    } catch (error) {
      reverted = true;
    }
    expect(reverted, "Should have reverted on invalid signature").to.be.true;
  });

  it("#7: should reject wrong chain ID", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const wrongChainId = BigInt(999999);

    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    const userNonce = await trustedForwarder.userNonce(userAddress);
    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    const message = {
      chainId: wrongChainId, // Wrong chain ID
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: wrongChainId, // Wrong chain ID
      target: simpleCounterTrustedAddress,
      data: incrementData,
      user: userAddress,
      userNonce: userNonce,
      userDeadline: 0,
    };

    let reverted = false;
    try {
      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    } catch (error) {
      reverted = true;
    }
    expect(reverted, "Should have reverted on wrong chain ID").to.be.true;
  });

  it("#8: should execute multiple sequential transactions", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userNonce", type: "uint256" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderAddress,
    };

    const incrementData = simpleCounterTrusted.interface.encodeFunctionData("increment");

    // Execute 3 sequential transactions
    for (let i = 0; i < 3; i++) {
      const userNonce = await trustedForwarder.userNonce(userAddress);

      const message = {
        chainId: chainId,
        target: simpleCounterTrustedAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      const signature = await user.signTypedData(domainData, types, message);

      const call = {
        chainId: chainId,
        target: simpleCounterTrustedAddress,
        data: incrementData,
        user: userAddress,
        userNonce: userNonce,
        userDeadline: 0,
      };

      await trustedForwarder.connect(relayer).sponsoredCallERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signature,
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    }

    const finalCounter = await simpleCounterTrusted.counter();
    expect(finalCounter.toString()).to.equal("3");

    const finalNonce = await trustedForwarder.userNonce(userAddress);
    expect(finalNonce.toString()).to.equal("3");
  });
});
