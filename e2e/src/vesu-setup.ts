import { join } from "path";
import {
  hash,
  type Account,
  type RpcProvider,
  type GetTransactionReceiptResponse,
} from "starknet";
import {
  repoRoot,
  artifactPair,
  declareClass,
  deployContract,
  executeAndWait,
  serializeByteArray,
  u256Calldata,
} from "./utils.js";

const SCALE = 1_000_000_000_000_000_000n; // 1e18
const PERCENT = 10_000_000_000_000_000n; // 1e16 = 1%

// Arbitrary pragma key identifiers — any felt works for the mock oracle
const USD_PRAGMA_KEY = "0x555344"; // "USD"
const BTC_PRAGMA_KEY = "0x425443"; // "BTC"

export interface TokenAddresses {
  usdToken: string;
  btcToken: string;
}

export interface VesuAddresses {
  factoryAddress: string;
  poolAddress: string;
  oracleAddress: string;
  usdVToken: string;
  btcVToken: string;
}

type ReceiptEvent = { keys: string[]; data: string[] };

function findEventKey(
  receipt: GetTransactionReceiptResponse,
  eventNameHash: string,
  keyIndex: number,
): string {
  const events: ReceiptEvent[] =
    "events" in receipt ? (receipt.events as ReceiptEvent[]) : [];
  for (const event of events) {
    if (event.keys[0] === eventNameHash) {
      return event.keys[keyIndex];
    }
  }
  throw new Error(`Event with selector ${eventNameHash} not found in receipt`);
}

function filterEvents(
  receipt: GetTransactionReceiptResponse,
  eventNameHash: string,
): ReceiptEvent[] {
  const events: ReceiptEvent[] =
    "events" in receipt ? (receipt.events as ReceiptEvent[]) : [];
  return events.filter((event) => event.keys[0] === eventNameHash);
}

/**
 * Declare and deploy shared test ERC-20 tokens (USD + BTC).
 * Uses TestToken from e2e/contracts/test-token/ (OZ ERC-20 with open mint).
 * Idempotent: skips already-declared classes and already-deployed contracts.
 */
export async function deployTestTokens(
  admin: Account,
  provider: RpcProvider,
): Promise<TokenAddresses> {
  const tokenArtifact = artifactPair(
    join(repoRoot(), "e2e/contracts/test-token/target/dev"),
    "test_token",
    "TestToken",
  );

  const tokenClassHash = await declareClass(
    admin,
    provider,
    tokenArtifact.classPath,
    tokenArtifact.compiledPath,
  );

  // TestToken constructor: (name: ByteArray, symbol: ByteArray)
  const usdToken = await deployContract(
    admin,
    provider,
    tokenClassHash,
    [...serializeByteArray("TestUSD"), ...serializeByteArray("USD")] as Array<
      string | bigint
    >,
    "0x400",
  );

  const btcToken = await deployContract(
    admin,
    provider,
    tokenClassHash,
    [...serializeByteArray("TestBTC"), ...serializeByteArray("BTC")] as Array<
      string | bigint
    >,
    "0x500",
  );

  return { usdToken, btcToken };
}

/**
 * Deploy Vesu V2 lending infrastructure: PoolFactory, mock oracles, Oracle, Pool.
 * Seeds initial liquidity for both USD/BTC pairs.
 *
 * Set `DEPLOY_SALT_SEED` env var to deploy fresh instances at new addresses.
 */
