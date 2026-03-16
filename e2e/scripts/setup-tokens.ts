/**
 * Deploy shared test ERC-20 tokens (USD + BTC) to integration environment.
 *
 * Prerequisites: cd e2e/vesu-contracts && scarb build
 * Usage: npm run setup-tokens (from e2e/, with .env populated)
 */

import { setupAdmin } from "../src/utils.js";
import { deployTestTokens } from "../src/vesu-setup.js";

const { adminAccount, provider } = setupAdmin();
const { usdToken, btcToken } = await deployTestTokens(adminAccount, provider);

console.log("\nCopy to e2e/.env:");
console.log(`USD_TOKEN_ADDRESS=${usdToken}`);
console.log(`BTC_TOKEN_ADDRESS=${btcToken}`);
