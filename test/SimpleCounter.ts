import hre, { deployments, getNamedAccounts, network, ethers } from "hardhat";
import { expect } from "chai";
import { SimpleCounter } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { GelatoRelay, SponsoredCallRequest } from "@gelatonetwork/relay-sdk";


let simpleCounterAddress: string;

describe("Test SimpleCounter Smart Contract", function () {
  let simpleCounter: SimpleCounter;
  let user: SignerWithAddress;
  let userAddress: string;
  let bundleSigner: SignerWithAddress;
  beforeEach("tests", async function () {
    if (hre.network.name !== "hardhat") {
      console.error("Test Suite is meant to be run on hardhat only");
      process.exit(1);
    }
    await deployments.fixture(["SimpleCounter"]);

    [user, bundleSigner] = await hre.ethers.getSigners();
    userAddress = await user.getAddress();

    simpleCounterAddress = (await deployments.get("SimpleCounter")).address;

    simpleCounter = (await hre.ethers.getContractAt(
      "SimpleCounter",
      simpleCounterAddress
    )) as SimpleCounter;
  });

  it("#1: increment", async () => {
    let initCounter = +(await simpleCounter.counter()).toString()
    await simpleCounter.increment()
    let endCounter = +(await simpleCounter.counter()).toString()
    expect(initCounter + 1 == endCounter, "Counter not increase"
    ).to.be.true;
  });
  it("#2: should work sending a metatx", async () => {


    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      MetaTransaction: [
        { name: "nonce", type: "uint256" },
        { name: "from", type: "address" },
        { name: "functionSignature", type: "bytes" },
      ],
    };

    let domainData = {
      name: "SimpleCounter",
      version: "1",
      verifyingContract: simpleCounterAddress,
      salt: ethers.zeroPadValue(ethers.toBeHex(chainId), 32),
    };

    const nonce = await simpleCounter.getNonce(userAddress);
    const payload = await simpleCounter.increment.populateTransaction();
    let message = { nonce: nonce.toString(), from: userAddress, functionSignature: payload.data };

    // Sign the typed data (EIP-712)
    const signature = await user.signTypedData(domainData, types, message);
    // If you need v, r, s to call a contract method:
    const { r, s, v } = ethers.Signature.from(signature);

    // Recover the signer from the signature
    const recoveredSigner = ethers.verifyTypedData(domainData, types, message, signature);
    expect(recoveredSigner.toLowerCase()).to.equal(userAddress.toLowerCase());

    await simpleCounter.executeMetaTransaction(userAddress, payload.data, r, s, v);
    const newCounter = await simpleCounter.counter();
    expect(newCounter.toString()).to.equal("1");


    const newNonce = await simpleCounter.getNonce(userAddress);
    expect(newNonce.toString()).to.equal("1");
  });

  it("#3: should work simulatinga metatx calling Gelato Relay", async () => {


    const chainId = (await hre.ethers.provider.getNetwork()).chainId;

    const types = {
      MetaTransaction: [
        { name: "nonce", type: "uint256" },
        { name: "from", type: "address" },
        { name: "functionSignature", type: "bytes" },
      ],
    };

    let domainData = {
      name: "SimpleCounter",
      version: "1",
      verifyingContract: simpleCounterAddress,
      salt: ethers.zeroPadValue(ethers.toBeHex(chainId), 32),
    };

    const nonce = await simpleCounter.getNonce(userAddress);
    const payload = await simpleCounter.increment.populateTransaction();
    let message = { nonce: nonce.toString(), from: userAddress, functionSignature: payload.data };

    // Sign the typed data (EIP-712)
    const signature = await user.signTypedData(domainData, types, message);
    // If you need v, r, s to call a contract method:
    const { r, s, v } = ethers.Signature.from(signature);

    // Recover the signer from the signature
    const recoveredSigner = ethers.verifyTypedData(domainData, types, message, signature);
    expect(recoveredSigner.toLowerCase()).to.equal(userAddress.toLowerCase());

    let metaPayload = await simpleCounter.executeMetaTransaction.populateTransaction(userAddress, payload.data, r, s, v);

    const response = await bundleSigner.sendTransaction(metaPayload);
    await response.wait();


    const newCounter = await simpleCounter.counter();
    expect(newCounter.toString()).to.equal("1");


    const newNonce = await simpleCounter.getNonce(userAddress);
    expect(newNonce.toString()).to.equal("1");
  });
});
