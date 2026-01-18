import { describe, expect, it, beforeEach } from "vitest";
import {
  createTestEnv,
  setupSelfChannel,
  setupRecipientChannel,
  applyStateChanges,
  AUTO_ALL,
  ACE,
  BEE,
  ALICE,
  BOB,
  TestEnv,
} from "../helpers/test-fixtures.js";
import { SetupRequirement } from "../../src/interfaces.js";

describe("Edge Cases", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  describe("Validation", () => {
    it("rejects negative deposit amount", async () => {
      const { alice } = env;
      await setupSelfChannel(alice, ALICE.address, ACE);

      await expect(
        alice
          .build(AUTO_ALL)
          .with(ACE)
          .deposit({ amount: -100n, recipient: ALICE.address })
          .execute()
      ).rejects.toThrow(/Deposit amount must be positive/);
    });

    it("rejects negative withdraw amount", async () => {
      const { alice, bob } = env;

      // Setup Alice -> Bob and create a note
      applyStateChanges(await alice.build().register().execute());
      const registry = await setupRecipientChannel(alice, bob, BOB.address, ACE);

      applyStateChanges(
        await alice
          .build({ ...AUTO_ALL, registry })
          .with(ACE)
          .deposit({ amount: 100n, recipient: BOB.address })
          .execute()
      );

      const notes = (await bob.discoverNotes()).notes.get(ACE) ?? [];
      expect(notes.length).toBe(1);

      await expect(
        bob
          .build(AUTO_ALL)
          .with(ACE)
          .inputs(...notes)
          .withdraw({ amount: -50n })
          .execute()
      ).rejects.toThrow(/Withdraw amount must be positive/);
    });

    it("rejects negative transfer amount (created note)", async () => {
      const { alice, bob } = env;

      // Setup Alice's self channel and Alice -> Bob channel
      const selfRegistry = await setupSelfChannel(alice, ALICE.address, ACE);
      await setupRecipientChannel(alice, bob, BOB.address, ACE);

      // prettier-ignore
      applyStateChanges(
        await alice
          .build({ ...AUTO_ALL, registry: selfRegistry })
          .with(ACE)
          .deposit({ amount: 100n, recipient: ALICE.address })
          .execute()
      );

      const notes = (await alice.discoverNotes()).notes.get(ACE) ?? [];

      await expect(
        alice
          .build(AUTO_ALL)
          .with(ACE)
          .inputs(...notes)
          .transfer({ recipient: BOB.address, amount: -50n })
          .execute()
      ).rejects.toThrow(/Created note amount must be positive/);
    });
  });

  describe("Token Setup Independence", () => {
    it("different tokens require separate setup", async () => {
      const { alice, bob } = env;

      // Setup Alice -> Bob with ACE only
      applyStateChanges(await alice.build().register().execute());
      await setupRecipientChannel(alice, bob, BOB.address, ACE);

      // ACE is ready, BEE still needs setup
      expect(await alice.discoverRequirement(BOB.address, ACE)).toBe(SetupRequirement.Ready);
      expect(await alice.discoverRequirement(BOB.address, BEE)).toBe(SetupRequirement.SetupToken);
    });
  });
});
