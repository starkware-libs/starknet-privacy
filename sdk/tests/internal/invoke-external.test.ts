/**
 * Tests for InvokeExternal: at most one invoke per transaction.
 * Single integration test covers compile → serialize → execute with one .call().
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, MockTestEnv, POOL_ADDRESS } from "../helpers/test-fixtures.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";
import { toBigInt, toHex } from "../../src/utils/index.js";
import { derivePublicKey } from "../../src/utils/crypto.js";
import { compute_channel_key, compute_note_id } from "../../src/utils/hashes.js";
import { Open } from "../../src/interfaces.js";

describe("InvokeExternal (at most one invoke per tx)", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  it("one .call() in one execute is compiled, serialized, and applied by the pool", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const helper = new MockSwapHelper("0x53A2", env.contracts);
    env.contracts.register(helper);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    const key = compute_channel_key(
      env.alice.address,
      env.alice.privateKey,
      env.alice.address,
      derivePublicKey(env.alice.privateKey)
    );
    const beeNoteId0 = compute_note_id(key, bee, 0);

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
        .done()
        .call({
          contractAddress: toHex(helper.address),
          calldata: [ace, bee, 10n, POOL_ADDRESS, beeNoteId0],
        })
        .execute()
    );

    const beeNotes = (await transfers.alice.discoverNotes()).notes.get(bee) ?? [];
    expect(beeNotes.length).toBe(1);
    expect(beeNotes[0].amount).toBe(20n);
  });
});
