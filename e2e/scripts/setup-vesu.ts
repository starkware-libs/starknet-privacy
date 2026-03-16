/**
 * Deploy Vesu V2 lending infrastructure to integration environment.
 *
 * Prerequisites:
 *   cd e2e/vesu-contracts && scarb build
 *   USD_TOKEN_ADDRESS and BTC_TOKEN_ADDRESS must be set in .env
 *
 * Usage: npm run setup-vesu (from e2e/, with .env populated)
 */

import { setupAdmin, requireEnv } from "../src/utils.js";
import { deployVesuInfra } from "../src/vesu-setup.js";

const { adminAccount, provider } = setupAdmin();

const tokens = {
  usdToken: requireEnv("USD_TOKEN_ADDRESS"),
  btcToken: requireEnv("BTC_TOKEN_ADDRESS"),
};

// Pass existing factory-created addresses to skip re-creation
const existing = {
  oracleAddress:
    process.env.VESU_ORACLE_ADDRESS !== "0x0"
      ? process.env.VESU_ORACLE_ADDRESS
      : undefined,
  poolAddress:
    process.env.VESU_POOL_ADDRESS !== "0x0"
      ? process.env.VESU_POOL_ADDRESS
      : undefined,
  usdVToken:
    process.env.USD_VTOKEN_ADDRESS !== "0x0"
      ? process.env.USD_VTOKEN_ADDRESS
      : undefined,
  btcVToken:
    process.env.BTC_VTOKEN_ADDRESS !== "0x0"
      ? process.env.BTC_VTOKEN_ADDRESS
      : undefined,
};

const vesu = await deployVesuInfra(adminAccount, provider, tokens, existing);

console.log("\nCopy to e2e/.env:");
console.log(`VESU_POOL_FACTORY_ADDRESS=${vesu.factoryAddress}`);
console.log(`VESU_POOL_ADDRESS=${vesu.poolAddress}`);
console.log(`VESU_ORACLE_ADDRESS=${vesu.oracleAddress}`);
console.log(`USD_VTOKEN_ADDRESS=${vesu.usdVToken}`);
console.log(`BTC_VTOKEN_ADDRESS=${vesu.btcVToken}`);
