import { GelatoRelay, SponsoredCallRequest } from "@gelatonetwork/relay-sdk";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const GELATO_RELAY_API_KEY = process.env.GELATO_RELAY_API_KEY;
const GELATO_RPC = "https://api.gelato.cloud/rpc";

// Configuration - Update these for your deployment
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const SIMPLE_COUNTER_ADDRESS = "YOUR_DEPLOYED_CONTRACT_ADDRESS";
const FEE_TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // USDC on Base Sepolia

// ABIs
const simpleCounterAbi = [
  "function incrementWithPermit(address feeToken, address feeCollector, uint256 fee, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function incrementWithFee(address feeToken, address feeCollector, uint256 fee)",
  "function increment()",
  "function counter() view returns (uint256)",
];

const erc20PermitAbi = [
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
];

// Gelato API types
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
 */
async function getCapabilities(chainId: number): Promise<Capabilities> {
  const response = await fetch(GELATO_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": GELATO_RELAY_API_KEY!,
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "relayer_getCapabilities",
      params: [chainId.toString()],
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`API Error: ${data.error.message}`);
  }
  return data.result[chainId.toString()];
}

/**
 * Get fee quote from Gelato API
 */
async function getFeeData(chainId: number, tokenAddress: string): Promise<FeeData> {
  const response = await fetch(GELATO_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": GELATO_RELAY_API_KEY!,
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "relayer_getFeeData",
      params: [chainId, tokenAddress],
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`API Error: ${data.error.message}`);
  }
  return data.result;
}

/**
 * Calculate fee amount based on estimated gas
 */
function calculateFee(
  estimatedGas: bigint,
  gasPrice: string,
  exchangeRate: string,
  tokenDecimals: number
): bigint {
  const gasCost = estimatedGas * BigInt(gasPrice);
  // Add 50% buffer for safety margin
  const gasCostWithBuffer = (gasCost * 150n) / 100n;
  // Convert to token amount using exchange rate
  // exchangeRate is typically in 18 decimals
  const fee = (gasCostWithBuffer * BigInt(exchangeRate)) / BigInt(10 ** 18);
  return fee;
}

/**
 * Sign EIP-2612 permit for gasless token approval
 */
async function signPermit(
  signer: ethers.Wallet,
  tokenAddress: string,
  spender: string,
  value: bigint,
  deadline: number
): Promise<{ v: number; r: string; s: string }> {
  const token = new ethers.Contract(tokenAddress, erc20PermitAbi, signer);

  const [name, nonce, domainSeparator] = await Promise.all([
    token.name(),
    token.nonces(signer.address),
    token.DOMAIN_SEPARATOR(),
  ]);

  // Get chainId from domain separator or provider
  const chainId = (await signer.provider!.getNetwork()).chainId;

  // EIP-2612 Permit domain
  const domain = {
    name: name,
    version: "1", // Most tokens use version "1"
    chainId: chainId,
    verifyingContract: tokenAddress,
  };

  // EIP-2612 Permit types
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
    nonce: nonce,
    deadline: deadline,
  };

  const signature = await signer.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(signature);

  return { v, r, s };
}

/**
 * Main function: Test ERC20 fee payment with permit
 */
