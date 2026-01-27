import { describe, expect, it, beforeEach } from "vitest";
import {
  createTestEnv,
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

      await expect(
        alice
          .build(AUTO_ALL)
          .with(ACE)
          .deposit({ amount: -100n, recipient: ALICE.address })
          .execute()
      ).rejects.toThrow(/Deposit amount must be positive/);
    });

    it("rejects negative withdraw amount", async () => {
      const { alice, bob, executeOutside } = env;

      // Setup Alice -> Bob and create a note
      executeOutside(await bob.build().register().execute());
      executeOutside(
        await alice
          .build(AUTO_ALL)
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
      const { alice, bob, executeOutside } = env;

      // Setup Alice's self channel and Alice -> Bob channel
      executeOutside(await bob.build().register().execute());

      // prettier-ignore
      executeOutside(
        await alice
          .build(AUTO_ALL)
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

  describe("SetupRequirement Enum Ordering", () => {
    it("Ready > SetupToken > SetupChannel > Register (higher = more ready)", () => {
      expect(SetupRequirement.Ready).toBeGreaterThan(SetupRequirement.SetupToken);
      expect(SetupRequirement.SetupToken).toBeGreaterThan(SetupRequirement.SetupChannel);
      expect(SetupRequirement.SetupChannel).toBeGreaterThan(SetupRequirement.Register);
    });
  });

  describe("Token Setup Independence", () => {
    it("different tokens require separate setup", async () => {
      const { alice, bob, executeOutside } = env;

      executeOutside(await bob.build().register().execute());

      // Setup Alice -> Bob with ACE only
      executeOutside(await alice.build(AUTO_ALL).register().with(ACE).setup(BOB.address).execute());

      // ACE is ready, BEE still needs setup
      expect(await alice.discoverRequirement(BOB.address, ACE)).toBe(SetupRequirement.Ready);
      expect(await alice.discoverRequirement(BOB.address, BEE)).toBe(SetupRequirement.SetupToken);
    });
  });
});
