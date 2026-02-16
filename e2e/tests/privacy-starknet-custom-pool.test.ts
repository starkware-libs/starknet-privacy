import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import {
  Account,
  RpcProvider,
  type constants,
} from "starknet";
import { CallMockProofProvider, IndexerDiscoveryProvider } from "starknet-sdk/testing";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  SetupRequirement,
  type AccountSignerRaw,
  type Proof,
  type ProofInvocation,
  type ProofInvocationFactoryDetails,
  type ProofProviderInterface,
} from "starknet-sdk";
import { IndexerClient } from "../src/indexer-client.js";

// Integration Sepolia chain ID. Keep as hex string so starknet.js never coerces to Number (→ float → BigInt fails).
const INTEGRATION_SEPOLIA_CHAIN_ID = "0x534e5f494e544547524154494f4e5f5345504f4c4941";

const RPC = "http://34.170.239.64:9545/rpc/v0_10";
const WS = "ws://34.170.239.64:9545/ws/rpc/v0_8";

// Custom pool and depositor for this test
const POOL = "0x2540a0877b7955ab018e0f313666a9bad629a16ce94009da62b44c9aa12a086";
const DEPOSITOR_ADDRESS = "0x041c9dbe8ab9b414fa0ec4d22b7a41d80a3911b77a2c9c819ce949faa5edb9f9";
const TOKEN = "0x7b19e89252b1ee5d7ff07a0e0e278b16b058f322053f799469b969e31b82969";

const CHAIN_ID = INTEGRATION_SEPOLIA_CHAIN_ID as constants.StarknetChainId;
const PROVING_SERVICE_URL = process.env.PROVING_SERVICE_URL ?? "http://136.115.124.93:3000";

// Manual resource bounds for integration sepolia (no tip oracle data available).
const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;
const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 1_100n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

function createProvingProvider(
  provider: RpcProvider,
  account: Account,
): ProofProviderInterface {
  return new ProvingServiceProofProvider(
      PROVING_SERVICE_URL,
      provider,
      CHAIN_ID,
      account,
      { requestTimeoutMs: 600_000 },
    );
  }

const accounts = JSON.parse(
  readFileSync(new URL("../accounts.json", import.meta.url), "utf-8"),
) as Array<{ address: string; private_key: string }>;

// Normalize address for comparison (strip 0x prefix and lowercase)
function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/, "").toLowerCase();
  return hex.length % 2 === 0 ? hex : "0" + hex;
}

const admin = accounts[0]; // minter
const depositor = accounts.find(
  (a) => normalizeAddress(a.address) === normalizeAddress(DEPOSITOR_ADDRESS),
);
if (!depositor) {
  throw new Error(
    `accounts.json must contain an account with address ${DEPOSITOR_ADDRESS} (the depositor).`,
  );
}

describe("Privacy StarkNet integration (custom pool)", () => {
  let indexer: IndexerClient;
  let discovery: IndexerDiscoveryProvider;
  let provider: RpcProvider;
  let adminAccount: Account;
  let depositorAccount: Account;

  beforeAll(async () => {
    provider = new RpcProvider({ nodeUrl: RPC });
    adminAccount = new Account({
      provider,
      address: admin.address,
      signer: admin.private_key,
      cairoVersion: "1",
    });
    depositorAccount = new Account({
      provider,
      address: depositor.address,
      signer: depositor.private_key,
      cairoVersion: "1",
    });

    indexer = await IndexerClient.spawn({
      wsUrl: WS,
      rpcUrl: RPC,
      logFile: "privacy-starknet-custom-pool-indexer.log",
    });
    await indexer.waitForLog("API server listening", 30_000);

    discovery = new IndexerDiscoveryProvider(indexer.apiUrl, POOL);
  }, 60_000);

  afterAll(() => {
    indexer?.shutdown();
  });

  it("preflight returns a valid SetupRequirement", async () => {
    // Use a placeholder viewing key; replace with depositor's real viewing key if you have it
    const viewingKey = 0x254055e37555fd981daf35700e046e42980f4e041d7aaec4886c0c1a46a06;
    const requirement = await discovery.discoverRequirement(
      BigInt(depositor.address),
      viewingKey,
      BigInt(depositor.address),
      BigInt(TOKEN),
    );
    expect(requirement).toBeGreaterThanOrEqual(SetupRequirement.Register);
    expect(requirement).toBeLessThanOrEqual(SetupRequirement.Ready);
  });

  it("deposit to custom pool for depositor address", async () => {
    const transfers = createPrivateTransfers({
      account: depositorAccount as unknown as AccountSignerRaw,
      viewingKeyProvider: { getViewingKey: () => 0x254055e37555fd981daf35700e046e42980f4e041d7aaec4886c0c1a46a06 },
      provingProvider: createProvingProvider(provider, depositorAccount),
      discoveryProvider: discovery,
      poolContractAddress: POOL,
    });

    // Mint tokens to depositor (admin is the minter)
    const mintTx = await adminAccount.execute(
      {
        contractAddress: TOKEN,
        entrypoint: "permissionedMint",
        calldata: [depositor.address, "100", "0"],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    await provider.waitForTransaction(mintTx.transaction_hash);

    // Approve pool to spend depositor's tokens
    const approveTx = await depositorAccount.execute(
      {
        contractAddress: TOKEN,
        entrypoint: "approve",
        calldata: [POOL, "100", "0"],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    await provider.waitForTransaction(approveTx.transaction_hash);

    // Deposit 100 tokens to the depositor's address on the custom pool
    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (t) =>
        t.deposit({ amount: 100n, recipient: depositor.address }),
      )
      .execute();

    const executeTx = await depositorAccount.execute(callAndProof.call, {
      tip: 0n,
      resourceBounds: POOL_RESOURCE_BOUNDS,
      ...(callAndProof.proofFacts?.length
        ? { proofFacts: callAndProof.proofFacts }
        : {}),
    });
    const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
    if (!receipt.isSuccess()) {
      console.error(
        "Transaction reverted:",
        JSON.stringify(receipt, null, 2),
      );
    }
    expect(receipt.isSuccess()).toBe(true);
  }, 120_000);
});
