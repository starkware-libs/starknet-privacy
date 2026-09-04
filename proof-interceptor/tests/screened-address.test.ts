// tests/screened-address.test.ts
import { describe, it, expect } from "vitest";
import { CairoCustomEnum } from "starknet";
import {
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "@starkware-libs/starknet-privacy-sdk";
import type { OpenNoteScreeningPolicy } from "../src/screening-policy.js";
import { getScreenedAddress } from "../src/screened-address.js";
import {
  ANONYMIZER_ADDR,
  DAPP_NAME,
  NONCE,
  POOL_ADDR,
  PRIVATE_KEY,
  SWAP_EXECUTOR,
  USER_ADDR,
  computeAndInvokeAction,
  createOpenNoteAction,
  depositAction,
  invokeExternalAction,
  poolCallTransaction,
  rawPoolCallTransaction,
  silenceErrorLog,
} from "./pool-call.js";

/**
 * A policy reader answering from `policies`, recording what it was asked. An address absent from
 * `policies` reads as unresolvable, which is what an RPC failure looks like to the resolver.
 */
function fakePolicies(policies: Record<string, OpenNoteScreeningPolicy>) {
  const asked: string[] = [];
  return {
    asked,
    getPolicy: async (depositor: string) => {
      asked.push(depositor);
      return policies[depositor] ?? null;
    },
  };
}

const CONFIG = { poolAddress: POOL_ADDR };

/** The shadow account `deployer`'s compute-invoke runs through, from the fixture's felts. */
function derivedShadowAccount(deployer: string): string {
  const commitment = shadowAccountCommitment(
    shadowAccountPartialCommitment(
      BigInt(USER_ADDR),
      BigInt(PRIVATE_KEY),
      BigInt(deployer),
      DAPP_NAME
    ),
    NONCE
  );
  return shadowAccountAddress(commitment, BigInt(deployer));
}

async function subjectOf(
  actions: CairoCustomEnum[],
  policies: Record<string, OpenNoteScreeningPolicy> = {}
) {
  const reader = fakePolicies(policies);
  const screened = await getScreenedAddress(
    poolCallTransaction(actions),
    CONFIG,
    reader
  );
  return { screened, asked: reader.asked };
}

describe("getScreenedAddress", () => {
  it("screens the depositor of a plain deposit", async () => {
    const { screened, asked } = await subjectOf([depositAction()]);

    expect(screened).toEqual({ kind: "one", address: USER_ADDR });
    // No invoke, so no policy to read: a deposit is screened without touching the pool.
    expect(asked).toEqual([]);
  });

  it("screens the depositor even when the viewing key does not parse", async () => {
    // Only shadow account derivation reads that felt, so a caller cannot drop their own deposit out
    // of screening by corrupting it.
    const transaction = poolCallTransaction([depositAction()]);
    transaction.calldata[5] = "not-a-felt";

    const screened = await getScreenedAddress(
      transaction,
      CONFIG,
      fakePolicies({})
    );

    expect(screened).toEqual({ kind: "one", address: USER_ADDR });
  });

  it("screens nobody for a call to a contract other than the pool", async () => {
    const screened = await getScreenedAddress(
      poolCallTransaction([depositAction()]),
      { poolAddress: "0x4321" },
      fakePolicies({})
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("screens nobody for calldata that does not decode", async () => {
    // A transaction the pool cannot parse reverts on its own, so there is nothing to screen for it.
    const screened = await getScreenedAddress(
      rawPoolCallTransaction([
        "0x1",
        POOL_ADDR,
        "0xselector",
        "0x4",
        USER_ADDR,
        "0xbbb222",
        "0x1",
        "0xff", // no such action variant
      ]),
      CONFIG,
      fakePolicies({})
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("screens nobody when the transaction neither deposits nor invokes", async () => {
    const { screened } = await subjectOf([createOpenNoteAction()]);

    expect(screened).toEqual({ kind: "none" });
  });

  it("screens an unlisted invoke target, which the pool defaults to Required", async () => {
    const { screened, asked } = await subjectOf(
      [createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)],
      { [SWAP_EXECUTOR]: "Required" }
    );

    expect(screened).toEqual({ kind: "one", address: SWAP_EXECUTOR });
    expect(asked).toEqual([SWAP_EXECUTOR]);
  });

  it("screens nobody for an Exempt invoke target", async () => {
    const { screened } = await subjectOf(
      [createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)],
      { [SWAP_EXECUTOR]: "Exempt" }
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("screens the shadow account of a Delegated interaction, not the anonymizer", async () => {
    // Composed here from the transaction's own felts rather than asserted to be "not the
    // anonymizer": only the value pins which felts the derivation reads, so feeding it the wrong
    // user address or nonce fails this.
    const { screened } = await subjectOf(
      [createOpenNoteAction(), computeAndInvokeAction()],
      { [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(screened).toEqual({
      kind: "one",
      address: derivedShadowAccount(ANONYMIZER_ADDR),
    });
  });

  it("screens nobody when the anonymizer is not listed Delegated", async () => {
    // The devnet suites and the middle of the rollout run the anonymizer as `Exempt`. Screening its
    // shadow account then is not a harmless extra: the pool has no subject, so the attestation the
    // prover would attach makes it revert with `UNEXPECTED_SCREENING`.
    const { screened } = await subjectOf(
      [createOpenNoteAction(), computeAndInvokeAction()],
      { [ANONYMIZER_ADDR]: "Exempt" }
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("screens an unlisted anonymizer as itself, not its shadow account", async () => {
    // Unlisted is `Required`, under which the pool asks for the target's own address.
    const { screened } = await subjectOf(
      [createOpenNoteAction(), computeAndInvokeAction()],
      { [ANONYMIZER_ADDR]: "Required" }
    );

    expect(screened).toEqual({ kind: "one", address: ANONYMIZER_ADDR });
  });

  it("screens nobody for an interaction that creates no open note", async () => {
    // The `CreateOpenNote` is here, so the empty note list is what the resolver reacts to.
    const { screened, asked } = await subjectOf(
      [createOpenNoteAction(), computeAndInvokeAction(ANONYMIZER_ADDR, [])],
      { [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(screened).toEqual({ kind: "none" });
    expect(asked).toEqual([ANONYMIZER_ADDR]);
  });

  it("still screens a deposit riding an interaction that creates no open note", async () => {
    const { screened } = await subjectOf(
      [
        depositAction(),
        createOpenNoteAction(),
        computeAndInvokeAction(ANONYMIZER_ADDR, []),
      ],
      { [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(screened).toEqual({ kind: "one", address: USER_ADDR });
  });

  it("screens nobody when a transaction creating no open note is otherwise underivable", async () => {
    // The note count is read before the felts the derivation needs.
    const transaction = poolCallTransaction([
      createOpenNoteAction(),
      computeAndInvokeAction(ANONYMIZER_ADDR, []),
    ]);
    transaction.calldata[5] = "not-a-felt";

    const screened = await getScreenedAddress(transaction, CONFIG, {
      getPolicy: async () => "Delegated" as const,
    });

    expect(screened).toEqual({ kind: "none" });
  });

  it("reads no policy for a transaction that creates no open note", async () => {
    // The policy list is consulted only for a transaction carrying a `CreateOpenNote`.
    const { screened, asked } = await subjectOf([computeAndInvokeAction()]);

    expect(screened).toEqual({ kind: "none" });
    expect(asked).toEqual([]);
  });

  it("fails closed when the target's policy cannot be read", async () => {
    const { screened } = await subjectOf([
      createOpenNoteAction(),
      invokeExternalAction(SWAP_EXECUTOR),
    ]);

    expect(screened).toEqual({ kind: "unreadablePolicy" });
  });

  it("screens any Delegated target's compute-invoke on its own shadow account", async () => {
    // Listing a target `Delegated` makes it the deployer felt the derivation uses.
    const { screened } = await subjectOf(
      [createOpenNoteAction(), computeAndInvokeAction(SWAP_EXECUTOR)],
      { [SWAP_EXECUTOR]: "Delegated" }
    );

    expect(screened).toEqual({
      kind: "one",
      address: derivedShadowAccount(SWAP_EXECUTOR),
    });
  });

  it("screens nobody for a delegated target driven through a plain invoke", async () => {
    // The pool reads addresses only from a compute-invoke, so a plain invoke from a delegated
    // depositor is exempt there and must be exempt here too.
    const { screened } = await subjectOf(
      [createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)],
      { [SWAP_EXECUTOR]: "Delegated" }
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("never screens a shadow account under another target's policy", async () => {
    // Two invoke-phase actions is a transaction the pool rejects, but the interceptor sees it before
    // the pool does. Both are compute-invokes, so deriving from the funding invoke's own target
    // keeps the anonymizer's shadow account from riding in on the swap executor's listing: the
    // derivation would otherwise scan on and find the anonymizer's action by itself.
    const { screened, asked } = await subjectOf(
      [
        createOpenNoteAction(),
        computeAndInvokeAction(SWAP_EXECUTOR),
        computeAndInvokeAction(),
      ],
      { [SWAP_EXECUTOR]: "Delegated", [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(asked).toEqual([SWAP_EXECUTOR]);
    expect(screened).toEqual({
      kind: "one",
      address: derivedShadowAccount(SWAP_EXECUTOR),
    });
    expect(derivedShadowAccount(SWAP_EXECUTOR)).not.toBe(
      derivedShadowAccount(ANONYMIZER_ADDR)
    );
  });

  it("refuses separately when the anonymizer's shadow account cannot be determined", async () => {
    // The depositor is one this does know how to resolve; the transaction is what gives it nothing
    // to resolve from. An unparseable viewing key is a different failure from an unsupported
    // contract, and the verdict says so.
    const errorSpy = silenceErrorLog();
    const transaction = poolCallTransaction([
      createOpenNoteAction(),
      computeAndInvokeAction(),
    ]);
    transaction.calldata[5] = "not-a-felt";

    const screened = await getScreenedAddress(transaction, CONFIG, {
      getPolicy: async () => "Delegated" as const,
    });

    expect(screened).toEqual({ kind: "undeterminedShadowAccount" });
    expect(String(errorSpy.mock.calls[0][0])).toContain(
      "shadow_account_undetermined"
    );
    errorSpy.mockRestore();
  });

  it("screens nobody when a plain invoke funds the notes for a delegated target", async () => {
    const { screened } = await subjectOf(
      [
        createOpenNoteAction(),
        invokeExternalAction(SWAP_EXECUTOR),
        computeAndInvokeAction(),
      ],
      { [SWAP_EXECUTOR]: "Delegated", [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(screened).toEqual({ kind: "none" });
  });

  it("reports a conflict when a deposit and an invoke target disagree", async () => {
    const { screened } = await subjectOf(
      [
        depositAction(),
        createOpenNoteAction(),
        invokeExternalAction(SWAP_EXECUTOR),
      ],
      { [SWAP_EXECUTOR]: "Required" }
    );

    expect(screened).toEqual({ kind: "conflict" });
  });

  it("reports a conflict when a deposit and a shadow account disagree", async () => {
    const { screened } = await subjectOf(
      [depositAction(), createOpenNoteAction(), computeAndInvokeAction()],
      { [ANONYMIZER_ADDR]: "Delegated" }
    );

    expect(screened).toEqual({ kind: "conflict" });
  });

  it("dedups an invoke target that is also the depositor", async () => {
    const { screened } = await subjectOf(
      [
        depositAction(),
        createOpenNoteAction(),
        invokeExternalAction(USER_ADDR),
      ],
      { [USER_ADDR]: "Required" }
    );

    expect(screened).toEqual({ kind: "one", address: USER_ADDR });
  });
});