async function testERC20FeeWithPermit() {
  console.log("=== Testing ERC20 Fee Payment with Permit ===\n");

  // Setup
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const relay = new GelatoRelay();

  console.log(`Chain ID: ${chainId}`);
  console.log(`User Address: ${signer.address}`);
  console.log(`Contract: ${SIMPLE_COUNTER_ADDRESS}`);
  console.log(`Fee Token: ${FEE_TOKEN_ADDRESS}\n`);

  // Step 1: Get fee collector from Gelato API
  console.log("Step 1: Getting fee collector from Gelato API...");
  const capabilities = await getCapabilities(chainId);
  const feeCollector = capabilities.feeCollector;
  console.log(`Fee Collector: ${feeCollector}`);

  // Verify token is supported
  const supportedToken = capabilities.tokens.find(
    (t) => t.address.toLowerCase() === FEE_TOKEN_ADDRESS.toLowerCase()
  );
  if (!supportedToken) {
    throw new Error(`Token ${FEE_TOKEN_ADDRESS} is not supported for fee payment on chain ${chainId}`);
  }
  console.log(`Token Decimals: ${supportedToken.decimals}\n`);

  // Step 2: Get fee quote from Gelato API
  console.log("Step 2: Getting fee quote from Gelato API...");
  const feeData = await getFeeData(chainId, FEE_TOKEN_ADDRESS);
  console.log(`Exchange Rate: ${feeData.exchangeRate}`);
  console.log(`Gas Price: ${feeData.gasPrice}`);
  console.log(`Quote Expires: ${new Date(feeData.quoteExpiry * 1000).toISOString()}\n`);

  // Step 3: Calculate fee amount
  console.log("Step 3: Calculating fee amount...");
  const estimatedGas = 150000n; // Estimate for incrementWithPermit
  const fee = calculateFee(
    estimatedGas,
    feeData.gasPrice,
    feeData.exchangeRate,
    supportedToken.decimals
  );
  console.log(`Estimated Gas: ${estimatedGas}`);
  console.log(`Fee Amount: ${fee} (${ethers.formatUnits(fee, supportedToken.decimals)} tokens)\n`);

  // Step 4: Sign permit for gasless approval
  console.log("Step 4: Signing EIP-2612 permit...");
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  const { v, r, s } = await signPermit(
    signer,
    FEE_TOKEN_ADDRESS,
    SIMPLE_COUNTER_ADDRESS,
    fee,
    deadline
  );
  console.log(`Permit signed with deadline: ${new Date(deadline * 1000).toISOString()}\n`);

  // Step 5: Encode the transaction
  console.log("Step 5: Encoding transaction...");
  const simpleCounter = new ethers.Contract(SIMPLE_COUNTER_ADDRESS, simpleCounterAbi, signer);
  const txData = simpleCounter.interface.encodeFunctionData("incrementWithPermit", [
    FEE_TOKEN_ADDRESS,
    feeCollector,
    fee,
    deadline,
    v,
    r,
    s,
  ]);
  console.log(`Transaction data encoded\n`);

  // Step 6: Submit to Gelato Relay
  console.log("Step 6: Submitting to Gelato Relay...");
  const request: SponsoredCallRequest = {
    chainId: BigInt(chainId),
    target: SIMPLE_COUNTER_ADDRESS,
    data: txData,
  };

  const response = await relay.sponsoredCall(request, GELATO_RELAY_API_KEY as string);
  console.log(`Task ID: ${response.taskId}`);
  console.log(`Status URL: https://relay.gelato.digital/tasks/status/${response.taskId}\n`);

  console.log("=== Transaction submitted! ===");
  console.log("The user signed a permit (gasless approval) and the transaction was relayed.");
  console.log("The fee will be transferred from the user to Gelato's fee collector on-chain.");
}

/**
 * Alternative: Test ERC20 fee payment without permit (requires prior approval)
 */
async function testERC20FeeWithApproval() {
  console.log("=== Testing ERC20 Fee Payment with Prior Approval ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const relay = new GelatoRelay();

  // Get fee info from API
  const capabilities = await getCapabilities(chainId);
  const feeData = await getFeeData(chainId, FEE_TOKEN_ADDRESS);

  const supportedToken = capabilities.tokens.find(
    (t) => t.address.toLowerCase() === FEE_TOKEN_ADDRESS.toLowerCase()
  );

  const fee = calculateFee(
    100000n,
    feeData.gasPrice,
    feeData.exchangeRate,
    supportedToken!.decimals
  );

  // Note: User must have already approved the contract to spend their tokens
  // This would require a separate transaction: token.approve(contractAddress, fee)

  const simpleCounter = new ethers.Contract(SIMPLE_COUNTER_ADDRESS, simpleCounterAbi, signer);
  const txData = simpleCounter.interface.encodeFunctionData("incrementWithFee", [
    FEE_TOKEN_ADDRESS,
    capabilities.feeCollector,
    fee,
  ]);

  const request: SponsoredCallRequest = {
    chainId: BigInt(chainId),
    target: SIMPLE_COUNTER_ADDRESS,
    data: txData,
  };

  const response = await relay.sponsoredCall(request, GELATO_RELAY_API_KEY as string);
  console.log(`Task ID: ${response.taskId}`);
  console.log(`Status URL: https://relay.gelato.digital/tasks/status/${response.taskId}`);
}

// Run the test
testERC20FeeWithPermit().catch(console.error);
