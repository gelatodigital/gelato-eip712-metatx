import hre, { deployments, ethers } from "hardhat";
import { expect } from "chai";
import { SimpleCounterTrustedConcurrent, TrustedForwarderConcurrentERC2771 } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

let simpleCounterTrustedConcurrentAddress: string;
let trustedForwarderConcurrentAddress: string;

describe("Test SimpleCounterTrustedConcurrent with TrustedForwarderConcurrentERC2771 (Hash-Based)", function () {
  let simpleCounterTrustedConcurrent: SimpleCounterTrustedConcurrent;
  let trustedForwarderConcurrent: TrustedForwarderConcurrentERC2771;
  let user: SignerWithAddress;
  let userAddress: string;
  let relayer: SignerWithAddress;

  beforeEach("tests", async function () {
    if (hre.network.name !== "hardhat") {
      console.error("Test Suite is meant to be run on hardhat only");
      process.exit(1);
    }
    await deployments.fixture(["TrustedForwarderConcurrent", "SimpleCounterTrustedConcurrent"]);

    [user, relayer] = await hre.ethers.getSigners();
    userAddress = await user.getAddress();

    trustedForwarderConcurrentAddress = (await deployments.get("TrustedForwarderConcurrentERC2771")).address;
    simpleCounterTrustedConcurrentAddress = (await deployments.get("SimpleCounterTrustedConcurrent")).address;

    trustedForwarderConcurrent = (await hre.ethers.getContractAt(
      "TrustedForwarderConcurrentERC2771",
      trustedForwarderConcurrentAddress
    )) as TrustedForwarderConcurrentERC2771;

    simpleCounterTrustedConcurrent = (await hre.ethers.getContractAt(
      "SimpleCounterTrustedConcurrent",
      simpleCounterTrustedConcurrentAddress
    )) as SimpleCounterTrustedConcurrent;
  });

  it("#1: direct increment (no meta-transaction)", async () => {
    const initCounter = +(await simpleCounterTrustedConcurrent.counter()).toString();
    await simpleCounterTrustedConcurrent.increment();
    const endCounter = +(await simpleCounterTrustedConcurrent.counter()).toString();
    expect(initCounter + 1 == endCounter, "Counter not increased").to.be.true;
  });

  it("#2: should verify trusted forwarder is set correctly", async () => {
    const isTrusted = await simpleCounterTrustedConcurrent.isTrustedForwarder(trustedForwarderConcurrentAddress);
    expect(isTrusted).to.be.true;

    const isNotTrusted = await simpleCounterTrustedConcurrent.isTrustedForwarder(userAddress);
    expect(isNotTrusted).to.be.false;
  });

  it("#3: should execute meta-transaction via TrustedForwarderConcurrentERC2771", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    // EIP-712 types for SponsoredCallConcurrentERC2771
    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    // Domain data for TrustedForwarderConcurrentERC2771
    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    // Generate unique salt
    const userSalt = ethers.hexlify(ethers.randomBytes(32));

    // Prepare the function call data for increment()
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    // Create the message to sign
    const message = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0, // No expiry
    };

    // Sign the typed data (packed signature)
    const signature = await user.signTypedData(domainData, types, message);

    // Create the call struct
    const call = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    // Execute via TrustedForwarderConcurrentERC2771 (relayer pays gas)
    await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
      call,
      userAddress, // sponsor
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // feeToken (native)
      chainId, // oneBalanceChainId
      signature,
      1, // nativeToFeeTokenXRateNumerator
      1, // nativeToFeeTokenXRateDenominator
      ethers.hexlify(ethers.randomBytes(32)) // correlationId
    );

    const newCounter = await simpleCounterTrustedConcurrent.counter();
    expect(newCounter.toString()).to.equal("1");
  });

  it("#4: should reject replay attack (same salt)", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const userSalt = ethers.hexlify(ethers.randomBytes(32));
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    // First execution should succeed
    await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
      call,
      userAddress,
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      chainId,
      signature,
      1,
      1,
      ethers.hexlify(ethers.randomBytes(32))
    );

    // Second execution with same salt should fail (replay attack)
    let reverted = false;
    try {
      await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
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

  it("#5: should allow concurrent transactions with different salts", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    // Generate 3 different salts and sign 3 transactions
    const salts = [
      ethers.hexlify(ethers.randomBytes(32)),
      ethers.hexlify(ethers.randomBytes(32)),
      ethers.hexlify(ethers.randomBytes(32)),
    ];

    const signatures = await Promise.all(
      salts.map(async (salt) => {
        const message = {
          chainId: chainId,
          target: simpleCounterTrustedConcurrentAddress,
          data: incrementData,
          user: userAddress,
          userSalt: salt,
          userDeadline: 0,
        };
        return user.signTypedData(domainData, types, message);
      })
    );

    // Execute in reverse order (3, 2, 1) to prove order doesn't matter
    for (let i = salts.length - 1; i >= 0; i--) {
      const call = {
        chainId: chainId,
        target: simpleCounterTrustedConcurrentAddress,
        data: incrementData,
        user: userAddress,
        userSalt: salts[i],
        userDeadline: 0,
      };

      await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
        call,
        userAddress,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        chainId,
        signatures[i],
        1,
        1,
        ethers.hexlify(ethers.randomBytes(32))
      );
    }

    const finalCounter = await simpleCounterTrustedConcurrent.counter();
    expect(finalCounter.toString()).to.equal("3");
  });

  it("#6: should reject expired deadline", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const userSalt = ethers.hexlify(ethers.randomBytes(32));
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    // Set deadline in the past
    const expiredDeadline = 1; // Unix timestamp 1 (way in the past)

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: expiredDeadline,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: expiredDeadline,
    };

    let reverted = false;
    try {
      await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
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

  it("#7: should reject invalid signature", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const userSalt = ethers.hexlify(ethers.randomBytes(32));
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    // Relayer signs instead of user (wrong signer)
    const signature = await relayer.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    let reverted = false;
    try {
      await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
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

  it("#8: should reject wrong chain ID", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;
    const wrongChainId = BigInt(999999);

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const userSalt = ethers.hexlify(ethers.randomBytes(32));
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    const message = {
      chainId: wrongChainId, // Wrong chain ID
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: wrongChainId, // Wrong chain ID
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    let reverted = false;
    try {
      await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
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

  it("#9: should work with deadline = 0 (no expiry)", async () => {
    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      SponsoredCallConcurrentERC2771: [
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "user", type: "address" },
        { name: "userSalt", type: "bytes32" },
        { name: "userDeadline", type: "uint256" },
      ],
    };

    const domainData = {
      name: "TrustedForwarderConcurrentERC2771",
      version: "1",
      chainId: chainId,
      verifyingContract: trustedForwarderConcurrentAddress,
    };

    const userSalt = ethers.hexlify(ethers.randomBytes(32));
    const incrementData = simpleCounterTrustedConcurrent.interface.encodeFunctionData("increment");

    const message = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0, // No expiry
    };

    const signature = await user.signTypedData(domainData, types, message);

    const call = {
      chainId: chainId,
      target: simpleCounterTrustedConcurrentAddress,
      data: incrementData,
      user: userAddress,
      userSalt: userSalt,
      userDeadline: 0,
    };

    await trustedForwarderConcurrent.connect(relayer).sponsoredCallConcurrentERC2771(
      call,
      userAddress,
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      chainId,
      signature,
      1,
      1,
      ethers.hexlify(ethers.randomBytes(32))
    );

    const newCounter = await simpleCounterTrustedConcurrent.counter();
    expect(newCounter.toString()).to.equal("1");
  });
});
