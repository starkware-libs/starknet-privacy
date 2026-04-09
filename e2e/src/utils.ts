import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  Account,
  RpcProvider,
  byteArray,
  ec,
  hash,
  type Call,
  type GetTransactionReceiptResponse,
} from "starknet";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function repoRoot(): string {
  return join(__dirname, "../..");
}

export function artifactPair(
  artifactDirectory: string,
  prefix: string,
  contractName: string,
): { classPath: string; compiledPath: string } {
  return {
    classPath: join(
      artifactDirectory,
      `${prefix}_${contractName}.contract_class.json`,
    ),
    compiledPath: join(
      artifactDirectory,
      `${prefix}_${contractName}.compiled_contract_class.json`,
    ),
  };
}

/**
 * Load contract artifacts from disk and declare the class on-chain.
 * No hardcoded resource bounds — relies on the account (which may be devnet-wrapped).
 */
export async function declareFromArtifacts(
  account: Account,
  classPath: string,
  compiledPath: string,
): Promise<string> {
  const contractClass = JSON.parse(readFileSync(classPath, "utf8"));
  const compiledClass = JSON.parse(readFileSync(compiledPath, "utf8"));
  const response = await account.declare({
    contract: contractClass,
    casm: compiledClass,
    compiledClassHash: hash.computeCompiledClassHash(compiledClass),
  });
  return response.class_hash;
}

/**
 * Execute one or more calls, wait for the transaction to succeed, and return the receipt.
 * No hardcoded resource bounds — relies on the account (which may be devnet-wrapped).
 */
export async function executeAndWait(
  account: Account,
  provider: RpcProvider,
  calls: Call | Call[],
): Promise<GetTransactionReceiptResponse> {
  const tx = await account.execute(calls);
  const receipt = await provider.waitForTransaction(tx.transaction_hash);
  if (!receipt.isSuccess()) {
    throw new Error(`Transaction failed: ${tx.transaction_hash}`);
  }
  return receipt;
}

export function serializeByteArray(
  value: string,
): (string | number | bigint)[] {
  const ba = byteArray.byteArrayFromString(value);
  return [ba.data.length, ...ba.data, ba.pending_word, ba.pending_word_len];
}

export function u256Calldata(value: bigint): bigint[] {
  return [value & ((1n << 128n) - 1n), value >> 128n];
}

// --- Integration environment utilities ---

export interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
}

/**
 * Read an env var, trying both `NAME` and `VITE_NAME` prefixes.
 * Throws if neither is set.
 */
export function requireEnv(name: string): string {
  const value = process.env[name] ?? process.env[`VITE_${name}`];
  if (!value) throw new Error(`Missing required env var: ${name} (or VITE_${name})`);
  return value;
}

export function setupAdmin(): {
  provider: RpcProvider;
  adminAccount: Account;
  admin: AccountEntry;
} {
  const rpcUrl = requireEnv("RPC_URL");
  const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
  const admin = accounts.find(
    (entry) => entry.name.toLowerCase() === "admin",
  );
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
 * Declare a contract class with idempotency check and fee estimation.
 * Skips if already declared on-chain. Returns the class hash.
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

  const declarePayload = {
    contract: contractClass,
    casm: compiledClass,
    compiledClassHash: hash.computeCompiledClassHash(compiledClass),
  };

  // Use generous resource bounds for declares. Fee estimation via RPC is
  // unreliable across node implementations, and large contracts (e.g. Ekubo
  // Core) need significant L2 gas for compilation.
  const sierraSize = contractClass.sierra_program?.length ?? 0;
  const dataGasAmount = BigInt(Math.max(sierraSize * 2, 640));
  const declareResourceBounds = {
    l2_gas: { max_amount: 5_000_000_000n, max_price_per_unit: 16_000_000_000n },
    l1_gas: { max_amount: 1n, max_price_per_unit: 100_000_000_000_000n },
    l1_data_gas: { max_amount: dataGasAmount, max_price_per_unit: 100_000n },
  };

  try {
    const declaration = await account.declare(declarePayload, {
      tip: 0n,
      resourceBounds: declareResourceBounds,
    });
    const receipt = await provider.waitForTransaction(
      declaration.transaction_hash,
    );
    if (!receipt.isSuccess()) {
      throw new Error(`Declare failed: ${declaration.transaction_hash}`);
    }
    console.log(`  Declared: ${declaration.class_hash}`);
    return declaration.class_hash;
  } catch (error: unknown) {
    // Code 51 = class already declared (race with another tx)
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code: number }).code === 51
    ) {
      console.log(`  Already declared: ${classHash}`);
      return classHash;
    }
    if (error instanceof Error && "code" in error) {
      const rpcError = error as Error & { code: number; data?: unknown; baseError?: unknown };
      const shortMessage = rpcError.message.split(" with params")[0];
      const dataStr = rpcError.data
        ? ` data=${JSON.stringify(rpcError.data)}`
        : "";
      const baseStr = rpcError.baseError
        ? ` base=${JSON.stringify(rpcError.baseError)}`
        : "";
      throw new Error(
        `Declare RPC error for ${classPath.split("/").pop()} (code=${rpcError.code}): ${shortMessage}${dataStr}${baseStr}`,
      );
    }
    throw error;
  }
}

/**
 * Deploy a contract via UDC. The salt is combined with `DEPLOY_SALT_SEED`
 * from the environment — change the seed to deploy fresh instances at new
 * addresses.
 */
export async function deployContract(
  account: Account,
  provider: RpcProvider,
  classHash: string,
  constructorCalldata: Array<string | bigint>,
  salt: string,
): Promise<string> {
  const seed = process.env.DEPLOY_SALT_SEED ?? "0x0";
  const deployResponse = await account.deployContract({
    classHash,
    constructorCalldata,
    salt: ec.starkCurve.pedersen(seed, salt),
  });
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
