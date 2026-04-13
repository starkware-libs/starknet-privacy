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
import { hash } from "starknet";
import { Devnet, createDevnetTestEnv, type DevnetTestEnv } from "../src/testing/index.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";
import { debugLog } from "../src/utils/logging.js";

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
      devnet = new Devnet();
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

  // ============ Fee Simulation ============
  // simulate() returns a mock CallAndProof suitable for gas estimation without real proving.
  // End-to-end flow: simulate at a historical block → check structure → estimate fee →
  // execute for real and verify simulate didn't consume state.

  it("simulate → structure + historical block + fee estimate + execute without collision", async () => {
    const { env, transfers } = testEnv;

    // Fresh deposit so alice has a known note to spend.
    await env.alice.execute({
      contractAddress: env.strk,
      entrypoint: "approve",
      calldata: [env.privacy.address, 100n, 0n],
    });
    const depositResult = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(env.strk)
      .deposit({ amount: 100n })
      .surplusTo(env.alice.address)
      .execute();
    const depositReceipt = await devnet.executeOutside(depositResult.callAndProof);
    expect(depositReceipt.isReverted()).toBe(false);

    // Advance empty blocks so latestBlock - 1 has identical state to latest —
    // otherwise the SDK's index expectations (computed from latest) won't match at olderBlock.
    const rpcUrl = devnet.url;
    for (let blockIndex = 0; blockIndex < 5; blockIndex++) {
      await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
      });
    }
    const latestBlock = await env.provider.getBlockNumber();
    const olderBlock = latestBlock - 1;

    const buildOptions = {
      autoDiscover: { notes: "refresh", channels: "refresh" } as const,
      autoSelectNotes: "naive" as const,
      registryConst: true,
    };

    // Simulate a withdraw at olderBlock — wallet gets a CallAndProof with mock proofFacts.
    const simResult = await transfers.alice
      .build({ ...buildOptions, provingBlockId: olderBlock })
      .with(env.strk)
      .withdraw({ amount: 50n, recipient: env.alice.address })
      .surplusTo(env.alice.address)
      .simulate();

    // Structure checks
    expect(simResult.callAndProof.call.entrypoint).toBe("apply_actions");
    expect(simResult.callAndProof.call.contractAddress).toBeDefined();
    expect(simResult.callAndProof.proof.proofFacts.length).toBe(9);

    // provingBlockId flowed through — proofFacts[4] (base_block_number) derived from olderBlock.
    const baseBlockNumber = BigInt(simResult.callAndProof.proof.proofFacts[4]);
    const expectedBase = BigInt(olderBlock) > 10n ? BigInt(olderBlock) - 10n : 1n;
    expect(baseBlockNumber).toBe(expectedBase);

    // Wallet feeds the simulated CallAndProof into starknet.js's native fee estimation.
    // proofFacts flow into the transaction-level fields; proof data is ignored under
    // devnet's --proof-mode none. skipValidate bypasses account-signature validation.
    const fee = await env.alice.estimateInvokeFee(simResult.callAndProof.call, {
      proofFacts: simResult.callAndProof.proof.proofFacts,
      skipValidate: true,
    });
    expect(BigInt(fee.overall_fee)).toBeGreaterThan(0n);

    // Execute the same withdrawal for real — must succeed because simulate didn't consume the note.
    const execResult = await transfers.alice
      .build(buildOptions)
      .with(env.strk)
      .withdraw({ amount: 50n, recipient: env.alice.address })
      .surplusTo(env.alice.address)
      .execute();

    // Same call shape as the simulation (same contract, entrypoint, calldata length).
    expect(simResult.callAndProof.call.contractAddress).toBe(
      execResult.callAndProof.call.contractAddress
    );
    expect(simResult.callAndProof.call.entrypoint).toBe(execResult.callAndProof.call.entrypoint);
    expect(simResult.callAndProof.call.calldata!.length).toBe(
      execResult.callAndProof.call.calldata!.length
    );
    expect(execResult.callAndProof.proof.proofFacts.length).toBe(9);

    // Submit the execute — must not revert (proves simulate didn't touch on-chain state).
    const execReceipt = await devnet.executeOutside(execResult.callAndProof);
    expect(execReceipt.isReverted()).toBe(false);
  }, 120000);
});
