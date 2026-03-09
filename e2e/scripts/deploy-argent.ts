/**
 * Deploy Argent accounts (owner-only, no guardian) on a live network.
 *
 * For each account defined in ARGENT_ACCOUNTS env var:
 *   1. Compute the counterfactual address from (classHash, salt, constructorCalldata)
 *   2. Fund it from the admin account (STRK for gas)
 *   3. Self-deploy via deployAccount
 *   4. Print the account details
 *
 * Env vars:
 *   RPC_URL          — JSON-RPC endpoint
 *   ACCOUNTS         — JSON array; uses the "admin" entry for funding
 *   FEE_TOKEN_ADDRESS — STRK token address for funding
 *   ARGENT_CLASS_HASH — Argent account class hash (already declared)
 *   ARGENT_ACCOUNTS  — JSON array of { name, privateKey, viewingKey, salt }
 *
 * Usage:
 *   npm run deploy-argent   (from e2e/, with .env populated)
 */

import {
  Account,
  RpcProvider,
  CallData,
  CairoCustomEnum,
  CairoOption,
  CairoOptionVariant,
  ec,
  hash,
  Signer,
  type Signature,
} from "starknet";
import { requireEnv, type AccountEntry } from "./ekubo-helpers.js";

const TRANSFER_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: 16_000_000_000n },
  l1_gas: { max_amount: 1n, max_price_per_unit: 1_000_000_000_000n },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: 2_000n },
};

const DEPLOY_ACCOUNT_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 80_000_000n, max_price_per_unit: 16_000_000_000n },
  l1_gas: { max_amount: 1n, max_price_per_unit: 1_000_000_000_000n },
  l1_data_gas: { max_amount: 4_000n, max_price_per_unit: 2_000n },
};

// Amount of fee token to send to each account before deployment
const FUND_AMOUNT = 2_000_000_000_000_000_000n; // 2e18

interface ArgentAccountInput {
  name: string;
  privateKey: string;
  viewingKey: string;
  salt: string;
}

/**
 * Minimal Argent signer (owner-only, no guardian).
 * Wraps [r, s] in [1, ...CairoCustomEnum({ Starknet: { signer, r, s } })].
 */
class ArgentOwnerSigner extends Signer {
  protected override async signRaw(messageHash: string): Promise<Signature> {
    const signature = ec.starkCurve.sign(messageHash, this.pk as string);
    const publicKey = ec.starkCurve.getStarkKey(this.pk as string);

    const signerEnum = new CairoCustomEnum({
      Starknet: {
        signer: BigInt(publicKey),
        r: signature.r,
        s: signature.s,
      },
      Secp256k1: undefined,
      Secp256r1: undefined,
      Eip191: undefined,
      Webauthn: undefined,
    });

    return ["1", ...CallData.compile([signerEnum])];
  }
}

function buildConstructorCalldata(publicKey: string): string[] {
  const ownerSigner = new CairoCustomEnum({
    Starknet: { signer: BigInt(publicKey) },
    Secp256k1: undefined,
    Secp256r1: undefined,
    Eip191: undefined,
    Webauthn: undefined,
  });

  const guardian = new CairoOption(CairoOptionVariant.None);

  return CallData.compile({ owner: ownerSigner, guardian });
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL");
  const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
  const funderName = process.env.FUNDER_ACCOUNT ?? "alice";
  const funder = accounts.find(
    (entry) => entry.name.toLowerCase() === funderName.toLowerCase(),
  );
  if (!funder)
    throw new Error(`No "${funderName}" entry found in ACCOUNTS env var`);

  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const funderAccount = new Account({
    provider,
    address: funder.address,
    signer: funder.privateKey,
    cairoVersion: "1",
  });

  const feeTokenAddress = requireEnv("FEE_TOKEN_ADDRESS");
  const argentClassHash = requireEnv("ARGENT_CLASS_HASH");
  const argentAccounts: ArgentAccountInput[] = JSON.parse(
    requireEnv("ARGENT_ACCOUNTS"),
  );

  console.log(`Argent class hash: ${argentClassHash}`);
  console.log(`Funder: ${funder.name} (${funder.address})`);
  console.log(`Deploying ${argentAccounts.length} account(s)...\n`);

  for (const entry of argentAccounts) {
    console.log(`--- ${entry.name} ---`);

    const publicKey = ec.starkCurve.getStarkKey(entry.privateKey);
    console.log(`  Public key: ${publicKey}`);

    const constructorCalldata = buildConstructorCalldata(publicKey);
    const contractAddress = hash.calculateContractAddressFromHash(
      entry.salt,
      argentClassHash,
      constructorCalldata,
      0,
    );
    console.log(`  Computed address: ${contractAddress}`);

    // Check if already deployed
    try {
      const existingClassHash = await provider.getClassHashAt(contractAddress);
      console.log(`  Already deployed (class: ${existingClassHash})`);
      printAccountOutput(entry, contractAddress);
      continue;
    } catch {
      // Not deployed yet — proceed
    }

    // Fund the computed address from admin
    console.log(`  Funding with ${FUND_AMOUNT} fee tokens...`);
    const fundTx = await funderAccount.execute(
      {
        contractAddress: feeTokenAddress,
        entrypoint: "transfer",
        calldata: [contractAddress, FUND_AMOUNT.toString(), "0"],
      },
      { resourceBounds: TRANSFER_RESOURCE_BOUNDS },
    );
    const fundReceipt = await provider.waitForTransaction(
      fundTx.transaction_hash,
    );
    if (!fundReceipt.isSuccess()) {
      console.error(`  Funding failed: ${fundTx.transaction_hash}`);
      continue;
    }
    console.log(`  Funded: ${fundTx.transaction_hash}`);

    // Deploy via deployAccount (self-deploy)
    const signer = new ArgentOwnerSigner(entry.privateKey);
    const account = new Account({
      provider,
      address: contractAddress,
      signer,
      cairoVersion: "1",
    });

    console.log("  Deploying...");
    const deployResponse = await account.deployAccount(
      {
        classHash: argentClassHash,
        constructorCalldata,
        addressSalt: entry.salt,
      },
      { resourceBounds: DEPLOY_ACCOUNT_RESOURCE_BOUNDS },
    );
    console.log(`  Deploy tx: ${deployResponse.transaction_hash}`);

    const deployReceipt = await provider.waitForTransaction(
      deployResponse.transaction_hash,
    );
    if (!deployReceipt.isSuccess()) {
      console.error(
        `  Deploy failed: ${JSON.stringify(deployReceipt, null, 2)}`,
      );
      continue;
    }
    console.log(`  Deployed successfully!`);

    // Verify
    const storedOwner = await provider.callContract({
      contractAddress,
      entrypoint: "get_owner",
      calldata: [],
    });
    console.log(`  Verified on-chain owner: ${storedOwner[0]}`);

    printAccountOutput(entry, contractAddress);
  }
}

function printAccountOutput(
  entry: ArgentAccountInput,
  contractAddress: string,
): void {
  console.log(`\n  Account config (for VITE_ACCOUNTS):`);
  console.log(
    `  ${JSON.stringify({
      name: entry.name,
      address: contractAddress,
      privateKey: entry.privateKey,
      viewingKey: entry.viewingKey,
      type: "argent",
    })}`,
  );
  console.log();
}

await main();
