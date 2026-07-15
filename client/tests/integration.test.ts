import { describe, it, expect } from "vitest";
import { cairo, hash, num } from "starknet";
import type { ProviderInterface, TypedData } from "starknet";
import { createPrivacyClient, SdkWallet } from "../src/index.js";
import type { Paymaster, Strk20Action, Strk20Prover } from "../src/index.js";

/**
 * Full-stack wiring: a real client + real PrivacyBuilder + real SdkWallet, with only the true
 * externals faked — the prover (proving) and the paymaster (network). Verifies that a fluent
 * build() ... submit() threads the compiled Strk20Actions through the wallet seam and out to the
 * paymaster with the fee folded in, and that a deposit auto-switches to the regular flow.
 */

const provider = { tag: "provider" } as unknown as ProviderInterface;
const TOKEN = "0x7";
const POOL = "0xpool";
const USER = "0x5e1f";
const PROVEN = {
  call: { contract_address: POOL, entry_point: "apply_actions", calldata: ["0xc"] },
  proof: { data: "0xproofdata", output: ["0xo"], proof_facts: ["0xf1"] },
};
const TYPED_DATA = { domain: {}, types: {}, primaryType: "X", message: {} } as unknown as TypedData;

function fakeProver(seen: { proved?: Strk20Action[] }): Strk20Prover {
  return {
    partialCommitment: async () => 0n,
    prove: async (actions) => {
      seen.proved = actions;
      return PROVEN;
    },
  };
}

function fakePaymaster(seen: { build?: unknown; execute?: unknown }): Paymaster {
  return {
    buildTransaction: async (build) => {
      seen.build = build;
      return {
        feeAction: { type: "withdraw", recipient: "0xpm", token: "0xfee", amount: "0x2a" },
        typedData: TYPED_DATA,
      };
    },
    executeTransaction: async (execute) => {
      seen.execute = execute;
      return { transactionHash: "0xsent" };
    },
  };
}

function harness() {
  const prover: { proved?: Strk20Action[] } = {};
  const paymaster: { build?: unknown; execute?: unknown } = {};
  const signed: { typedData?: TypedData; account?: string } = {};
  const wallet = new SdkWallet({
    prover: fakeProver(prover),
    paymaster: fakePaymaster(paymaster),
    poolContractAddress: POOL,
    userAddress: USER,
    signer: {
      signMessage: async (typedData, account) => {
        signed.typedData = typedData;
        signed.account = account;
        return ["0x1", "0x2"];
      },
    } as never,
  });
  const client = createPrivacyClient({
    wallet,
    userAddress: USER,
    provider,
    subAccountAnonymizerAddress: "0xa11",
  });
  return { client, prover, paymaster, signed };
}

describe("integration: build → submit", () => {
  it("private flow: withdraw → apply_action, fee folded in, one broadcast", async () => {
    const { client, prover, paymaster } = harness();

    const result = await client
      .build()
      .with(TOKEN)
      .withdraw({ amount: 5n, recipient: "0x9" })
      .submit();

    // The builder-compiled action reaches the prover, followed by the fee withdraw the wallet
    // appends so the proof covers the paymaster fee. (An open note is not tested standalone: it
    // carries no amount until an invoke/computeAndInvoke fills it — see the invoke test below.)
    expect(prover.proved).toEqual([
      { type: "withdraw", token: TOKEN, amount: "0x5", recipient: "0x9" },
      { type: "withdraw", token: "0xfee", amount: "0x2a", recipient: "0xpm" },
    ]);
    expect(paymaster.build).toEqual({ kind: "applyAction", poolAddress: POOL });
    expect(paymaster.execute).toMatchObject({
      kind: "applyAction",
      applyActionsCall: {
        to: POOL,
        selector: hash.getSelectorFromName("apply_actions"),
        calldata: ["0xc"],
      },
      proof: "0xproofdata",
      proofFacts: ["0xf1"],
    });
    expect(result).toEqual({ transaction_hash: "0xsent" });
  });

  it("deposit auto-switches to the regular flow with a user-signed approve", async () => {
    const { client, prover, paymaster, signed } = harness();

    await client.build().with(TOKEN).deposit({ amount: 100n }).submit();

    const amount = cairo.uint256(100n);
    expect(paymaster.build).toEqual({
      kind: "invokeAndApplyAction",
      poolAddress: POOL,
      userAddress: USER,
      calls: [
        {
          to: TOKEN,
          selector: hash.getSelectorFromName("approve"),
          calldata: [POOL, num.toHex(amount.low), num.toHex(amount.high)],
        },
      ],
    });
    expect(signed.typedData).toBe(TYPED_DATA);
    expect(signed.account).toBe(USER);
    expect(paymaster.execute).toMatchObject({ kind: "invokeAndApplyAction", userAddress: USER });
    // deposit + the appended fee withdraw were proved together
    expect(prover.proved).toEqual([
      { type: "deposit", token: TOKEN, amount: "0x64" },
      { type: "withdraw", token: "0xfee", amount: "0x2a", recipient: "0xpm" },
    ]);
  });

  it("invoke placeholders flow through the builder to the prover unresolved", async () => {
    const { client, prover } = harness();

    await client
      .build()
      .with(TOKEN)
      .createOpenNote()
      .invoke((args) => ({
        contractAddress: "0xdapp",
        calldata: [args.openNoteIds[0], args.poolAddress],
      }))
      .submit();

    expect(prover.proved).toEqual([
      { type: "transfer", token: TOKEN, amount: "OPEN", recipient: USER },
      { type: "invoke", contract: "0xdapp", calldata: ["${openNoteIds[0]}", "${poolAddress}"] },
      { type: "withdraw", token: "0xfee", amount: "0x2a", recipient: "0xpm" },
    ]);
  });

  it("simulate is unsupported on the SDK-backed path (fee estimation deferred)", async () => {
    const { client } = harness();
    await expect(
      client.build().with(TOKEN).withdraw({ amount: 5n, recipient: "0x9" }).simulate()
    ).rejects.toThrow(/not yet implemented/);
  });

  it("subaccounts(dappName).addresses resolves via the anonymizer keyed by the wallet's partial commitment", async () => {
    const seenDapp: string[] = [];
    const viewCalldata: string[][] = [];
    // provider answers the anonymizer get_sub_accounts view: [len, (nonce, address, is_deployed)…]
    const anonymizerProvider = {
      callContract: async (call: { calldata: string[] }) => {
        viewCalldata.push(call.calldata);
        return ["0x1", "0x0", num.toHex(0x1000n), "0x1"];
      },
    } as unknown as ProviderInterface;
    const wallet = new SdkWallet({
      prover: {
        partialCommitment: async (dappName) => {
          seenDapp.push(dappName);
          return 0x7n;
        },
        prove: async () => PROVEN,
      },
      paymaster: fakePaymaster({}),
      poolContractAddress: POOL,
      userAddress: USER,
      signer: {} as never,
    });
    const client = createPrivacyClient({
      wallet,
      userAddress: USER,
      provider: anonymizerProvider,
      subAccountAnonymizerAddress: "0xa11",
    });

    const infos = await client.build().subaccounts("my-dapp").addresses({ end: 1 });

    expect(seenDapp).toEqual(["my-dapp"]);
    expect(infos).toEqual([{ nonce: 0n, address: 0x1000n, is_deployed: true }]);
    // partial commitment (0x7) is the view's first arg; until_undeployed defaults to false
    expect(num.toBigInt(viewCalldata[0][0])).toBe(0x7n);
    expect(num.toBigInt(viewCalldata[0][3])).toBe(0n);
  });
});
