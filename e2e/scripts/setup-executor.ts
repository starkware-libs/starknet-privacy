/**
 * Declare and deploy the EkuboSwapExecutor contract.
 *
 * Idempotent: skips if already declared/deployed.
 *
 * Prerequisites:
 *   scarb build   # from repo root — produces privacy artifacts
 *
 * Requires EKUBO_ROUTER_ADDRESS in env (output of setup-ekubo).
 *
 * Usage:
 *   npm run setup-executor   (from e2e/, with .env populated)
 */

import path from "node:path";
import {
  requireEnv,
  artifactPair,
  repoRoot,
  setupAdmin,
  declareClass,
  deployDeterministic,
} from "./ekubo-helpers.js";

const EXECUTOR_SALT = "0x100";

async function main() {
  const { provider, adminAccount } = setupAdmin();
  const routerAddress = requireEnv("EKUBO_ROUTER_ADDRESS");

  const privacyArtifactDirectory = path.join(repoRoot(), "target/dev");
  const executorArtifact = artifactPair(
    privacyArtifactDirectory,
    "privacy",
    "EkuboSwapExecutor",
  );

  console.log("Declaring EkuboSwapExecutor...");
  const executorClassHash = await declareClass(
    adminAccount,
    provider,
    executorArtifact.classPath,
    executorArtifact.compiledPath,
  );

  console.log("Deploying EkuboSwapExecutor...");
  const executorAddress = await deployDeterministic(
    adminAccount,
    provider,
    executorClassHash,
    [routerAddress],
    EXECUTOR_SALT,
  );

  console.log("\nCopy to e2e/.env:");
  console.log(`EXECUTOR_ADDRESS=${executorAddress}`);
}

await main();
