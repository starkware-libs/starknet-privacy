/**
 * Declare, deploy, and seed a local Vesu V2 lending instance.
 *
 * Reuses USD_TOKEN_ADDRESS and BTC_TOKEN_ADDRESS (already-deployed OZ TestTokens).
 * Idempotent: skips already-declared classes and already-deployed contracts.
 *
 * Prerequisites:
 *   cd e2e/vesu-contracts && scarb build   # produces Vesu artifacts
 *   USD_TOKEN_ADDRESS and BTC_TOKEN_ADDRESS must be set in .env
 *
 * Usage:
 *   npm run setup-vesu   (from e2e/, with .env populated)
 */

import path from "node:path";
import { byteArray, hash } from "starknet";
import {
  requireEnv,
  artifactPair,
  repoRoot,
  setupAdmin,
  declareClass,
  deployDeterministic,
  executeAndWait,
  INVOKE_RESOURCE_BOUNDS,
} from "./helpers.js";

const SCALE = 1_000_000_000_000_000_000n; // 1e18
const SCALE_128 = 1_000_000_000_000_000_000n; // 1e18 as u128
const PERCENT = 10_000_000_000_000_000n; // 1e16 = 1%

const FACTORY_SALT = "0x600";
const PRAGMA_ORACLE_SALT = "0x601";
const PRAGMA_SUMMARY_SALT = "0x602";

function u256Calldata(value: bigint): bigint[] {
  return [value & ((1n << 128n) - 1n), value >> 128n];
}

function serializeByteArray(value: string): (string | number | bigint)[] {
  const ba = byteArray.byteArrayFromString(value);
  return [ba.data.length, ...ba.data, ba.pending_word, ba.pending_word_len];
}

/** Extract an event key from a transaction receipt by matching the event name selector. */
function findEventKey(
  events: Array<{ keys: string[]; data: string[] }>,
  eventNameHash: string,
  keyIndex: number,
): string {
  for (const event of events) {
    if (event.keys[0] === eventNameHash) {
      return event.keys[keyIndex];
    }
  }
  throw new Error(`Event with selector ${eventNameHash} not found in receipt`);
}

