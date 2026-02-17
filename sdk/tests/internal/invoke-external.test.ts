/**
 * Tests for InvokeExternal (staged changes: invokes array, .call(callDetails), no FollowupCall).
 * Covers compiler output, serialization, and multiple invokes in one execute.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, MockTestEnv, POOL_ADDRESS } from "../helpers/test-fixtures.js";
import { ActionCompiler } from "../../src/internal/compiler.js";
import { serializeClientActions } from "../../src/internal/serialization.js";
import type { ClientAction } from "../../src/internal/client-actions.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";
import { AddressMap } from "../../src/utils/maps.js";
import { toBigInt, toHex } from "../../src/utils/index.js";
import { derivePublicKey } from "../../src/utils/crypto.js";
import { compute_channel_key, compute_note_id } from "../../src/utils/hashes.js";
import { Open, SetupRequirement } from "../../src/interfaces.js";
import type { DiscoveryProviderInterface } from "../../src/interfaces.js";
import { cloneNotesCursor } from "../../src/internal/channel.js";

/** Minimal discovery provider for compiler tests that only use invokes. */
const noopDiscovery: DiscoveryProviderInterface = {
  discoverNotes: async () => ({
    timestamp: 0,
    notes: new AddressMap(() => []),
    cursor: cloneNotesCursor(),
  }),
  discoverChannels: async () => ({ timestamp: 0, channels: undefined, total: undefined }),
  discoverRequirement: async () => SetupRequirement.Register,
};

describe("InvokeExternal (staged changes)", () => {
  const userAddress = 0x123n;
  const viewingKey = 0x456n;

  describe("compiler produces InvokeExternal client actions", () => {
    it("single invoke becomes one InvokeExternal action with contract_address and calldata", async () => {
      const compiler = new ActionCompiler(userAddress, viewingKey, noopDiscovery);
      const contractAddress = 0xabcn;
      const calldata = [1n, 2n, 3n];

      const { clientActions } = await compiler.compile({
        invokes: [{ callDetails: { contractAddress: toHex(contractAddress), calldata } }],
      });

      const invokeActions = clientActions.filter(
        (a): a is Extract<ClientAction, { type: "InvokeExternal" }> => a.type === "InvokeExternal"
      );
      expect(invokeActions).toHaveLength(1);
      expect(invokeActions[0].type).toBe("InvokeExternal");
      expect(toBigInt(invokeActions[0].input.contract_address)).toBe(contractAddress);
      expect(invokeActions[0].input.calldata).toEqual(calldata);
    });

    it("multiple invokes become multiple InvokeExternal actions in order", async () => {
      const compiler = new ActionCompiler(userAddress, viewingKey, noopDiscovery);

      const { clientActions } = await compiler.compile({
        invokes: [
          { callDetails: { contractAddress: toHex(0x1n), calldata: [10n] } },
          { callDetails: { contractAddress: toHex(0x2n), calldata: [20n, 21n] } },
        ],
      });

      const invokeActions = clientActions.filter(
        (a): a is Extract<ClientAction, { type: "InvokeExternal" }> => a.type === "InvokeExternal"
      );
      expect(invokeActions).toHaveLength(2);
      expect(toBigInt(invokeActions[0].input.contract_address)).toBe(0x1n);
      expect(invokeActions[0].input.calldata).toEqual([10n]);
      expect(toBigInt(invokeActions[1].input.contract_address)).toBe(0x2n);
      expect(invokeActions[1].input.calldata).toEqual([20n, 21n]);
    });
  });

  describe("serialization includes InvokeExternal", () => {
    it("InvokeExternal is serialized to Cairo enum (not filtered out)", () => {
      const actions: ClientAction[] = [
        {
          type: "InvokeExternal",
          input: { contract_address: 0x99n, calldata: [7n, 8n] },
        },
      ];
      const enums = serializeClientActions(actions);
      expect(enums).toHaveLength(1);
      expect(enums[0].activeVariant()).toBe("InvokeExternal");
    });
  });

  describe("multiple .call() in one execute", () => {
    let testEnv: MockTestEnv;

    beforeEach(() => {
      testEnv = createTestEnv();
    });

    it("two invokes in one execute both run (mock pool applies both)", async () => {
      const { mocknet, env, transfers } = testEnv;
      const ace = toBigInt(env.ace);
      const bee = toBigInt(env.bee);

      const helper1 = new MockSwapHelper("0x53A2", env.contracts);
      const helper2 = new MockSwapHelper("0x53A3", env.contracts);
      env.contracts.register(helper1);
      env.contracts.register(helper2);

      mocknet.executeOutside(await transfers.alice.build().register().execute());

      const key = compute_channel_key(
        env.alice.address,
        env.alice.privateKey,
        env.alice.address,
        derivePublicKey(env.alice.privateKey)
      );
      const beeNoteId0 = compute_note_id(key, bee, 0);
      const beeNoteId1 = compute_note_id(key, bee, 1);

      // Open subchannel for BEE at index 1 so we can have a second open note
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

      // Single execute: withdraw 10 to helper1, 5 to helper2; surplus 85 to self; two open notes; two .call()
      mocknet.executeOutside(
        await transfers.alice
          .build({
            autoDiscover: { channels: "refresh", notes: "refresh" },
            autoSetup: true,
            autoSelectNotes: "all",
          })
          .with(env.ace)
          .inputs(...((await transfers.alice.discoverNotes()).notes.get(ace) ?? []))
          .withdraw({ recipient: helper1.address, amount: 10n })
          .withdraw({ recipient: helper2.address, amount: 5n })
          .surplusTo(env.alice.address, false)
          .with(env.bee)
          .transfer({ recipient: env.alice.address, amount: Open, depositor: helper1.address })
          .transfer({ recipient: env.alice.address, amount: Open, depositor: helper2.address })
          .done()
          .call({
            contractAddress: toHex(helper1.address),
            calldata: [ace, bee, 10n, POOL_ADDRESS, beeNoteId0],
          })
          .call({
            contractAddress: toHex(helper2.address),
            calldata: [ace, bee, 5n, POOL_ADDRESS, beeNoteId1],
          })
          .execute()
      );

      // Helper1 gives 2x (20 BEE), helper2 gives 2x (10 BEE) -> 30 BEE total in two notes
      const beeNotes = (await transfers.alice.discoverNotes()).notes.get(bee) ?? [];
      expect(beeNotes.length).toBe(2);
      const amounts = beeNotes.map((n) => n.amount).sort((a, b) => (a < b ? -1 : 1));
      expect(amounts).toEqual([10n, 20n]);
    });
  });
});
