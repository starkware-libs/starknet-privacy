/**
 * Test context helper - reconstructs objects from globalSetup provided data.
 * Provides utilities for deploying contracts in individual tests.
 */

import { inject } from "vitest";
import { RpcProvider, Account, Contract, CallData, ec, type Abi, type Call } from "starknet";
import { DEVNET_TX_OPTIONS } from "./globalSetup.js";

const UDC_ADDRESS = "0x41A78E741E5AF2FEC34B695679BC6891742439F7AFB8484ECD7766661AD02BF";

// Test constants matching Cairo tests
// 'COMPLIANCE_PRIVATE_KEY' as short string -> felt252
const COMPLIANCE_PRIVATE_KEY = 0x434f4d504c49414e43455f505249564154455f4b4559n;

export interface TestContext {
  nodeUrl: string;
  provider: RpcProvider;
  account: Account;
  privacyClassHash: string;
  privacyAbi: Abi;
  echoClassHash: string;
  echoAbi: Abi;
}

/**
 * Get the test context from globalSetup provided data.
 * Call this in beforeAll or at the start of tests.
 */
export function getTestContext(): TestContext {
  const ctx = inject("testContext");

  const provider = new RpcProvider({ nodeUrl: ctx.nodeUrl });
  const account = new Account({
    provider,
    address: ctx.accountAddress,
    signer: ctx.accountPrivateKey,
  });

  const privacyAbi = JSON.parse(ctx.privacyAbiJson) as Abi;
  const echoAbi = JSON.parse(ctx.echoAbiJson) as Abi;

  return {
    nodeUrl: ctx.nodeUrl,
    provider,
    account,
    privacyClassHash: ctx.privacyClassHash,
    privacyAbi,
    echoClassHash: ctx.echoClassHash,
    echoAbi,
  };
}

/**
 * Helper to deploy a contract via UDC and return its address
 */
export async function deployViaUDC(
  account: Account,
  provider: RpcProvider,
  classHash: string,
  constructorCalldata: string[],
  salt: string = "0x0"
): Promise<string> {
  const deployCall: Call = {
    contractAddress: UDC_ADDRESS,
    entrypoint: "deployContract",
    calldata: CallData.compile({
      classHash,
      salt,
      unique: false,
      calldata: constructorCalldata,
    }),
  };

  const deployResponse = await account.execute(deployCall, { tip: 1000n });
  const receipt = await provider.waitForTransaction(
    deployResponse.transaction_hash,
    DEVNET_TX_OPTIONS
  );

  type EventType = { from_address?: string; keys?: string[]; data?: string[] };
  const events = (receipt as { events?: EventType[] }).events || [];

  const deployEvent = events.find(
    (e) =>
      e.from_address?.toLowerCase() ===
      "0x41a78e741e5af2fec34b695679bc6891742439f7afb8484ecd7766661ad02bf"
  );

  if (!deployEvent?.data?.[0]) {
    throw new Error("Failed to get deployed contract address from UDC event");
  }

  return deployEvent.data[0];
}

/**
 * Deploy the Privacy contract with default test configuration.
 * Returns the deployed contract address.
 */
export async function deployPrivacyContract(ctx: TestContext): Promise<string> {
  const compliancePublicKey = ec.starkCurve.getStarkKey("0x" + COMPLIANCE_PRIVATE_KEY.toString(16));
  const constructorCalldata = CallData.compile({
    governance_admin: ctx.account.address,
    compliance_public_key: compliancePublicKey,
  });

  return deployViaUDC(ctx.account, ctx.provider, ctx.privacyClassHash, constructorCalldata);
}

/**
 * Deploy the Echo contract.
 * Returns a Contract instance.
 */
export async function deployEchoContract(
  ctx: TestContext,
  salt: string = "0x0"
): Promise<Contract> {
  const echoAddress = await deployViaUDC(ctx.account, ctx.provider, ctx.echoClassHash, [], salt);

  return new Contract({
    abi: ctx.echoAbi,
    address: echoAddress,
    providerOrAccount: ctx.provider,
  });
}
