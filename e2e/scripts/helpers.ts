import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, RpcProvider, ec, hash, type Call } from "starknet";

export interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
}

const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;

export const DECLARE_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 3_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 30_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

export const DEPLOY_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 80_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 4_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

export const INVOKE_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 5_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function artifactPair(
  artifactDirectory: string,
  prefix: string,
  contractName: string,
): { classPath: string; compiledPath: string } {
  return {
    classPath: path.join(
      artifactDirectory,
      `${prefix}_${contractName}.contract_class.json`,
    ),
    compiledPath: path.join(
      artifactDirectory,
      `${prefix}_${contractName}.compiled_contract_class.json`,
    ),
  };
}

export function repoRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "../..");
}

export function setupAdmin(): {
  provider: RpcProvider;
  adminAccount: Account;
  admin: AccountEntry;
} {
  const rpcUrl = requireEnv("RPC_URL");
  const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
  const admin = accounts.find((entry) => entry.name === "admin");
  if (!admin) throw new Error('No "admin" entry found in ACCOUNTS env var');

  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const adminAccount = new Account({
    provider,
    address: admin.address,
    signer: admin.privateKey,
    cairoVersion: "1",
  });
  return { provider, adminAccount, admin };
}

/**
 * Declare a contract class, skipping if already declared on-chain.
 * Returns the class hash.
 */
export async function declareClass(
  account: Account,
  provider: RpcProvider,
  classPath: string,
  compiledPath: string,
): Promise<string> {
  const contractClass = JSON.parse(readFileSync(classPath, "utf8"));
  const compiledClass = JSON.parse(readFileSync(compiledPath, "utf8"));

  const classHash = hash.computeContractClassHash(contractClass);
  try {
    await provider.getClass(classHash);
    console.log(`  Already declared: ${classHash}`);
    return classHash;
  } catch {
    // not declared yet
  }

  // Scale l1_data_gas for large contracts (fee estimator underestimates).
  const sierraElements = contractClass.sierra_program?.length ?? 0;
  const minDataGas = BigInt(Math.ceil(sierraElements * 4));
  const dataGas =
    minDataGas > DECLARE_RESOURCE_BOUNDS.l1_data_gas.max_amount
      ? minDataGas
      : DECLARE_RESOURCE_BOUNDS.l1_data_gas.max_amount;

  try {
    const declaration = await account.declare(
      {
        contract: contractClass,
        casm: compiledClass,
        compiledClassHash: hash.computeCompiledClassHash(compiledClass),
      },
      {
        tip: 0n,
        resourceBounds: {
          ...DECLARE_RESOURCE_BOUNDS,
          l1_data_gas: {
            max_amount: dataGas,
            max_price_per_unit: L1_DATA_GAS_PRICE,
          },
        },
      },
    );
    const receipt = await provider.waitForTransaction(
      declaration.transaction_hash,
    );
    if (!receipt.isSuccess()) {
      throw new Error(`Declare failed: ${declaration.transaction_hash}`);
    }
    console.log(`  Declared: ${declaration.class_hash}`);
    return declaration.class_hash;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      const rpcError = error as Error & {
        code: number;
        data?: unknown;
      };
      const shortMessage = rpcError.message.split(" with params")[0];
      const dataStr = rpcError.data
        ? ` data=${JSON.stringify(rpcError.data)}`
        : "";
      throw new Error(
        `Declare RPC error for ${classPath} (code=${rpcError.code}): ${shortMessage}${dataStr}`,
      );
    }
    throw error;
  }
}

/**
 * Deploy a contract with a deterministic salt, skipping if already deployed
 * at the precomputed address.
 */
export async function deployDeterministic(
  account: Account,
  provider: RpcProvider,
  classHash: string,
  constructorCalldata: Array<string | bigint>,
  salt: string,
): Promise<string> {
  const UDC_ADDRESS =
    "0x02ceed65a4bd731034c01113685c831b01c15d7d432f71afb1cf1634b53a2125";
  const uniqueSalt = ec.starkCurve.pedersen(account.address, salt);
  const precomputedAddress = hash.calculateContractAddressFromHash(
    uniqueSalt,
    classHash,
    constructorCalldata,
    UDC_ADDRESS,
  );

  try {
    await provider.getClassHashAt(precomputedAddress);
    console.log(`  Already deployed at ${precomputedAddress}`);
    return precomputedAddress;
  } catch {
    // not deployed yet
  }

  const deployResponse = await account.deployContract(
    { classHash, constructorCalldata, salt },
    { tip: 0n, resourceBounds: DEPLOY_RESOURCE_BOUNDS },
  );
  const receipt = await provider.waitForTransaction(
    deployResponse.transaction_hash,
  );
  if (!receipt.isSuccess()) {
    throw new Error(
      `Deploy failed: classHash=${classHash}, tx=${deployResponse.transaction_hash}`,
    );
  }
  console.log(`  Deployed at ${deployResponse.contract_address}`);
  return deployResponse.contract_address;
}

/**
 * Execute one or more calls and wait for success.
 * Returns the transaction hash.
 */
export async function executeAndWait(
  account: Account,
  provider: RpcProvider,
  calls: Call | Call[],
): Promise<string> {
  const tx = await account.execute(calls, {
    tip: 0n,
    resourceBounds: INVOKE_RESOURCE_BOUNDS,
  });
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  if (!receipt.isSuccess()) {
    throw new Error(`Transaction failed: ${tx.transaction_hash}`);
  }
  return tx.transaction_hash;
}
