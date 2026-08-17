import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { createTestEnv, MockTestEnv, POOL_ADDRESS } from "./helpers/test-fixtures.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";
import { debugHint, isDebugEnabled, toBigInt, toHex } from "../src/utils/index.js";
import { MockSwapAnonymizer } from "../src/testing/contracts.js";
import { All, PrivateTransfersInterface } from "../src/interfaces.js";

interface SurplusCall {
  recipient: bigint;
  withdraw?: boolean;
}

// Spies on surplusTo to record each call's arguments while still invoking the real implementation.
function spyOnSurplusTo(transfers: PrivateTransfersInterface): SurplusCall[] {
  const surplusCalls: SurplusCall[] = [];
  const build = transfers.build.bind(transfers);
  vi.spyOn(transfers, "build").mockImplementation((options) => {
    const builder = build(options);
    const withToken = builder.with.bind(builder);
    vi.spyOn(builder, "with").mockImplementation((token) => {
      const tokenBuilder = withToken(token);
      const surplusTo = tokenBuilder.surplusTo.bind(tokenBuilder);
      vi.spyOn(tokenBuilder, "surplusTo").mockImplementation((recipient, withdraw) => {
        surplusCalls.push({ recipient: toBigInt(recipient), withdraw });
        return surplusTo(recipient, withdraw);
      });
      return tokenBuilder;
    });
    return builder;
  });
  return surplusCalls;
}

describe("SimplePrivateTransfers", () => {
  let testEnv: MockTestEnv;

  afterAll(() => {
    if (!isDebugEnabled()) {
      console.log(debugHint);
    }
  });

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  it("deposit creates private note", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);

    // Deposit 100 ACE
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));

    // Verify: Alice has 100n ACE note
    const aliceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].amount).toBe(100n);

    // Verify: public balance decreased
    expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(900n);
  });

  it("withdraw returns funds to public balance", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);

    // Deposit then withdraw partial
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));
    mocknet.executeOutside(await alice.withdraw(env.ace, env.alice.address, 40n));

    // Verify: Alice has 60n surplus note
    const aliceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].amount).toBe(60n);

    // Verify: public balance reflects withdraw
    expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(940n); // 1000 - 100 + 40
  });

  it("withdraw keeps surplus with the sender when paying a third party", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);

    // Both registered, so a private note to Bob would be constructible
    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(await transfers.bob.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);

    // Two notes: note selection sweeps both, so the change is 160n
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));
    mocknet.executeOutside(await alice.withdraw(env.ace, env.bob.address, 40n));

    expect(env.contracts.get(ace).balanceOf(env.bob.address)).toBe(1040n); // 1000 + 40

    const bobNotes = (await transfers.bob.discoverNotes()).notes.get(ace) ?? [];
    expect(bobNotes).toEqual([]);

    const aliceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].amount).toBe(160n);

    expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(800n); // 1000 - 200
  });

  it("withdraw routes surplus to the sender for an amount and to the recipient for All", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);

    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(await transfers.bob.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));

    const surplusCalls = spyOnSurplusTo(transfers.alice);

    // An amount is paid out as a withdraw output, so the surplus is the sender's own change note
    mocknet.executeOutside(await alice.withdraw(env.ace, env.bob.address, 40n));
    expect(surplusCalls).toEqual([{ recipient: toBigInt(env.alice.address), withdraw: false }]);

    // All has no separate output: the whole balance is the surplus, withdrawn to the recipient
    surplusCalls.length = 0;
    mocknet.executeOutside(await alice.withdraw(env.ace, env.bob.address, All));
    expect(surplusCalls).toEqual([{ recipient: toBigInt(env.bob.address), withdraw: true }]);

    // Nothing moved: with no action of its own to seed a balance for the token, the All call above
    // selects no notes. These assertions must flip once the TODO on withdraw's isAll branch is fixed.
    expect(env.contracts.get(ace).balanceOf(env.bob.address)).toBe(1040n); // unchanged since the 40n withdraw
    const bobNotes = (await transfers.bob.discoverNotes()).notes.get(ace) ?? [];
    expect(bobNotes).toEqual([]);
    const aliceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aliceNotes.map((note) => note.amount)).toEqual([60n]); // untouched change note from the first withdraw
  });

  it("transfer sends funds to recipient", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);

    // Both must be registered
    mocknet.executeOutside(await transfers.alice.build().register().execute());
    mocknet.executeOutside(await transfers.bob.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);

    // Deposit then transfer
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));
    mocknet.executeOutside(await alice.transfer(env.ace, env.bob.address, 30n));

    // Verify: Bob has 30n
    const bobNotes = (await transfers.bob.discoverNotes()).notes.get(ace) ?? [];
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].amount).toBe(30n);

    // Verify: Alice has 70n surplus
    const aliceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aliceNotes.length).toBe(1);
    expect(aliceNotes[0].amount).toBe(70n);
  });

  it("swaps ACE for BEE via swap anonymizer and open note", async () => {
    const { mocknet, env, transfers } = testEnv;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const swapAnonymizer = new MockSwapAnonymizer("0x53A2", env.contracts, POOL_ADDRESS);
    env.contracts.register(swapAnonymizer);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    const alice = new SimplePrivateTransfersImpl(transfers.alice);

    // Deposit 100 ACE first
    mocknet.executeOutside(await alice.deposit(env.ace, 100n));

    // Swap 10 ACE for BEE using the swap anonymizer.
    // note_id is auto-injected by the compiler into the invoke calldata.
    mocknet.executeOutside(await alice.swap(env.ace, 10n, env.bee, toHex(swapAnonymizer.address)));

    // Verify: Alice has 90n ACE change note
    const aceNotes = (await transfers.alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aceNotes.length).toBe(1);
    expect(aceNotes[0].amount).toBe(90n);

    // Alice has 20n BEE note (swap anonymizer gives 2x)
    const beeNotes = (await transfers.alice.discoverNotes()).notes.get(bee) ?? [];
    expect(beeNotes.length).toBe(1);
    expect(beeNotes[0].amount).toBe(20n);
    expect(beeNotes[0].open).toBe(true);
  });
});
