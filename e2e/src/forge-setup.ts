import { join } from "path";
import { type Account, type RpcProvider } from "starknet";
import {
  repoRoot,
  artifactPair,
  declareClass,
  deployContract,
  executeAndWait,
  serializeByteArray,
  u256Calldata,
} from "./utils.js";

const WAD = 10n ** 18n;

export interface ForgeStrategyConfig {
  /** Display name for the share token (also used in artifact deploy). */
  name: string;
  /** Symbol for the share token. */
  symbol: string;
  /** Address of the underlying ERC-20 the strategy accepts. */
  underlying: string;
  /** Initial price per share (1e18 = 1:1). Defaults to WAD. */
  initialPps?: bigint;
  /**
   * Per-strategy salt so multiple strategies on the same network don't collide.
   * `deployContract` further mixes in the `DEPLOY_SALT_SEED` env var, so changing
   * that var (e.g. `DEPLOY_SALT_SEED=0xabc npm run deploy-forge`) yields fresh
   * addresses across the whole batch without touching the per-strategy salts.
   */
  salt: string;
}

export interface ForgeAddresses {
  /** Address of `MockForgeYieldsGateway` — also the share ERC-20. */
  gateway: string;
  /** Address of the deployed `ForgeYieldsAnonymizer`. */
  anonymizer: string;
}

/**
 * Declare and deploy a single `MockForgeYieldsGateway`.
 *
 * The mock gateway exposes the same selectors as the real ForgeYields `TokenGateway`
 * but skips the Hyperlane / Controller / L1 bridge cycle. `process_epoch(new_pps)`
 * replaces the controller report-back; `set_paused` / `set_stale` flip the deposit
 * guards.
 */
export async function deployForgeGateway(
  admin: Account,
  provider: RpcProvider,
  config: ForgeStrategyConfig,
): Promise<string> {
  const gatewayArtifact = artifactPair(
    join(repoRoot(), "e2e/contracts/forge/target/dev"),
    "forge_contracts",
    "MockForgeYieldsGateway",
  );

  const classHash = await declareClass(
    admin,
    provider,
    gatewayArtifact.classPath,
    gatewayArtifact.compiledPath,
  );

  const initialPps = config.initialPps ?? WAD;
  // Constructor: (name: ByteArray, symbol: ByteArray, underlying: ContractAddress, initial_pps: u256)
  const calldata = [
    ...serializeByteArray(config.name),
    ...serializeByteArray(config.symbol),
    config.underlying,
    ...u256Calldata(initialPps),
  ] as Array<string | bigint>;

  return deployContract(admin, provider, classHash, calldata, config.salt);
}

/**
 * Declare and deploy the `ForgeYieldsAnonymizer` (stateless, no constructor args).
 * Idempotent: skips if already declared / deployed.
 */
export async function deployForgeAnonymizer(
  admin: Account,
  provider: RpcProvider,
): Promise<string> {
  const artifact = artifactPair(
    join(repoRoot(), "target/dev"),
    "forge_yields_anonymizer",
    "ForgeYieldsAnonymizer",
  );

  const classHash = await declareClass(
    admin,
    provider,
    artifact.classPath,
    artifact.compiledPath,
  );

  return deployContract(admin, provider, classHash, [], "0x800");
}

/**
 * Convenience bring-up: deploy both the mock gateway for the given strategy and
 * the anonymizer in one go.
 */
export async function deployForgeInfra(
  admin: Account,
  provider: RpcProvider,
  strategy: ForgeStrategyConfig,
): Promise<ForgeAddresses> {
  const gateway = await deployForgeGateway(admin, provider, strategy);
  const anonymizer = await deployForgeAnonymizer(admin, provider);
  return { gateway, anonymizer };
}

/**
 * Simulate the Hyperlane controller report by directly setting a new price per share.
 * Real protocol bumps pps via a `report()` cycle; in devnet we cut the cord.
 */
export async function processForgeEpoch(
  admin: Account,
  provider: RpcProvider,
  gateway: string,
  newPps: bigint,
): Promise<void> {
  await executeAndWait(admin, provider, {
    contractAddress: gateway,
    entrypoint: "process_epoch",
    calldata: u256Calldata(newPps),
  });
}
