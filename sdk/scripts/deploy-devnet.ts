#!/usr/bin/env npx tsx
/**
 * Deploy Privacy Contract to Local Devnet
 *
 * Usage:
 *   npx tsx scripts/deploy-devnet.ts [RPC_URL]
 *
 * Example:
 *   # Start devnet first:
 *   docker run -p 5050:5050 shardlabs/starknet-devnet-rs:0.7.2 --seed 42
 *
 *   # Then deploy:
 *   npx tsx scripts/deploy-devnet.ts
 *   npx tsx scripts/deploy-devnet.ts http://localhost:5050
 */

import { RpcProvider, Account, Contract, CallData, hash, json } from "starknet";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const RPC_URL = process.argv[2] || "http://localhost:5050";

// Contract paths (relative to sdk/scripts directory)
const CONTRACT_CLASS_PATH = join(__dirname, "../../target/dev/privacy_Privacy.contract_class.json");
const COMPILED_CONTRACT_PATH = join(
  __dirname,
  "../../target/dev/privacy_Privacy.compiled_contract_class.json"
);

// Colors for output
const colors = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

interface PredeployedAccount {
  address: string;
  private_key: string;
  public_key: string;
  initial_balance: string;
}

async function getPredeployedAccounts(rpcUrl: string): Promise<PredeployedAccount[]> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "devnet_getPredeployedAccounts",
    }),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Failed to get predeployed accounts: ${result.error.message}`);
  }
  return result.result;
}

async function main() {
  console.log(colors.blue("======================================"));
  console.log(colors.blue("  Privacy Contract Devnet Deployment  "));
  console.log(colors.blue("======================================"));
  console.log();

  // Check if devnet is running
  console.log(colors.yellow(`Checking devnet at ${RPC_URL}...`));
  try {
    const aliveResponse = await fetch(`${RPC_URL}/is_alive`);
    if (!aliveResponse.ok) throw new Error("Not alive");
    console.log(colors.green("Devnet is running!"));
  } catch {
    console.error(colors.red(`Error: Devnet not responding at ${RPC_URL}`));
    console.log();
    console.log("Start devnet with:");
    console.log(
      colors.green("  docker run -p 5050:5050 shardlabs/starknet-devnet-rs:0.7.2 --seed 42")
    );
    process.exit(1);
  }
  console.log();

  // Check contract files exist
  try {
    readFileSync(CONTRACT_CLASS_PATH);
    readFileSync(COMPILED_CONTRACT_PATH);
  } catch {
    console.error(colors.red("Error: Contract not built. Run 'scarb build' first."));
    process.exit(1);
  }

  // Get predeployed accounts
  console.log(colors.yellow("Fetching predeployed accounts..."));
  const accounts = await getPredeployedAccounts(RPC_URL);

  if (accounts.length < 3) {
    console.error(colors.red("Error: Need at least 3 predeployed accounts"));
    process.exit(1);
  }

  const [aliceData, bobData, adminData] = accounts;
  console.log(`Found ${accounts.length} accounts`);
  console.log();

  // Setup provider
  const provider = new RpcProvider({ nodeUrl: RPC_URL });

  // Setup deployer account (use first account)
  // starknet.js v9 requires signer as Uint8Array
  const privateKeyBytes = new Uint8Array(
    aliceData.private_key
      .replace("0x", "")
      .match(/.{1,2}/g)!
      .map((byte: string) => parseInt(byte, 16))
  );
  const deployer = new Account({
    provider,
    address: aliceData.address,
    signer: privateKeyBytes,
  });
  console.log(`Deployer: ${colors.green(deployer.address)}`);
  console.log();

  // Load contract artifacts
  console.log(colors.yellow("Loading contract artifacts..."));
  const contractClass = json.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
  const compiledContract = json.parse(readFileSync(COMPILED_CONTRACT_PATH, "utf8"));

  // Calculate compiled class hash
  const compiledClassHash = hash.computeCompiledClassHash(compiledContract);
  console.log(`Compiled class hash: ${compiledClassHash}`);

  // Declare the contract
  console.log();
  console.log(colors.yellow("Declaring contract..."));

  let classHash: string;
  try {
    const declareResponse = await deployer.declare({
      contract: contractClass,
      casm: compiledContract,
    });

    console.log(`Declare tx: ${declareResponse.transaction_hash}`);

    // Wait for transaction
    await provider.waitForTransaction(declareResponse.transaction_hash);
    classHash = declareResponse.class_hash;
    console.log(`Class hash: ${colors.green(classHash)}`);
  } catch (error: any) {
    // Check if already declared
    if (error.message?.includes("already declared") || error.message?.includes("StarknetErrorCode.CLASS_ALREADY_DECLARED")) {
      console.log(colors.yellow("Contract already declared, computing class hash..."));
      classHash = hash.computeContractClassHash(contractClass);
      console.log(`Class hash: ${colors.green(classHash)}`);
    } else {
      throw error;
    }
  }

  // Deploy the contract
  console.log();
  console.log(colors.yellow("Deploying contract..."));
  console.log(`Constructor args:`);
  console.log(`  - governance_admin: ${adminData.address}`);
  console.log(`  - compliance_public_key: 0x1`);

  const deployResponse = await deployer.deployContract({
    classHash,
    constructorCalldata: [adminData.address, "0x1"],
  });

  console.log(`Deploy tx: ${deployResponse.transaction_hash}`);

  // Wait for transaction
  await provider.waitForTransaction(deployResponse.transaction_hash);
  const contractAddress = deployResponse.contract_address;

  console.log();
  console.log(colors.green("======================================"));
  console.log(colors.green("  Deployment Successful!              "));
  console.log(colors.green("======================================"));
  console.log();
  console.log(`Privacy Contract: ${colors.green(contractAddress)}`);
  console.log();
  console.log(colors.blue("Predeployed Accounts:"));
  console.log(`  Alice (Account 0): ${aliceData.address}`);
  console.log(`  Bob   (Account 1): ${bobData.address}`);
  console.log(`  Admin (Account 2): ${adminData.address}`);
  console.log();
  console.log(colors.blue("Predeployed Tokens:"));
  console.log(`  ETH:  0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7`);
  console.log(`  STRK: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`);
  console.log();

  // Save to .env file
  const envContent = `# Generated by deploy-devnet.ts at ${new Date().toISOString()}
PRIVACY_POOL_ADDRESS=${contractAddress}
ALICE_ADDRESS=${aliceData.address}
BOB_ADDRESS=${bobData.address}
ADMIN_ADDRESS=${adminData.address}
ALICE_PRIVATE_KEY=${aliceData.private_key}
BOB_PRIVATE_KEY=${bobData.private_key}
ADMIN_PRIVATE_KEY=${adminData.private_key}
STARKNET_RPC=${RPC_URL}
ETH_ADDRESS=0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7
STRK_ADDRESS=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
`;

  const envFile = join(__dirname, "../../.env.devnet");
  writeFileSync(envFile, envContent);
  console.log(colors.green(`Saved to .env.devnet`));
  console.log();
  console.log(`To use: ${colors.yellow("source .env.devnet")}`);
}

main().catch((error) => {
  console.error(colors.red("Deployment failed:"));
  console.error(error);
  process.exit(1);
});