export async function deployVesuInfra(
  admin: Account,
  provider: RpcProvider,
  tokens: TokenAddresses,
): Promise<VesuAddresses> {
  const { usdToken, btcToken } = tokens;
  const vesuArtifactDirectory = join(
    repoRoot(),
    "e2e/contracts/vesu/target/dev",
  );

  const vesuArtifact = (name: string) =>
    artifactPair(vesuArtifactDirectory, "vesu_contracts", name);

  // Declare all Vesu classes
  const declareVesu = async (name: string) => {
    const { classPath, compiledPath } = vesuArtifact(name);
    return declareClass(admin, provider, classPath, compiledPath);
  };

  const poolClassHash = await declareVesu("Pool");
  const vtokenClassHash = await declareVesu("VToken");
  const oracleClassHash = await declareVesu("Oracle");
  const factoryClassHash = await declareVesu("PoolFactory");
  const mockPragmaClassHash = await declareVesu("MockPragmaOracle");
  const mockSummaryClassHash = await declareVesu("MockPragmaSummary");

  // Deploy PoolFactory
  const factoryAddress = await deployContract(
    admin,
    provider,
    factoryClassHash,
    [admin.address, poolClassHash, vtokenClassHash, oracleClassHash],
    "0x600",
  );

  // Deploy mock oracle contracts
  const pragmaOracleAddress = await deployContract(
    admin,
    provider,
    mockPragmaClassHash,
    [],
    "0x601",
  );
  const pragmaSummaryAddress = await deployContract(
    admin,
    provider,
    mockSummaryClassHash,
    [],
    "0x602",
  );

  // Create Oracle via PoolFactory
  const createOracleSelector = hash.getSelectorFromName("CreateOracle");
  const oracleReceipt = await executeAndWait(admin, provider, {
    contractAddress: factoryAddress,
    entrypoint: "create_oracle",
    calldata: [admin.address, pragmaOracleAddress, pragmaSummaryAddress],
  });
  const oracleAddress = findEventKey(oracleReceipt, createOracleSelector, 1);

  // Set mock prices (1:1 = 1e18)
  await executeAndWait(admin, provider, {
    contractAddress: pragmaOracleAddress,
    entrypoint: "set_price",
    calldata: [USD_PRAGMA_KEY, SCALE],
  });
  await executeAndWait(admin, provider, {
    contractAddress: pragmaOracleAddress,
    entrypoint: "set_price",
    calldata: [BTC_PRAGMA_KEY, SCALE],
  });

  // Register assets in Oracle
  // OracleConfig: pragma_key, timeout, number_of_sources, start_time_offset, time_window, aggregation_mode
  await executeAndWait(admin, provider, {
    contractAddress: oracleAddress,
    entrypoint: "add_asset",
    calldata: [usdToken, USD_PRAGMA_KEY, 0, 2, 0, 0, 0],
  });
  await executeAndWait(admin, provider, {
    contractAddress: oracleAddress,
    entrypoint: "add_asset",
    calldata: [btcToken, BTC_PRAGMA_KEY, 0, 2, 0, 0, 0],
  });

  // Mint inflation fee tokens and approve factory (required for pool creation)
  const inflationAmount = 4000n;
  await executeAndWait(admin, provider, {
    contractAddress: usdToken,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: btcToken,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: usdToken,
    entrypoint: "approve",
    calldata: [factoryAddress, ...u256Calldata(inflationAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: btcToken,
    entrypoint: "approve",
    calldata: [factoryAddress, ...u256Calldata(inflationAmount)],
  });

  // Create pool with USD/BTC pair
  const initialFullUtilRate = (1582470460n + 32150205761n) / 2n;

  const assetParams = (tokenAddress: string) => [
    tokenAddress,
    ...u256Calldata(SCALE / 10_000n),
    ...u256Calldata(initialFullUtilRate),
    ...u256Calldata(SCALE),
    0,
    ...u256Calldata(0n),
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

  const createPoolCalldata = [
    "0x5665737550726976616379", // "VesuPrivacy"
    admin.address,
    oracleAddress,
    admin.address,
    2,
    ...assetParams(usdToken),
    ...assetParams(btcToken),
    2,
    ...serializeByteArray("Vesu USD"),
    ...serializeByteArray("vUSD"),
    btcToken,
    ...serializeByteArray("Vesu BTC"),
    ...serializeByteArray("vBTC"),
    usdToken,
    2,
    ...interestRateConfig,
    ...interestRateConfig,
    2,
    1,
    0,
    80n * PERCENT,
    0,
    0, // pair BTC→USD
    0,
    1,
    80n * PERCENT,
    0,
    0, // pair USD→BTC
  ];

  const createPoolSelector = hash.getSelectorFromName("CreatePool");
  const createVTokenSelector = hash.getSelectorFromName("CreateVToken");
  const poolReceipt = await executeAndWait(admin, provider, {
    contractAddress: factoryAddress,
    entrypoint: "create_pool",
    calldata: createPoolCalldata.map(String),
  });

  const poolAddress = findEventKey(poolReceipt, createPoolSelector, 1);
  const vtokenEvents = filterEvents(poolReceipt, createVTokenSelector);
  let usdVToken = "";
  let btcVToken = "";
  for (const event of vtokenEvents) {
    const assetAddr = event.keys[2];
    const vtokenAddr = event.keys[3];
    if (BigInt(assetAddr) === BigInt(usdToken)) usdVToken = vtokenAddr;
    else if (BigInt(assetAddr) === BigInt(btcToken)) btcVToken = vtokenAddr;
  }
  if (!usdVToken || !btcVToken) {
    throw new Error(
      "Failed to extract vToken addresses from CreateVToken events",
    );
  }

  // Supply initial liquidity (1000 tokens each side)
  const liquidityAmount = 1000n * 10n ** 18n;

  await executeAndWait(admin, provider, {
    contractAddress: usdToken,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: btcToken,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: usdToken,
    entrypoint: "approve",
    calldata: [poolAddress, ...u256Calldata(liquidityAmount)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: btcToken,
    entrypoint: "approve",
    calldata: [poolAddress, ...u256Calldata(liquidityAmount)],
  });

  // modify_position: supply as collateral (no borrowing)
  // Amount: denomination (Assets=1), value (i257: abs_low, abs_high, is_negative)
  await executeAndWait(admin, provider, {
    contractAddress: poolAddress,
    entrypoint: "modify_position",
    calldata: [
      usdToken,
      btcToken,
      admin.address,
      1,
      ...u256Calldata(liquidityAmount),
      0,
      1,
      ...u256Calldata(0n),
      0,
    ].map(String),
  });
  await executeAndWait(admin, provider, {
    contractAddress: poolAddress,
    entrypoint: "modify_position",
    calldata: [
      btcToken,
      usdToken,
      admin.address,
      1,
      ...u256Calldata(liquidityAmount),
      0,
      1,
      ...u256Calldata(0n),
      0,
    ].map(String),
  });

  return { factoryAddress, poolAddress, oracleAddress, usdVToken, btcVToken };
}

/**
 * Declare and deploy the VesuLendingAnonymizer contract (stateless).
 * Idempotent: skips already-declared class and already-deployed contract.
 */
export async function deployVesuAnonymizer(
  admin: Account,
  provider: RpcProvider,
  privacyAddress: string,
): Promise<string> {
  const anonymizerArtifact = artifactPair(
    join(repoRoot(), "target/dev"),
    "vesu_lending_anonymizer",
    "VesuLendingAnonymizer",
  );

  const anonymizerClassHash = await declareClass(
    admin,
    provider,
    anonymizerArtifact.classPath,
    anonymizerArtifact.compiledPath,
  );

  // constructor: trusted privacy contract allowed to call privacy_invoke
  return deployContract(
    admin,
    provider,
    anonymizerClassHash,
    [privacyAddress],
    "0x700",
  );
}
