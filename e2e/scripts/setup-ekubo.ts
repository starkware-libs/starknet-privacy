/**
 * Declare, deploy, and seed Ekubo infrastructure (Core, Router, Positions).
 *
 * Idempotent: skips already-declared classes and already-deployed contracts.
 * The seed phase (initialize pool + add liquidity) always runs, enabling top-ups.
 *
 * Prerequisites:
 *   cd e2e/ekubo-contracts && scarb build   # produces Ekubo artifacts
 *
 * Usage:
 *   npm run setup-ekubo   (from e2e/, with .env populated)
 */

import path from "node:path";
import { byteArray } from "starknet";
import {
  requireEnv,
  artifactPair,
  repoRoot,
  setupAdmin,
  declareClass,
  deployDeterministic,
  INVOKE_RESOURCE_BOUNDS,
} from "./ekubo-helpers.js";

const CORE_SALT = "0x100";
const ROUTER_SALT = "0x200";
const POSITIONS_SALT = "0x300";
const USD_TOKEN_SALT = "0x400";
const BTC_TOKEN_SALT = "0x500";

async function main() {
  const { provider, adminAccount, admin } = setupAdmin();

  const ekuboArtifactDirectory = path.join(
    repoRoot(),
    "e2e/ekubo-contracts/target/dev",
  );

  const coreArtifact = artifactPair(
    ekuboArtifactDirectory,
    "ekubo_contracts",
    "Core",
  );
  const routerArtifact = artifactPair(
    ekuboArtifactDirectory,
    "ekubo_contracts",
    "Router",
  );
  const positionsArtifact = artifactPair(
    ekuboArtifactDirectory,
    "ekubo_contracts",
    "Positions",
  );
  const ownedNftArtifact = artifactPair(
    ekuboArtifactDirectory,
    "ekubo_contracts",
    "OwnedNFT",
  );
  const testTokenArtifact = artifactPair(
    ekuboArtifactDirectory,
    "ekubo_contracts",
    "TestToken",
  );

  // Declare
  console.log("Declaring Core...");
  const coreClassHash = await declareClass(
    adminAccount,
    provider,
    coreArtifact.classPath,
    coreArtifact.compiledPath,
  );

  console.log("Declaring Router...");
  const routerClassHash = await declareClass(
    adminAccount,
    provider,
    routerArtifact.classPath,
    routerArtifact.compiledPath,
  );

  console.log("Declaring Positions...");
  const positionsClassHash = await declareClass(
    adminAccount,
    provider,
    positionsArtifact.classPath,
    positionsArtifact.compiledPath,
  );

  console.log("Declaring OwnedNFT...");
  const ownedNftClassHash = await declareClass(
    adminAccount,
    provider,
    ownedNftArtifact.classPath,
    ownedNftArtifact.compiledPath,
  );

  console.log("Declaring TestToken...");
  const testTokenClassHash = await declareClass(
    adminAccount,
    provider,
    testTokenArtifact.classPath,
    testTokenArtifact.compiledPath,
  );

  // Deploy
  console.log("Deploying Core...");
  const coreAddress = await deployDeterministic(
    adminAccount,
    provider,
    coreClassHash,
    [admin.address],
    CORE_SALT,
  );

  console.log("Deploying Router...");
  const routerAddress = await deployDeterministic(
    adminAccount,
    provider,
    routerClassHash,
    [coreAddress],
    ROUTER_SALT,
  );

  console.log("Deploying Positions...");
  const positionsAddress = await deployDeterministic(
    adminAccount,
    provider,
    positionsClassHash,
    [admin.address, coreAddress, ownedNftClassHash, "0"],
    POSITIONS_SALT,
  );

  function serializeByteArray(value: string): (string | number | bigint)[] {
    const ba = byteArray.byteArrayFromString(value);
    return [ba.data.length, ...ba.data, ba.pending_word, ba.pending_word_len];
  }

  console.log("Deploying USD TestToken...");
  const usdTokenAddress = await deployDeterministic(
    adminAccount,
    provider,
    testTokenClassHash,
    [...serializeByteArray("TestUSD"), ...serializeByteArray("USD")].map(
      String,
    ),
    USD_TOKEN_SALT,
  );

  console.log("Deploying BTC TestToken...");
  const btcTokenAddress = await deployDeterministic(
    adminAccount,
    provider,
    testTokenClassHash,
    [...serializeByteArray("TestBTC"), ...serializeByteArray("BTC")].map(
      String,
    ),
    BTC_TOKEN_SALT,
  );

  // Seed
  console.log("Seeding pool...");
  // Sort tokens for Ekubo pool key (token0 < token1)
  const [token0, token1] =
    BigInt(usdTokenAddress) < BigInt(btcTokenAddress)
      ? [usdTokenAddress, btcTokenAddress]
      : [btcTokenAddress, usdTokenAddress];
  const poolFee = requireEnv("EKUBO_POOL_FEE");
  const tickSpacing = requireEnv("EKUBO_TICK_SPACING");
  const extension = requireEnv("EKUBO_EXTENSION");
  const initialTick = requireEnv("EKUBO_POOL_INITIAL_TICK");
  const seedAmount0 = BigInt(requireEnv("EKUBO_SEED_AMOUNT0"));
  const seedAmount1 = BigInt(requireEnv("EKUBO_SEED_AMOUNT1"));
  const lowerBound = requireEnv("EKUBO_POSITION_LOWER_BOUND");
  const upperBound = requireEnv("EKUBO_POSITION_UPPER_BOUND");

  // Parse initial tick: may be negative (e.g. "-100" → mag=100, sign=true)
  const initialTickValue = BigInt(initialTick);
  const initialTickMag =
    initialTickValue < 0n ? -initialTickValue : initialTickValue;
  const initialTickSign = initialTickValue < 0n;

  // Parse position bounds
  function parseI129(value: string): { mag: bigint; sign: boolean } {
    const num = BigInt(value);
    return { mag: num < 0n ? -num : num, sign: num < 0n };
  }
  const lower = parseI129(lowerBound);
  const upper = parseI129(upperBound);

  const poolKey = [token0, token1, poolFee, tickSpacing, extension];
  const bounds = [lower.mag, lower.sign, upper.mag, upper.sign];

  // Initialize pool (idempotent — catches "already initialized" errors)
  // Calldata: pool_key (token0, token1, fee, tick_spacing, extension), initial_tick (mag, sign)
  try {
    const initTx = await adminAccount.execute(
      {
        contractAddress: coreAddress,
        entrypoint: "initialize_pool",
        calldata: [...poolKey, initialTickMag, initialTickSign],
      },
      { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
    );
    const initReceipt = await provider.waitForTransaction(
      initTx.transaction_hash,
    );
    if (!initReceipt.isSuccess()) {
      console.warn(
        `  Pool initialization tx reverted: ${initTx.transaction_hash}`,
      );
    } else {
      console.log("  Pool initialized");
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    // Pool may already be initialized — log and continue
    console.log(`  Pool init skipped (may already exist): ${message}`);
  }

  // Mint seed tokens to admin (test tokens with permissionedMint)
  console.log("Minting seed tokens to admin...");
  const mintTx0 = await adminAccount.execute(
    {
      contractAddress: token0,
      entrypoint: "permissionedMint",
      calldata: [admin.address, seedAmount0, 0n],
    },
    { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
  );
  await provider.waitForTransaction(mintTx0.transaction_hash);

  const mintTx1 = await adminAccount.execute(
    {
      contractAddress: token1,
      entrypoint: "permissionedMint",
      calldata: [admin.address, seedAmount1, 0n],
    },
    { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
  );
  await provider.waitForTransaction(mintTx1.transaction_hash);

  // Transfer tokens to Positions contract (deposit reads Positions' own balance)
  console.log("Transferring tokens to Positions...");
  const transferTx0 = await adminAccount.execute(
    {
      contractAddress: token0,
      entrypoint: "transfer",
      calldata: [positionsAddress, seedAmount0, 0n],
    },
    { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
  );
  await provider.waitForTransaction(transferTx0.transaction_hash);

  const transferTx1 = await adminAccount.execute(
    {
      contractAddress: token1,
      entrypoint: "transfer",
      calldata: [positionsAddress, seedAmount1, 0n],
    },
    { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
  );
  await provider.waitForTransaction(transferTx1.transaction_hash);

  // Mint position and deposit liquidity
  // Calldata: pool_key, bounds (lower.mag, lower.sign, upper.mag, upper.sign), min_liquidity
  console.log("Minting position and depositing liquidity...");
  const minLiquidity = 0n;
  const depositTx = await adminAccount.execute(
    {
      contractAddress: positionsAddress,
      entrypoint: "mint_and_deposit_and_clear_both",
      calldata: [...poolKey, ...bounds, minLiquidity],
    },
    { tip: 0n, resourceBounds: INVOKE_RESOURCE_BOUNDS },
  );
  const depositReceipt = await provider.waitForTransaction(
    depositTx.transaction_hash,
  );
  if (!depositReceipt.isSuccess()) {
    throw new Error(
      `Liquidity deposit failed: ${depositTx.transaction_hash}`,
    );
  }
  console.log("  Liquidity deposited");

  console.log("\nCopy to e2e/.env:");
  console.log(`EKUBO_CORE_ADDRESS=${coreAddress}`);
  console.log(`EKUBO_ROUTER_ADDRESS=${routerAddress}`);
  console.log(`EKUBO_POSITIONS_ADDRESS=${positionsAddress}`);
  console.log(`USD_TOKEN_ADDRESS=${usdTokenAddress}`);
  console.log(`BTC_TOKEN_ADDRESS=${btcTokenAddress}`);
  console.log(`EKUBO_POOL_TOKEN0=${token0}`);
  console.log(`EKUBO_POOL_TOKEN1=${token1}`);
}

await main();
