/**
 * Devnet integration tests
 *
 * These tests instantiate a local Starknet devnet, deploy contracts,
 * and test real interactions with the privacy pool.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CallData, constants, hash } from "starknet";
import { Devnet, createDevnetTestEnv, type DevnetTestEnv } from "../src/testing/index.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";
import { debugLog } from "../src/utils/logging.js";
import { PrivacyPoolABI } from "../src/internal/abi.js";
import { estimateServerActionCounts } from "../src/internal/paymaster/fee-estimator.js";
import { createPrivateTransfers } from "../src/factory.js";
import { Open, type Actions } from "../src/interfaces.js";
import { toBigInt } from "../src/utils/index.js";
import { CallMockProofProvider } from "../src/testing/mock-proving.js";
import { ContractDiscoveryProvider } from "../src/internal/contract-discovery.js";

/** ABI variant name (PascalCase) → estimator key (camelCase) */
const SERVER_ACTION_VARIANT_TO_KEY: Record<string, string> = {
  WriteOnce: "writeOnce",
  Append: "append",
  TransferFrom: "transferFrom",
  TransferTo: "transferTo",
  EmitViewingKeySet: "emitViewingKeySet",
  EmitWithdrawal: "emitWithdrawal",
  EmitDeposit: "emitDeposit",
  EmitOpenNoteCreated: "emitOpenNoteCreated",
  EmitEncNoteCreated: "emitEncNoteCreated",
  EmitNoteUsed: "emitNoteUsed",
  Invoke: "invoke",
};

/**
 * Count server action types from the raw L2-to-L1 message payload.
 * Payload format: [class_hash, ...serialized_span_of_server_actions]
 */
