import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, AUTO_ALL, MockTestEnv } from "../helpers/test-fixtures.js";
import { SetupRequirement } from "../../src/interfaces.js";
import { toBigInt } from "../../src/utils/index.js";

describe("Edge Cases", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  describe("Validation", () => {
    it("rejects negative deposit amount", async () => {
      const { env, transfers } = testEnv;
      const { alice } = transfers;

      await expect(
        alice
          .build(AUTO_ALL)
          .with(env.ace)
          .deposit({ amount: -100n, recipient: env.alice.address })
          .execute()
      ).rejects.toThrow(/Deposit amount must be positive/);
    });

    it("rejects negative withdraw amount", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      // Setup Alice -> Bob and create a note
      mocknet.executeOutside(await bob.build().register().execute());
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
          .deposit({ amount: 100n, recipient: env.bob.address })
          .execute()
      );

      const notes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(notes.length).toBe(1);

      await expect(
        bob
          .build(AUTO_ALL)
          .with(env.ace)
          .inputs(...notes)
          .withdraw({ amount: -50n })
          .execute()
      ).rejects.toThrow(/Withdraw amount must be positive/);
    });

    it("rejects negative transfer amount (created note)", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      // Setup Alice's self channel and Alice -> Bob channel
      mocknet.executeOutside(await bob.build().register().execute());

      // prettier-ignore
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
            .deposit({ amount: 100n, recipient: env.alice.address })
          .execute()
      );

      const notes = (await alice.discoverNotes()).notes.get(ace) ?? [];

      await expect(
        alice
          .build(AUTO_ALL)
          .with(env.ace)
          .inputs(...notes)
          .transfer({ recipient: env.bob.address, amount: -50n })
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
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;

      mocknet.executeOutside(await bob.build().register().execute());

      // Setup Alice -> Bob with ACE only
      mocknet.executeOutside(
        await alice.build(AUTO_ALL).register().with(env.ace).setup(env.bob.address).execute()
      );

      // ACE is ready, BEE still needs setup
      expect(await alice.discoverRequirement(env.bob.address, env.ace)).toBe(
        SetupRequirement.Ready
      );
      expect(await alice.discoverRequirement(env.bob.address, env.bee)).toBe(
        SetupRequirement.SetupToken
      );
    });
  });
});
