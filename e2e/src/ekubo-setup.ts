import { join } from "path";
import { type Account, type RpcProvider } from "starknet";
import {
  repoRoot,
  artifactPair,
  declareClass,
  deployContract,
  executeAndWait,
  u256Calldata,
} from "./utils.js";
import type { TokenAddresses } from "./vesu-setup.js";

export interface EkuboPoolConfig {
  fee: bigint;
  tickSpacing: bigint;
  extension: string;
  initialTick: bigint;
  seedAmount0: bigint;
  seedAmount1: bigint;
  positionLowerBound: bigint;
  positionUpperBound: bigint;
  skipAhead: bigint;
}

export const DEVNET_POOL_CONFIG: EkuboPoolConfig = {
  fee: 170141183460469235273462165868118016n, // ~0.3%
  tickSpacing: 1000n,
  extension: "0x0",
  initialTick: 0n,
  seedAmount0: 1000n * 10n ** 18n,
  seedAmount1: 1000n * 10n ** 18n,
  positionLowerBound: -88722000n,
  positionUpperBound: 88722000n,
  skipAhead: 0n,
};

export interface EkuboAddresses {
  coreAddress: string;
  routerAddress: string;
  positionsAddress: string;
  poolToken0: string;
  poolToken1: string;
}

function parseI129(value: bigint): { mag: bigint; sign: boolean } {
  return { mag: value < 0n ? -value : value, sign: value < 0n };
}

/**
 * Deploy Ekubo infrastructure: Core, Router, Positions + initialize a pool with liquidity.
 * Idempotent: skips already-declared classes and already-deployed contracts.
 */
export async function deployEkuboInfra(
  admin: Account,
  provider: RpcProvider,
  tokens: TokenAddresses,
  poolConfig: EkuboPoolConfig = DEVNET_POOL_CONFIG,
): Promise<EkuboAddresses> {
  const ekuboArtifactDirectory = join(
    repoRoot(),
    "e2e/contracts/ekubo/target/dev",
  );
  const ekuboArtifact = (name: string) =>
    artifactPair(ekuboArtifactDirectory, "ekubo_contracts", name);

  const declareEkubo = async (name: string) => {
    const { classPath, compiledPath } = ekuboArtifact(name);
    return declareClass(admin, provider, classPath, compiledPath);
  };

  const coreClassHash = await declareEkubo("Core");
  const routerClassHash = await declareEkubo("Router");
  const positionsClassHash = await declareEkubo("Positions");
  const ownedNftClassHash = await declareEkubo("OwnedNFT");

  const coreAddress = await deployContract(
    admin,
    provider,
    coreClassHash,
    [admin.address],
    "0x100",
  );

  const routerAddress = await deployContract(
    admin,
    provider,
    routerClassHash,
    [coreAddress],
    "0x200",
  );

  const positionsAddress = await deployContract(
    admin,
    provider,
    positionsClassHash,
    [admin.address, coreAddress, ownedNftClassHash, "0"],
    "0x300",
  );

  // Sort tokens for Ekubo pool key (token0 < token1)
  const [poolToken0, poolToken1] =
    BigInt(tokens.usdToken) < BigInt(tokens.btcToken)
      ? [tokens.usdToken, tokens.btcToken]
      : [tokens.btcToken, tokens.usdToken];

  const initialTick = parseI129(poolConfig.initialTick);
  const lower = parseI129(poolConfig.positionLowerBound);
  const upper = parseI129(poolConfig.positionUpperBound);

  const poolKey = [
    poolToken0,
    poolToken1,
    poolConfig.fee,
    poolConfig.tickSpacing,
    poolConfig.extension,
  ];

  // Initialize pool
  await executeAndWait(admin, provider, {
    contractAddress: coreAddress,
    entrypoint: "initialize_pool",
    calldata: [...poolKey, initialTick.mag, initialTick.sign],
  });

  // Mint seed tokens to admin and transfer to Positions contract
  await executeAndWait(admin, provider, {
    contractAddress: poolToken0,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(poolConfig.seedAmount0)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: poolToken1,
    entrypoint: "mint",
    calldata: [admin.address, ...u256Calldata(poolConfig.seedAmount1)],
  });
  await executeAndWait(admin, provider, {
    contractAddress: poolToken0,
    entrypoint: "transfer",
    calldata: [positionsAddress, poolConfig.seedAmount0, 0n],
  });
  await executeAndWait(admin, provider, {
    contractAddress: poolToken1,
    entrypoint: "transfer",
    calldata: [positionsAddress, poolConfig.seedAmount1, 0n],
  });

  // Mint position and deposit liquidity
  await executeAndWait(admin, provider, {
    contractAddress: positionsAddress,
    entrypoint: "mint_and_deposit_and_clear_both",
    calldata: [
      ...poolKey,
      lower.mag,
      lower.sign,
      upper.mag,
      upper.sign,
      0n, // min_liquidity
    ],
  });

  return {
    coreAddress,
    routerAddress,
    positionsAddress,
    poolToken0,
    poolToken1,
  };
}

/**
 * Declare and deploy the EkuboSwapAnonymizer contract.
 * Idempotent: skips already-declared class and already-deployed contract.
 */
export async function deployEkuboExecutor(
  admin: Account,
  provider: RpcProvider,
  privacyAddress: string,
): Promise<string> {
  const executorArtifact = artifactPair(
    join(repoRoot(), "target/dev"),
    "ekubo_swap_anonymizer",
    "EkuboSwapAnonymizer",
  );

  const executorClassHash = await declareClass(
    admin,
    provider,
    executorArtifact.classPath,
    executorArtifact.compiledPath,
  );

  return deployContract(
    admin,
    provider,
    executorClassHash,
    [privacyAddress], // constructor: trusted privacy contract allowed to call privacy_invoke
    "0x100",
  );
}