async function main() {
  const { provider, adminAccount, admin } = setupAdmin();

  const usdPragmaKey = requireEnv("VESU_USD_PRAGMA_KEY");
  const btcPragmaKey = requireEnv("VESU_BTC_PRAGMA_KEY");
  const usdTokenAddress = requireEnv("USD_TOKEN_ADDRESS");
  const btcTokenAddress = requireEnv("BTC_TOKEN_ADDRESS");

  const vesuArtifactDirectory = path.join(
    repoRoot(),
    "e2e/vesu-contracts/target/dev",
  );

  const poolArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "Pool",
  );
  const factoryArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "PoolFactory",
  );
  const vtokenArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "VToken",
  );
  const oracleArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "Oracle",
  );
  const mockPragmaArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "MockPragmaOracle",
  );
  const mockSummaryArtifact = artifactPair(
    vesuArtifactDirectory,
    "vesu_contracts",
    "MockPragmaSummary",
  );

  // Step 1: Declare Vesu classes (Pool, VToken, Oracle, PoolFactory, mock oracles)
  console.log("Declaring Pool...");
  const poolClassHash = await declareClass(
    adminAccount,
    provider,
    poolArtifact.classPath,
    poolArtifact.compiledPath,
  );

  console.log("Declaring VToken...");
  const vtokenClassHash = await declareClass(
    adminAccount,
    provider,
    vtokenArtifact.classPath,
    vtokenArtifact.compiledPath,
  );

  console.log("Declaring Oracle...");
  const oracleClassHash = await declareClass(
    adminAccount,
    provider,
    oracleArtifact.classPath,
    oracleArtifact.compiledPath,
  );

  console.log("Declaring PoolFactory...");
  const factoryClassHash = await declareClass(
    adminAccount,
    provider,
    factoryArtifact.classPath,
    factoryArtifact.compiledPath,
  );

  console.log("Declaring MockPragmaOracle...");
  const mockPragmaClassHash = await declareClass(
    adminAccount,
    provider,
    mockPragmaArtifact.classPath,
    mockPragmaArtifact.compiledPath,
  );

  console.log("Declaring MockPragmaSummary...");
  const mockSummaryClassHash = await declareClass(
    adminAccount,
    provider,
    mockSummaryArtifact.classPath,
    mockSummaryArtifact.compiledPath,
  );

  // Step 2: Deploy PoolFactory
  console.log("Deploying PoolFactory...");
  const factoryAddress = await deployDeterministic(
    adminAccount,
    provider,
    factoryClassHash,
    [admin.address, poolClassHash, vtokenClassHash, oracleClassHash],
    FACTORY_SALT,
  );

  // Step 3: Deploy mock oracle contracts
  console.log("Deploying MockPragmaOracle...");
  const pragmaOracleAddress = await deployDeterministic(
    adminAccount,
    provider,
    mockPragmaClassHash,
    [],
    PRAGMA_ORACLE_SALT,
  );

  console.log("Deploying MockPragmaSummary...");
  const pragmaSummaryAddress = await deployDeterministic(
    adminAccount,
    provider,
    mockSummaryClassHash,
    [],
    PRAGMA_SUMMARY_SALT,
  );

  // Step 4: Create Oracle via PoolFactory (idempotent — use env var if already created)
  console.log("Creating Oracle...");
  let oracleAddress = process.env.VESU_ORACLE_ADDRESS;
  if (oracleAddress && oracleAddress !== "0x0") {
    console.log(`  Using existing oracle at ${oracleAddress}`);
  } else {
    const createOracleSelector = hash.getSelectorFromName("CreateOracle");
    const oracleTx = await adminAccount.execute(
      {
        contractAddress: factoryAddress,
        entrypoint: "create_oracle",
        calldata: [admin.address, pragmaOracleAddress, pragmaSummaryAddress],
      },
      { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
    );
    const oracleReceipt = await provider.waitForTransaction(
      oracleTx.transaction_hash,
    );
    if (!oracleReceipt.isSuccess()) {
      throw new Error(`Oracle creation failed: ${oracleTx.transaction_hash}`);
    }
    oracleAddress = findEventKey(
      oracleReceipt.events as Array<{ keys: string[]; data: string[] }>,
      createOracleSelector,
      1,
    );
    console.log(`  Oracle created at ${oracleAddress}`);
  }

  // Step 5: Set mock prices (1:1 = SCALE_128) and register assets
  console.log("Setting mock prices...");
  await executeAndWait(adminAccount, provider, {
    contractAddress: pragmaOracleAddress,
    entrypoint: "set_price",
    calldata: [usdPragmaKey, SCALE_128],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: pragmaOracleAddress,
    entrypoint: "set_price",
    calldata: [btcPragmaKey, SCALE_128],
  });
  console.log("  Prices set");

  console.log("Registering assets in Oracle...");
  // OracleConfig: pragma_key, timeout, number_of_sources, start_time_offset, time_window, aggregation_mode
  await executeAndWait(adminAccount, provider, {
    contractAddress: oracleAddress,
    entrypoint: "add_asset",
    calldata: [usdTokenAddress, usdPragmaKey, 0, 2, 0, 0, 0],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: oracleAddress,
    entrypoint: "add_asset",
    calldata: [btcTokenAddress, btcPragmaKey, 0, 2, 0, 0, 0],
  });
  console.log("  Assets registered");

  // Step 6: Fund curator and approve factory for inflation fee
  console.log("Minting inflation fee tokens to admin...");
  const inflationAmount = 4000n;
  await executeAndWait(adminAccount, provider, {
    contractAddress: usdTokenAddress,
    entrypoint: "permissionedMint",
    calldata: [admin.address, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: btcTokenAddress,
    entrypoint: "permissionedMint",
    calldata: [admin.address, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: usdTokenAddress,
    entrypoint: "approve",
    calldata: [factoryAddress, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: btcTokenAddress,
    entrypoint: "approve",
    calldata: [factoryAddress, ...u256Calldata(inflationAmount)],
  });
  console.log("  Funded and approved");

  // Step 7: Create pool (idempotent — use env var if already created)
  console.log("Creating pool...");
  const initialFullUtilRate = (1582470460n + 32150205761n) / 2n;

  const usdAssetParams = [
    usdTokenAddress,
    ...u256Calldata(SCALE / 10_000n),
    ...u256Calldata(initialFullUtilRate),
    ...u256Calldata(SCALE),
    0,
    ...u256Calldata(0n),
  ];
  const btcAssetParams = [
    btcTokenAddress,
    ...u256Calldata(SCALE / 10_000n),
    ...u256Calldata(initialFullUtilRate),
    ...u256Calldata(SCALE),
    0,
    ...u256Calldata(0n),
  ];
  const usdVTokenParams = [
    ...serializeByteArray("Vesu USD"),
    ...serializeByteArray("vUSD"),
    btcTokenAddress,
  ];
  const btcVTokenParams = [
    ...serializeByteArray("Vesu BTC"),
    ...serializeByteArray("vBTC"),
    usdTokenAddress,
  ];
  const interestRateConfig = [
    ...u256Calldata(75_000n),
    ...u256Calldata(99_999n),
    ...u256Calldata(87_500n),
    ...u256Calldata(1582470460n),
    ...u256Calldata(32150205761n),
    ...u256Calldata(158247046n),
    ...u256Calldata(172_800n),
    ...u256Calldata(20n * PERCENT),
  ];
  const pairBtcToUsd = [1, 0, 80n * PERCENT, 0, 0];
  const pairUsdToBtc = [0, 1, 80n * PERCENT, 0, 0];

  const createPoolCalldata = [
    "0x5665737550726976616379", // "VesuPrivacy"
    admin.address,
    oracleAddress,
    admin.address,
    2,
    ...usdAssetParams,
    ...btcAssetParams,
    2,
    ...usdVTokenParams,
    ...btcVTokenParams,
    2,
    ...interestRateConfig,
    ...interestRateConfig,
    2,
    ...pairBtcToUsd,
    ...pairUsdToBtc,
  ];

  let poolAddress = process.env.VESU_POOL_ADDRESS;
  let usdVTokenAddress = process.env.USD_VTOKEN_ADDRESS;
  let btcVTokenAddress = process.env.BTC_VTOKEN_ADDRESS;
  const poolAlreadyCreated =
    poolAddress &&
    poolAddress !== "0x0" &&
    usdVTokenAddress &&
    usdVTokenAddress !== "0x0" &&
    btcVTokenAddress &&
    btcVTokenAddress !== "0x0";

  if (poolAlreadyCreated) {
    console.log(`  Using existing pool at ${poolAddress}`);
  } else {
    const createPoolSelector = hash.getSelectorFromName("CreatePool");
    const createVTokenSelector = hash.getSelectorFromName("CreateVToken");
    const createPoolTx = await adminAccount.execute(
      {
        contractAddress: factoryAddress,
        entrypoint: "create_pool",
        calldata: createPoolCalldata.map(String),
      },
      { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
    );
    const poolReceipt = await provider.waitForTransaction(
      createPoolTx.transaction_hash,
    );
    if (!poolReceipt.isSuccess()) {
      throw new Error(`Pool creation failed: ${createPoolTx.transaction_hash}`);
    }

    const typedEvents = poolReceipt.events as Array<{
      keys: string[];
      data: string[];
    }>;
    poolAddress = findEventKey(typedEvents, createPoolSelector, 1);
    console.log(`  Pool created at ${poolAddress}`);

    const vtokenEvents = typedEvents.filter(
      (e) => e.keys[0] === createVTokenSelector,
    );
    usdVTokenAddress = "";
    btcVTokenAddress = "";
    for (const event of vtokenEvents) {
      const assetAddr = event.keys[2];
      const vtokenAddr = event.keys[3];
      if (BigInt(assetAddr) === BigInt(usdTokenAddress))
        usdVTokenAddress = vtokenAddr;
      else if (BigInt(assetAddr) === BigInt(btcTokenAddress))
        btcVTokenAddress = vtokenAddr;
    }
    if (!usdVTokenAddress || !btcVTokenAddress) {
      throw new Error(
        "Failed to extract vToken addresses from CreateVToken events",
      );
    }
    console.log(`  USD vToken: ${usdVTokenAddress}`);
    console.log(`  BTC vToken: ${btcVTokenAddress}`);
  }

  // Step 8: Supply initial liquidity
  console.log("Supplying initial liquidity...");
  const liquidityAmount = 1000n * 10n ** 18n;

  await executeAndWait(adminAccount, provider, {
    contractAddress: usdTokenAddress,
    entrypoint: "permissionedMint",
    calldata: [admin.address, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: btcTokenAddress,
    entrypoint: "permissionedMint",
    calldata: [admin.address, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: usdTokenAddress,
    entrypoint: "approve",
    calldata: [poolAddress, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(adminAccount, provider, {
    contractAddress: btcTokenAddress,
    entrypoint: "approve",
    calldata: [poolAddress, ...u256Calldata(liquidityAmount)],
  });

  // modify_position: supply as collateral (no borrowing)
  // Amount: denomination (Assets=1), value (i257: abs_low, abs_high, is_negative)
  await executeAndWait(adminAccount, provider, {
    contractAddress: poolAddress,
    entrypoint: "modify_position",
    calldata: [
      usdTokenAddress,
      btcTokenAddress,
      admin.address,
      1,
      ...u256Calldata(liquidityAmount),
      0,
      1,
      ...u256Calldata(0n),
      0,
    ].map(String),
  });
  console.log("  USD liquidity supplied");

  await executeAndWait(adminAccount, provider, {
    contractAddress: poolAddress,
    entrypoint: "modify_position",
    calldata: [
      btcTokenAddress,
      usdTokenAddress,
      admin.address,
      1,
      ...u256Calldata(liquidityAmount),
      0,
      1,
      ...u256Calldata(0n),
      0,
    ].map(String),
  });
  console.log("  BTC liquidity supplied");

  console.log("\nCopy to e2e/.env:");
  console.log(`VESU_POOL_FACTORY_ADDRESS=${factoryAddress}`);
  console.log(`VESU_POOL_ADDRESS=${poolAddress}`);
  console.log(`VESU_ORACLE_ADDRESS=${oracleAddress}`);
  console.log(`MOCK_PRAGMA_ORACLE_ADDRESS=${pragmaOracleAddress}`);
  console.log(`USD_VTOKEN_ADDRESS=${usdVTokenAddress}`);
  console.log(`BTC_VTOKEN_ADDRESS=${btcVTokenAddress}`);
}

await main();
