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
        .transfer({ recipient: env.alice.address, amount: Open })
        .with(env.bee)
        .transfer({ recipient: env.alice.address, amount: Open })
        .done()
        .invoke(({ openNotes, withdrawals }) => {
          // TODO: once contract enforces "no unfilled open notes at tx end",
          // this should be 1 and this flow should revert if an extra open note is left unfilled.
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
        .transfer({ recipient: env.alice.address, amount: Open })
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
