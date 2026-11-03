import { describe, expect, it } from "vitest";
import { createTestEnv, AUTO_ALL } from "../helpers/test-fixtures.js";
import { ContractDiscoveryProvider } from "../../src/internal/contract-discovery.js";
import { toBigInt } from "../../src/utils/index.js";

describe("ContractDiscoveryProvider", () => {
  it("returns each unspent note once when resuming from a cursor", async () => {
    const { mocknet, env, transfers } = createTestEnv();
    const ace = toBigInt(env.ace);

    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(await transfers.bob.build().register().execute());

    // A self-channel note that is then partly spent, and a note on bob's channel to alice
    mocknet.executeOutside(
      await transfers.alice.build(AUTO_ALL).with(env.ace).deposit({ amount: 100n }).execute()
    );
    mocknet.executeOutside(
      await transfers.alice
        .build(AUTO_ALL)
        .with(env.ace)
        .withdraw({ amount: 40n })
        .surplusTo(env.alice.address, false)
        .execute()
    );
    mocknet.executeOutside(
      await transfers.bob
        .build(AUTO_ALL)
        .with(env.ace)
        .deposit({ amount: 30n, recipient: env.alice.address })
        .execute()
    );

    const discovery = new ContractDiscoveryProvider(mocknet.pool);
    const fresh = await discovery.discoverNotes(env.alice.address, env.alice.privateKey);
    const resumed = await discovery.discoverNotes(env.alice.address, env.alice.privateKey, {
      cursor: fresh.cursor,
    });

    const freshNotes = fresh.notes.get(ace) ?? [];
    const resumedNotes = resumed.notes.get(ace) ?? [];
    expect(freshNotes.map((note) => note.amount).sort()).toEqual([30n, 60n]);
    expect(resumedNotes.map((note) => note.amount).sort()).toEqual([30n, 60n]);
    expect(resumedNotes.map((note) => toBigInt(note.id)).sort()).toEqual(
      freshNotes.map((note) => toBigInt(note.id)).sort()
    );
  });
});
