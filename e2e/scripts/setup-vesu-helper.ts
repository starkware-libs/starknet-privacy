/**
 * Declare and deploy the VesuLendingHelper contract.
 *
 * Prerequisites:
 *   scarb build   (from repo root — produces privacy artifacts including VesuLendingHelper)
 *
 * Usage:
 *   npm run setup-vesu-helper   (from e2e/, with .env populated)
 */

import path from "node:path";
import {
  artifactPair,
  repoRoot,
  setupAdmin,
  declareClass,
  deployDeterministic,
} from "./helpers.js";

const VESU_HELPER_SALT = "0x700";

async function main() {
  const { provider, adminAccount } = setupAdmin();

  const privacyArtifactDirectory = path.join(repoRoot(), "target/dev");

  const helperArtifact = artifactPair(
    privacyArtifactDirectory,
    "privacy",
    "VesuLendingHelper",
  );

  console.log("Declaring VesuLendingHelper...");
  const helperClassHash = await declareClass(
    adminAccount,
    provider,
    helperArtifact.classPath,
    helperArtifact.compiledPath,
  );

  console.log("Deploying VesuLendingHelper...");
  const helperAddress = await deployDeterministic(
    adminAccount,
    provider,
    helperClassHash,
    [], // no constructor args — stateless contract
    VESU_HELPER_SALT,
  );

  console.log("\nCopy to e2e/.env:");
  console.log(`VESU_LENDING_HELPER_ADDRESS=${helperAddress}`);
}

await main();