function countServerActionsFromPayload(messagePayload: string[]): Record<string, number> {
  const serverActionsCalldata = messagePayload.slice(1);
  const decoder = new CallData(PrivacyPoolABI);
  const decoded = decoder.decodeParameters(
    "core::array::Span::<privacy::actions::ServerAction>",
    serverActionsCalldata
  ) as unknown[];

  const counts: Record<string, number> = {};
  for (const action of decoded) {
    const variant = (action as { activeVariant(): string }).activeVariant();
    const key = SERVER_ACTION_VARIANT_TO_KEY[variant] ?? variant;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MOCK_AMM_CLASS = join(__dirname, "../../target/dev/privacy_MockAMM.contract_class.json");
const MOCK_AMM_COMPILED = join(
  __dirname,
  "../../target/dev/privacy_MockAMM.compiled_contract_class.json"
);
const MOCK_EXECUTOR_CLASS = join(
  __dirname,
  "../../target/dev/privacy_MockSwapExecutor.contract_class.json"
);
const MOCK_EXECUTOR_COMPILED = join(
  __dirname,
  "../../target/dev/privacy_MockSwapExecutor.compiled_contract_class.json"
);

describe("Devnet Integration", () => {
  let devnet: Devnet;
  let testEnv: DevnetTestEnv;
  let setupError: Error | undefined;

  beforeAll(async () => {
    try {
      devnet = new Devnet({ userAccounts: 3 });
      testEnv = await createDevnetTestEnv(devnet);
    } catch (e) {
      if (e instanceof Error) {
        const message = e.message || `${e.name}: ${e.stack ?? String(e)}`;
        setupError = new Error(message);
      } else {
        setupError = new Error(String(e));
      }
    }
  }, 120000); // 120 second timeout for devnet startup and deployment

  // Workaround: vitest silently skips tests when beforeAll throws instead of
  // failing them (https://github.com/vitest-dev/vitest/issues/4820).
  // Re-throw in beforeEach so each test reports an explicit failure.
  beforeEach(() => {
    if (setupError) {
      throw new Error(`beforeAll failed: ${setupError.message}`);
    }
  });

  afterAll(async () => {
    await devnet?.cleanup();
  });

  it("should setup devnet with alice, bob, tokens, and privacy contract", async () => {
    const { env } = testEnv;

    // Verify Alice account
    expect(env.alice.address).toBeDefined();
    expect(env.alice.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Alice address:", env.alice.address);

    // Verify Bob account
    expect(env.bob.address).toBeDefined();
    expect(env.bob.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Bob address:", env.bob.address);

    // Verify token addresses
    expect(env.eth).toBeDefined();
    expect(env.strk).toBeDefined();
    console.log("ETH token:", env.eth);
    console.log("STRK token:", env.strk);

    // Verify privacy contract
    expect(env.privacy.address).toBeDefined();
    expect(env.privacy.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Privacy contract:", env.privacy.address);
  });

  it("should deposit 100 STRK to alice", async () => {
    const { env, transfers } = testEnv;

    // Approve the privacy pool to spend STRK tokens
    await env.alice.execute({
      contractAddress: env.strk,
      entrypoint: "approve",
      calldata: [env.privacy.address, 100n, 0n], // spender, amount_low, amount_high (u256)
    });

    const { callAndProof: bobCallAndProof } = await transfers.bob.build().register().execute();
    const bobReceipt = await devnet.executeOutside(bobCallAndProof);
    console.log("Bob register status:", bobReceipt.execution_status);
    if (bobReceipt.isReverted()) {
      console.error("Bob register REVERTED:", bobReceipt.revert_reason);
    }
    expect(bobReceipt.isReverted()).toBe(false);

    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(env.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: env.bob.address, amount: 50n })
      .surplusTo(env.alice.address)
      .execute();

    console.log("Alice deposit+transfer calldata length:", callAndProof.call.calldata.length);

    const receipt = await devnet.executeOutside(callAndProof);
    console.log("Alice deposit status:", receipt.execution_status);
    if (receipt.isReverted()) {
      console.error("Alice deposit REVERTED:", receipt.revert_reason);
    }
    expect(receipt.isReverted()).toBe(false);

    const notes = await transfers.alice.discoverNotes();
    debugLog("test", "should deposit", "notes", notes);

    expect(notes.notes.get(env.strk)?.length).toBe(1);
    expect(notes.notes.get(env.strk)?.[0].amount).toBe(50n);

    const { channels } = await transfers.alice.discoverChannels([env.bob.address]);
    debugLog("test", "should deposit", "channels", channels);

    expect(channels!.get(env.bob.address)?.tokens.get(env.strk)?.noteNonce).toBe(1);
  });

  it("should swap STRK to ETH through Cairo mock executor and create open note", async () => {
    const { env, transfers } = testEnv;
    const depositAmount = 100n;
    const swapAmount = 10n;
    const before = await transfers.alice.discoverNotes();
    const strkBefore = (before.notes.get(env.strk) ?? []).reduce(
      (sum, note) => sum + note.amount,
      0n
    );
    const ethBefore = (before.notes.get(env.eth) ?? []).reduce(
      (sum, note) => sum + note.amount,
      0n
    );

    const mockAmmClass = JSON.parse(readFileSync(MOCK_AMM_CLASS, "utf8"));
    const mockAmmCompiled = JSON.parse(readFileSync(MOCK_AMM_COMPILED, "utf8"));
    const mockAmmDeclare = await env.admin.declare({
      contract: mockAmmClass,
      casm: mockAmmCompiled,
      compiledClassHash: hash.computeCompiledClassHash(mockAmmCompiled),
    });
    const mockAmmDeploy = await env.admin.deployContract({
      classHash: mockAmmDeclare.class_hash,
      constructorCalldata: [],
      salt: "0x101",
    });
    const mockAmmAddress = mockAmmDeploy.contract_address;

    const mockExecutorClass = JSON.parse(readFileSync(MOCK_EXECUTOR_CLASS, "utf8"));
    const mockExecutorCompiled = JSON.parse(readFileSync(MOCK_EXECUTOR_COMPILED, "utf8"));
    const mockExecutorDeclare = await env.admin.declare({
      contract: mockExecutorClass,
      casm: mockExecutorCompiled,
      compiledClassHash: hash.computeCompiledClassHash(mockExecutorCompiled),
    });
    const mockExecutorDeploy = await env.admin.deployContract({
      classHash: mockExecutorDeclare.class_hash,
      constructorCalldata: [mockAmmAddress, hash.getSelectorFromName("swap")],
      salt: "0x102",
    });
    const mockExecutorAddress = mockExecutorDeploy.contract_address;

    await env.admin.execute({
      contractAddress: env.eth,
      entrypoint: "transfer",
      calldata: [mockAmmAddress, swapAmount, 0n],
    });

    await env.alice.execute({
      contractAddress: env.strk,
      entrypoint: "approve",
      calldata: [env.privacy.address, depositAmount, 0n],
    });

    const alice = new SimplePrivateTransfersImpl(transfers.alice);
    const depositResult = await alice.deposit(env.strk, depositAmount);
    const depositReceipt = await devnet.executeOutside(depositResult.callAndProof);
    expect(depositReceipt.isReverted()).toBe(false);

    const { callAndProof } = await alice.swap(env.strk, swapAmount, env.eth, mockExecutorAddress);

    const swapReceipt = await devnet.executeOutside(callAndProof);
    expect(swapReceipt.isReverted()).toBe(false);

    const discovered = await transfers.alice.discoverNotes();
    const ethNotes = discovered.notes.get(env.eth) ?? [];
    const ethAfter = ethNotes.reduce((sum, note) => sum + note.amount, 0n);
    expect(ethAfter - ethBefore).toBe(swapAmount);
    expect(ethNotes.some((note) => note.open && note.amount === swapAmount)).toBe(true);

    const strkNotes = discovered.notes.get(env.strk) ?? [];
    const strkAfter = strkNotes.reduce((sum, note) => sum + note.amount, 0n);
    expect(strkAfter - strkBefore).toBe(depositAmount - swapAmount);
  }, 120000);

  describe("fee estimator: server action counts match compile_actions", () => {
    /**
     * Compare estimated server action counts against actual counts from
     * the contract's compile_actions output.
     *
     * The estimator always includes +1 TransferTo + +1 EmitWithdrawal for
     * the fee withdrawal. Since these tests don't use autoPaymaster, subtract
     * that self-cost before comparing.
     *
     * Invoke is handled separately: the estimator doesn't count it in
     * ServerActionCounts (it uses per-executor lookup in FeeSchedule), but the
     * contract emits exactly 1 Invoke ServerAction per InvokeExternal client action.
     */
    function assertServerActionCounts(
      actions: Actions,
      messagePayload: string[],
      expectedInvokeCount = 0
    ) {
      const estimated: Record<string, number> = estimateServerActionCounts(actions, false);
      estimated.transferTo -= 1;
      estimated.emitWithdrawal -= 1;
      if (expectedInvokeCount > 0) {
        estimated.invoke = expectedInvokeCount;
      }

      const actual = countServerActionsFromPayload(messagePayload);

      for (const [key, expectedCount] of Object.entries(estimated)) {
        expect(
          actual[key] ?? 0,
          `${key}: estimated ${expectedCount}, actual ${actual[key] ?? 0}`
        ).toBe(expectedCount);
      }
      for (const [key, actualCount] of Object.entries(actual)) {
        expect(estimated[key] ?? 0, `unexpected action type ${key} with count ${actualCount}`).toBe(
          actualCount
        );
      }
    }

    it("SetViewingKey + OpenChannel + OpenSubchannel + Deposit + CreateEncNote", async () => {
      const { env } = testEnv;
      const charlie = env.extraAccounts[0];
      const chainId = constants.StarknetChainId.SN_SEPOLIA;

      const charlieTransfers = createPrivateTransfers({
        account: charlie,
        viewingKeyProvider: { getViewingKey: async () => toBigInt("0xC4A") },
        provingProvider: new CallMockProofProvider(env.provider, chainId),
        discoveryProvider: new ContractDiscoveryProvider(env.privacy),
        poolContractAddress: env.privacy.address,
      });

      // Fund Charlie with STRK and approve the privacy pool
      await env.admin.execute({
        contractAddress: env.strk,
        entrypoint: "transfer",
        calldata: [charlie.address, 200n, 0n],
      });
      await charlie.execute({
        contractAddress: env.strk,
        entrypoint: "approve",
        calldata: [env.privacy.address, 200n, 0n],
      });

      // Build: register + open channel to Alice + open subchannel + deposit + transfer to Alice
      const strkToken = toBigInt(env.strk);
      const aliceAddress = toBigInt(env.alice.address);

      const result = await charlieTransfers
        .build({
          autoRegister: true,
          autoSetup: true,
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(env.strk)
        .deposit({ amount: 100n })
        .transfer({ recipient: env.alice.address, amount: 30n })
        .surplusTo(charlie.address)
        .execute();

      // The builder + autoSetup produces these actions before compilation:
      // setViewingKey, openChannels (self + alice), openTokenChannels (self + alice),
      // deposits, createNotes (to alice + change to self)
      // Build the equivalent explicit Actions for the estimator.
      const actions: Actions = {
        setViewingKey: {},
        openChannels: [{ recipient: toBigInt(charlie.address) }, { recipient: aliceAddress }],
        openTokenChannels: [
          { recipient: toBigInt(charlie.address), token: strkToken },
          { recipient: aliceAddress, token: strkToken },
        ],
        deposits: [{ token: strkToken, amount: 100n }],
        createNotes: [
          { recipient: aliceAddress, token: strkToken, amount: 30n },
          { recipient: toBigInt(charlie.address), token: strkToken, amount: 70n },
        ],
      };

      assertServerActionCounts(actions, result.callAndProof.proof.output);

      const receipt = await devnet.executeOutside(result.callAndProof);
      expect(receipt.isReverted()).toBe(false);
    });

    it("UseNote + Withdraw + CreateEncNote (change)", async () => {
      const { env, transfers } = testEnv;
      const strkToken = toBigInt(env.strk);

      const { notes } = await transfers.alice.discoverNotes();
      const strkNotes = notes.get(env.strk) ?? [];
      expect(strkNotes.length).toBeGreaterThan(0);
      const note = strkNotes[0];

      const withdrawAmount = 10n;
      const changeAmount = note.amount - withdrawAmount;
      const aliceAddress = toBigInt(transfers.alice.user);

      const actions: Actions = {
        useNotes: [{ token: strkToken, note }],
        withdraws: [{ recipient: aliceAddress, token: strkToken, amount: withdrawAmount }],
        createNotes: [{ recipient: aliceAddress, token: strkToken, amount: changeAmount }],
      };

      const result = await transfers.alice
        .build()
        .with(env.strk)
        .inputs(note)
        .withdraw({ amount: withdrawAmount })
        .transfer({ recipient: transfers.alice.user, amount: changeAmount })
        .execute();

      assertServerActionCounts(actions, result.callAndProof.proof.output);

      const receipt = await devnet.executeOutside(result.callAndProof);
      expect(receipt.isReverted()).toBe(false);
    });

    it("UseNote + Withdraw + CreateOpenNote + Invoke", async () => {
      const { env, transfers } = testEnv;

      // Deploy mock AMM and executor for invoke testing
      const mockAmmClass = JSON.parse(readFileSync(MOCK_AMM_CLASS, "utf8"));
      const mockAmmCompiled = JSON.parse(readFileSync(MOCK_AMM_COMPILED, "utf8"));
      const mockAmmDeclare = await env.admin.declare({
        contract: mockAmmClass,
        casm: mockAmmCompiled,
        compiledClassHash: hash.computeCompiledClassHash(mockAmmCompiled),
      });
      const mockAmmDeploy = await env.admin.deployContract({
        classHash: mockAmmDeclare.class_hash,
        constructorCalldata: [],
        salt: "0x201",
      });

      const mockExecutorClass = JSON.parse(readFileSync(MOCK_EXECUTOR_CLASS, "utf8"));
      const mockExecutorCompiled = JSON.parse(readFileSync(MOCK_EXECUTOR_COMPILED, "utf8"));
      const mockExecutorDeclare = await env.admin.declare({
        contract: mockExecutorClass,
        casm: mockExecutorCompiled,
        compiledClassHash: hash.computeCompiledClassHash(mockExecutorCompiled),
      });
      const mockExecutorDeploy = await env.admin.deployContract({
        classHash: mockExecutorDeclare.class_hash,
        constructorCalldata: [mockAmmDeploy.contract_address, hash.getSelectorFromName("swap")],
        salt: "0x202",
      });
      const executorAddress = mockExecutorDeploy.contract_address;

      // Fund the AMM with ETH for the swap
      const swapAmount = 5n;
      await env.admin.execute({
        contractAddress: env.eth,
        entrypoint: "transfer",
        calldata: [mockAmmDeploy.contract_address, swapAmount, 0n],
      });

      // Alice needs a STRK note. Discover current notes.
      const { notes } = await transfers.alice.discoverNotes();
      const strkNotes = notes.get(env.strk) ?? [];
      expect(strkNotes.length).toBeGreaterThan(0);
      const note = strkNotes[0];
      expect(note.amount).toBeGreaterThan(swapAmount);

      const strkToken = toBigInt(env.strk);
      const ethToken = toBigInt(env.eth);
      const aliceAddress = toBigInt(transfers.alice.user);
      const executorAddressBigInt = toBigInt(executorAddress);
      const changeAmount = note.amount - swapAmount;

      // Build the swap: useNote + withdraw to executor + createOpenNote for ETH + invoke + change
      const alice = new SimplePrivateTransfersImpl(transfers.alice);

      // SimplePrivateTransfersImpl.swap does: useNote, withdraw, createOpenNote, invoke, surplus
      const result = await alice.swap(env.strk, swapAmount, env.eth, executorAddress);

      // Build equivalent explicit actions for the estimator
      const actions: Actions = {
        useNotes: [{ token: strkToken, note }],
        createNotes: [
          {
            recipient: aliceAddress,
            token: ethToken,
            amount: Open,
            depositor: executorAddressBigInt,
          },
          { recipient: aliceAddress, token: strkToken, amount: changeAmount },
        ],
        withdraws: [{ recipient: executorAddressBigInt, token: strkToken, amount: swapAmount }],
        invoke: {
          callBuilder: () => ({
            contractAddress: executorAddress,
            calldata: [],
          }),
        },
      };

      assertServerActionCounts(actions, result.callAndProof.proof.output, 1);

      const receipt = await devnet.executeOutside(result.callAndProof);
      expect(receipt.isReverted()).toBe(false);
    }, 120000);
  });
});
