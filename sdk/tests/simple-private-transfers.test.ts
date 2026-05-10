import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { createTestEnv, MockTestEnv, POOL_ADDRESS } from "./helpers/test-fixtures.js";
import { SimplePrivateTransfersImpl } from "../src/simple-private-transfers.js";
import { debugHint, isDebugEnabled, toBigInt, toHex } from "../src/utils/index.js";
import { MockSwapAnonymizer } from "../src/testing/contracts.js";

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
