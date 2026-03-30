/**
 * Deploy OZ accounts (admin + users) on the target network.
 *
 * Flow:
 *   1. Deploy admin (must already be funded externally)
 *   2. For each user account: fund from admin, then deploy
 *
 * Each account entry may include an optional `salt` field. When omitted the
 * public key is used as the salt (standard OZ convention).
 *
 * Reads env vars:
 *   VITE_RPC_URL          — JSON-RPC endpoint
 *   ACCOUNTS         — JSON array of accounts (admin has "admin": true, each with salt)
 *
 * CLI args:
 *   --fund <strk>  STRK amount to send each account for fees (default: 1)
 *
 * Usage: npm run deploy-accounts   (from e2e/, with .env populated)
 */

import { Account, RpcProvider, ec, hash } from "starknet";

interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
  salt: string;
  admin?: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIntArg(
  args: string[],
  flag: string,
  defaultValue: number,
): number {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  const value = parseInt(args[index + 1], 10);
  if (isNaN(value) || value <= 0) {
    console.error(`Invalid value for ${flag}: ${args[index + 1]}`);
    process.exit(1);
  }
  return value;
}

// OZ account class hash
const OZ_ACCOUNT_CLASS_HASH =
  "0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564";

// Native STRK token address on StarkNet
const STRK_TOKEN =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";


const rpcUrl = requireEnv("VITE_RPC_URL");
const allAccounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));

function findAdmin(entries: AccountEntry[]): AccountEntry {
  const entry = entries.find((a) => a.admin);
  if (!entry) throw new Error("No admin account (admin: true) found in ACCOUNTS");
  return entry;
}

const adminEntry = findAdmin(allAccounts);
const userAccounts = allAccounts.filter((a) => !a.admin);

const cliArgs = process.argv.slice(2);
const fundAmount = BigInt(parseIntArg(cliArgs, "--fund", 1)) * 10n ** 18n;

const provider = new RpcProvider({ nodeUrl: rpcUrl });

async function isDeployed(address: string): Promise<boolean> {
  try {
    const classHash = await provider.getClassHashAt(address);
    console.log(`  Already deployed (class: ${classHash}) — skipping`);
    return true;
  } catch {
    return false;
  }
}

function deriveAccountDetails(
  privateKey: string,
  salt: string,
): { publicKey: string; addressSalt: string } {
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  return { publicKey, addressSalt: salt };
}

async function deployAccount(
  address: string,
  privateKey: string,
  publicKey: string,
  addressSalt: string,
  name: string,
): Promise<void> {
  const account = new Account({
    provider,
    address,
    signer: privateKey,
    cairoVersion: "1",
  });

  console.log(`  Deploying ${name}...`);
  const deployResult = await account.deployAccount({
    classHash: OZ_ACCOUNT_CLASS_HASH,
    constructorCalldata: [publicKey],
    addressSalt,
  });
  const receipt = await provider.waitForTransaction(
    deployResult.transaction_hash,
  );
  if (!receipt.isSuccess()) {
    console.error(
      `  Deploy ${name} FAILED:`,
      JSON.stringify(receipt, null, 2),
    );
    process.exit(1);
  }
  console.log(`  Deployed: ${deployResult.transaction_hash}`);
}

async function fundAccount(
  adminAccount: Account,
  targetAddress: string,
  name: string,
): Promise<void> {
  console.log(
    `  Funding ${name} (${targetAddress}) with ${fundAmount} STRK...`,
  );
  const transferCall = {
    contractAddress: STRK_TOKEN,
    entrypoint: "transfer",
    calldata: [targetAddress, fundAmount.toString(), "0"],
  };
  const fee = await adminAccount.estimateInvokeFee(transferCall);
  const transferTx = await adminAccount.execute(transferCall, {
    resourceBounds: fee.resourceBounds,
  });
  const receipt = await provider.waitForTransaction(
    transferTx.transaction_hash,
  );
  if (!receipt.isSuccess()) {
    console.error(
      `  Fund ${name} FAILED:`,
      JSON.stringify(receipt, null, 2),
    );
    process.exit(1);
  }
  console.log(`  Funded: ${transferTx.transaction_hash}`);
}

async function main(): Promise<void> {
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Admin: ${adminEntry.address}`);
  console.log(`User accounts: ${userAccounts.length}\n`);

  // Step 1: Deploy admin (must be pre-funded externally)
  console.log(`[${adminEntry.name}]`);
  if (!(await isDeployed(adminEntry.address))) {
    const { publicKey, addressSalt } = deriveAccountDetails(
      adminEntry.privateKey,
      adminEntry.salt,
    );
    const computedAddress = hash.calculateContractAddressFromHash(
      addressSalt,
      OZ_ACCOUNT_CLASS_HASH,
      [publicKey],
      0,
    );
    if (BigInt(computedAddress) !== BigInt(adminEntry.address)) {
      console.error(
        `  ERROR: computed admin address ${computedAddress} differs from account address ${adminEntry.address}`,
      );
      console.error(
        "  Check class hash, salt, and public key.",
      );
      process.exit(1);
    }
    await deployAccount(adminEntry.address, adminEntry.privateKey, publicKey, addressSalt, adminEntry.name);
  }

  const adminAccount = new Account({
    provider,
    address: adminEntry.address,
    signer: adminEntry.privateKey,
    cairoVersion: "1",
  });

  // Step 2: Deploy user accounts (fund from admin, then deploy)
  for (const entry of userAccounts) {
    console.log(`\n[${entry.name}]`);
    if (await isDeployed(entry.address)) continue;

    const { publicKey, addressSalt } = deriveAccountDetails(
      entry.privateKey,
      entry.salt,
    );
    const computedAddress = hash.calculateContractAddressFromHash(
      addressSalt,
      OZ_ACCOUNT_CLASS_HASH,
      [publicKey],
      0,
    );

    if (BigInt(computedAddress) !== BigInt(entry.address)) {
      console.warn(
        `  WARNING: computed address ${computedAddress} differs from env address ${entry.address}`,
      );
      console.warn(
        "  Check class hash and salt. Skipping.",
      );
      continue;
    }

    await fundAccount(adminAccount, entry.address, entry.name);
    await deployAccount(
      entry.address,
      entry.privateKey,
      publicKey,
      addressSalt,
      entry.name,
    );
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
