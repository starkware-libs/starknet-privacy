/**
 * Tests for InvokeExternal: at most one invoke per transaction.
 * Integration test covers compile → serialize → execute with one .invoke(); unhappy flow asserts double .invoke() throws.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, MockTestEnv, POOL_ADDRESS } from "../helpers/test-fixtures.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";
import { toBigInt, toHex } from "../../src/utils/index.js";
import { Open } from "../../src/interfaces.js";

describe("InvokeExternal (at most one invoke per tx)", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  it("one .invoke() in one execute is compiled, serialized, and applied by the pool", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const helper = new MockSwapHelper("0x53A2", env.contracts, POOL_ADDRESS);
    env.contracts.register(helper);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    mocknet.executeOutside(
      await transfers.alice
        .build({ autoDiscover: { channels: "refresh", notes: "refresh" }, autoSetup: true })
        .with(env.ace)
        .deposit({ amount: 100n })
        .execute()
    );
    mocknet.executeOutside(
      await transfers.alice
        .build({ autoDiscover: { channels: "refresh", notes: "refresh" }, autoSetup: true })
        .with(env.bee)
        .setup(env.alice.address)
        .execute()
    );

    mocknet.executeOutside(
      await transfers.alice
        .build({
          autoDiscover: { channels: "refresh", notes: "refresh" },
          autoSetup: true,
          autoSelectNotes: "all",
        })
        .with(env.ace)
        .inputs(...((await transfers.alice.discoverNotes()).notes.get(ace) ?? []))
        .withdraw({ recipient: helper.address, amount: 10n })
        .surplusTo(env.alice.address, false)
        .with(env.bee)
        .transfer({ recipient: env.alice.address, amount: Open, depositor: helper.address })
        .with(env.bee)
        .transfer({ recipient: env.alice.address, amount: Open, depositor: helper.address })
        .done()
        .invoke(({ openNotes, withdrawals }) => {
          expect(openNotes.length).toBe(2);
          expect(openNotes[0].token).toBe(bee);
          expect(withdrawals.length).toBe(1);
          expect(withdrawals[0].recipient).toBe(toBigInt(helper.address));
          expect(withdrawals[0].token).toBe(ace);
          expect(withdrawals[0].amount).toBe(10n);
          return {
            contractAddress: toHex(helper.address),
            calldata: [ace, bee, 10n, openNotes[0].noteId],
          };
        })
        .execute()
    );

    const beeNotes = (await transfers.alice.discoverNotes()).notes.get(bee) ?? [];
    expect(beeNotes.length).toBe(2);
    expect(beeNotes.some((note) => note.amount === 20n)).toBe(true);
  });

  it("open note and fee withdrawal on the same toToken do not trigger INDEX_NOT_SEQUENTIAL", async () => {
    // Regression test: when toToken == feeToken in a private swap, the compiler
    // previously emitted CreateEncNote (change note, index N+1) before CreateOpenNote
    // (open note, index N) for the same token — causing INDEX_NOT_SEQUENTIAL on-chain.
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const helper = new MockSwapHelper("0x53A2", env.contracts, POOL_ADDRESS);
    env.contracts.register(helper);

    // Register Alice and give her existing bee notes (index 0) so the fee
    // withdrawal needs to consume them and produce a change note at index 2,
    // while the open note from the swap lands at index 1.
    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(
      await transfers.alice
        .build({ autoDiscover: { channels: "refresh", notes: "refresh" }, autoSetup: true })
        .with(env.ace)
        .deposit({ amount: 100n })
        .execute()
    );
    mocknet.executeOutside(
      await transfers.alice
        .build({ autoDiscover: { channels: "refresh", notes: "refresh" }, autoSetup: true })
        .with(env.bee)
        .deposit({ amount: 50n })
        .execute()
    );

    const swapAmount = 10n;
    const feeAmount = 5n;

    // Swap ace → bee (open note) + fee withdrawal from bee (same token as open note).
    // The correct on-chain order must be: UseNote(0) → CreateOpenNote(1) → CreateEncNote(2).
    mocknet.executeOutside(
      await transfers.alice
        .build({
          autoDiscover: { channels: "refresh", notes: "refresh" },
          autoSetup: true,
          autoSelectNotes: "all",
        })
        .surplusTo(env.alice.address)
        .with(env.ace)
        .withdraw({ recipient: helper.address, amount: swapAmount })
        .surplusTo(env.alice.address, false)
        .with(env.bee)
        .transfer({ recipient: env.alice.address, amount: Open, depositor: helper.address })
        .done()
        .with(env.bee, (t) => t.withdraw({ recipient: env.alice.address, amount: feeAmount }))
        .invoke(({ openNotes }) => {
          const openNote = openNotes[0];
          if (!openNote) throw new Error("Expected one open note");
          return {
            contractAddress: toHex(helper.address),
            calldata: [ace, bee, swapAmount, openNote.noteId],
          };
        })
        .execute()
    );

    const beeNotes = (await transfers.alice.discoverNotes()).notes.get(bee) ?? [];
    // Change note: 50 (existing) - 5 (fee) = 45
    expect(beeNotes.some((note) => note.amount === 45n)).toBe(true);
    // Open note filled by helper: swapAmount * 2 = 20 (MockSwapHelper doubles the amount)
    expect(beeNotes.some((note) => note.open && note.amount === swapAmount * 2n)).toBe(true);
  });

  it("two .invoke() on the builder throws", async () => {
    const { env, transfers } = testEnv;
    const helper = new MockSwapHelper("0x53A2", env.contracts, POOL_ADDRESS);
    env.contracts.register(helper);

    const builder = transfers.alice
      .build({ autoDiscover: { channels: "refresh", notes: "refresh" } })
      .with(env.ace)
      .deposit({ amount: 10n })
      .done()
      .invoke(() => {
        return {
          contractAddress: toHex(helper.address),
          calldata: [1n, 2n],
        };
      });

    expect(() =>
      builder.invoke(() => {
        return {
          contractAddress: toHex(helper.address),
          calldata: [3n, 4n],
        };
      })
    ).toThrow("At most one .invoke() per transaction; already set.");
  });

  it("deposit -> withdraw + invoke works with auto-setup", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);
    const helper = new MockSwapHelper("0x53A2", env.contracts, POOL_ADDRESS);
    env.contracts.register(helper);

    mocknet.executeOutside(
      await transfers.alice
        .build({
          autoRegister: true,
          autoSetup: true,
          autoDiscover: { channels: "refresh", notes: "refresh" },
          autoSelectNotes: "all",
        })
        .with(env.ace)
        .deposit({ amount: 100n })
        .withdraw({ recipient: helper.address, amount: 10n })
        .surplusTo(env.alice.address, false)
        .with(env.bee)
        .transfer({ recipient: env.alice.address, amount: Open, depositor: helper.address })
        .done()
        .invoke(({ openNotes, withdrawals }) => {
          expect(openNotes.length).toBe(1);
          expect(openNotes[0].token).toBe(bee);
          expect(withdrawals.length).toBe(1);
          expect(withdrawals[0].recipient).toBe(toBigInt(helper.address));
          expect(withdrawals[0].token).toBe(ace);
          expect(withdrawals[0].amount).toBe(10n);
          return {
            contractAddress: toHex(helper.address),
            calldata: [ace, bee, 10n, openNotes[0].noteId],
          };
        })
        .execute()
    );

    const discovered = await transfers.alice.discoverNotes();
    const aceNotes = discovered.notes.get(ace) ?? [];
    const beeNotes = discovered.notes.get(bee) ?? [];

    expect(aceNotes.length).toBe(1);
    expect(aceNotes[0].amount).toBe(90n);
    expect(beeNotes.some((note) => note.open && note.amount === 20n)).toBe(true);
  });
});
