/**
 * Deploy VesuLendingHelper to integration environment.
 *
 * Prerequisites: scarb build (from repo root)
 * Usage: npm run setup-vesu-helper (from e2e/, with .env populated)
 */

import { setupAdmin } from "../src/utils.js";
import { deployVesuHelper } from "../src/vesu-setup.js";

const { adminAccount, provider } = setupAdmin();
const helperAddress = await deployVesuHelper(adminAccount, provider);

console.log("\nCopy to e2e/.env:");
console.log(`VESU_LENDING_HELPER_ADDRESS=${helperAddress}`);
