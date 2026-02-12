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
  SetupRequirement,
  type Proof,
  type ProofInvocation,
  type ProofInvocationFactoryDetails,
  type ProofProviderInterface,
} from "starknet-sdk";
import { IndexerClient } from "../src/indexer-client.js";

const RPC = "http://34.170.239.64:9545/rpc/v0_10";
const WS = "ws://34.170.239.64:9545/ws/rpc/v0_8";
const POOL =
  "0x29a9cf26f2de1dbe16923fd6da791a2158497baeb9cc2fb8f99ed464938d731";
const TOKEN =
  "0x7b19e89252b1ee5d7ff07a0e0e278b16b058f322053f799469b969e31b82969";
const CHAIN_ID =
  "0x534e5f494e544547524154494f4e5f5345504f4c4941" as constants.StarknetChainId;

// Manual resource bounds for integration sepolia (no tip oracle data available).
// Actual block prices: l2_gas=8e9, l1_gas=1e12, l1_data_gas=1000.
// We use 2x headroom on prices. L1 gas usage is always 0 but sequencer enforces min price.
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

/**
 * Proof provider that calls execute_view directly (view function, no signature).
 * The standard CallMockProofProvider uses account.execute which requires
 * is_valid_signature — not available on all account types.
 */
class NoValidateProofProvider implements ProofProviderInterface {
  constructor(
    private readonly provider: RpcProvider,
    private readonly chainId: constants.StarknetChainId,
  ) {}

  getDefaultDetails(): ProofInvocationFactoryDetails {
    return new CallMockProofProvider(this.provider, this.chainId).getDefaultDetails();
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata!,
    });
    return { output: result, data: undefined!, proof_facts: [] };
  }
}

const accounts = JSON.parse(
  readFileSync(new URL("../accounts.json", import.meta.url), "utf-8"),
) as Array<{ address: string; private_key: string }>;
const admin = accounts[0]; // minter
const alice = accounts[1];

describe("Privacy StarkNet integration", () => {
  let indexer: IndexerClient;
  let discovery: IndexerDiscoveryProvider;
  let provider: RpcProvider;
  let adminAccount: Account;
  let aliceAccount: Account;

  beforeAll(async () => {
    provider = new RpcProvider({ nodeUrl: RPC });
    adminAccount = new Account({
      provider,
      address: admin.address,
      signer: admin.private_key,
      cairoVersion: "1",
    });
    aliceAccount = new Account({
      provider,
      address: alice.address,
      signer: alice.private_key,
      cairoVersion: "1",
    });

    indexer = await IndexerClient.spawn({
      wsUrl: WS,
      rpcUrl: RPC,
      contractAddress: POOL,
      logFile: "privacy-starknet-integration-indexer.log",
    });
    await indexer.waitForLog("API server listening", 30_000);

    discovery = new IndexerDiscoveryProvider(indexer.apiUrl);
  }, 60_000);

  afterAll(() => {
    indexer?.shutdown();
  });

  it("preflight returns a valid SetupRequirement", async () => {
    const requirement = await discovery.discoverRequirement(
      BigInt(alice.address),
      0xA11CEn,
      BigInt(alice.address),
      BigInt(TOKEN),
    );
    expect(requirement).toBeGreaterThanOrEqual(SetupRequirement.Register);
    expect(requirement).toBeLessThanOrEqual(SetupRequirement.Ready);
  });

  it("deposit with auto-register", async () => {
    const transfers = createPrivateTransfers({
      account: aliceAccount,
      viewingKeyProvider: { getViewingKey: () => 0xA11CEn },
      provingProvider: new NoValidateProofProvider(provider, CHAIN_ID),
      discoveryProvider: discovery,
      poolContractAddress: POOL,
    });

    // Mint tokens to Alice (admin is the minter)
    const mintTx = await adminAccount.execute({
      contractAddress: TOKEN,
      entrypoint: "permissionedMint",
      calldata: [alice.address, "100", "0"],
    }, { resourceBounds: ERC20_RESOURCE_BOUNDS });
    await provider.waitForTransaction(mintTx.transaction_hash);

    // Approve pool to spend Alice's tokens
    const approveTx = await aliceAccount.execute({
      contractAddress: TOKEN,
      entrypoint: "approve",
      calldata: [POOL, "100", "0"],
    }, { resourceBounds: ERC20_RESOURCE_BOUNDS });
    await provider.waitForTransaction(approveTx.transaction_hash);

    // Deposit 100 tokens — SDK checks state internally and skips if already done
    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (t) => t.deposit({ amount: 100n, recipient: alice.address }))
      .execute();

    // Submit on-chain
    const executeTx = await aliceAccount.execute(
      callAndProof.call,
      { resourceBounds: POOL_RESOURCE_BOUNDS },
    );
    const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
    if (!receipt.isSuccess()) {
      console.error("Transaction reverted:", JSON.stringify(receipt, null, 2));
    }
    expect(receipt.isSuccess()).toBe(true);
  }, 120_000);
});
