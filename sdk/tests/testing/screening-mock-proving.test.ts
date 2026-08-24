import { describe, expect, it } from "vitest";
import { CairoCustomEnum, CallData, num } from "starknet";
import { PrivacyPoolABI } from "../../src/internal/abi.js";
import { ShadowAccountAnonymizerABI } from "../../src/internal/anonymizer-abi.js";
import {
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "../../src/internal/shadow-account-address.js";
import {
  screeningSubjectOf,
  type OpenNoteScreeningPolicy,
} from "../../src/testing/screening-mock-proving.js";

const POOL_ADDR = "0x9001";
const USER_ADDR = "0xaaa111";
const VIEWING_KEY = "0xbbb222";
const TOKEN = "0xdead";
const ANONYMIZER_ADDR = "0x5678";
const SWAP_EXECUTOR = "0xe0e0";
const DAPP_NAME = 0x646170n;
const NONCE = 7n;

const poolCallData = new CallData(PrivacyPoolABI);
const anonymizerCallData = new CallData(ShadowAccountAnonymizerABI);

const OPEN_NOTES = [
  { note_id: "0x3", token: TOKEN, collect_policy: new CairoCustomEnum({ All: {} }) },
];

function depositAction(): CairoCustomEnum {
  return new CairoCustomEnum({ Deposit: { token: TOKEN, amount: "0x64" } });
}

function createOpenNoteAction(): CairoCustomEnum {
  return new CairoCustomEnum({
    CreateOpenNote: {
      recipient_addr: USER_ADDR,
      recipient_public_key: "0x9",
      token: TOKEN,
      index: 0,
      random: "0xa",
    },
  });
}

function invokeExternalAction(target: string): CairoCustomEnum {
  return new CairoCustomEnum({
    InvokeExternal: { contract_address: target, calldata: ["0x1"] },
  });
}

function computeAndInvokeAction(target = ANONYMIZER_ADDR): CairoCustomEnum {
  return new CairoCustomEnum({
    ComputeAndInvoke: {
      contract_address: target,
      compute_additional_data: [DAPP_NAME, NONCE],
      invoke_additional_data: anonymizerCallData
        .compile("privacy_invoke_with_computation", [0n, [], OPEN_NOTES])
        .slice(1),
    },
  });
}

/**
 * Account execute calldata for one call to the pool's `compile_actions`, the shape the proof
 * invocation factory produces. The actions go through the pool ABI, so a Cairo-side change to them
 * reaches these tests.
 */
function executeCalldata(actions: CairoCustomEnum[]): string[] {
  const innerCalldata = poolCallData
    .compile("compile_actions", [USER_ADDR, VIEWING_KEY, actions])
    .map((felt) => num.toHex(felt));
  return ["0x1", POOL_ADDR, "0xselector", num.toHex(innerCalldata.length), ...innerCalldata];
}

/** A reader answering from `policies`, recording the pool it was asked about. */
function policyReader(policies: Record<string, OpenNoteScreeningPolicy>) {
  const askedPools: string[] = [];
  return {
    askedPools,
    read: async (poolAddress: string, depositor: string) => {
      askedPools.push(poolAddress);
      return policies[depositor] ?? "Required";
    },
  };
}

const NO_POLICY_READ = async () => {
  throw new Error("the policy list must not be read for this transaction");
};

describe("screeningSubjectOf", () => {
  it("puts up the depositor of a plain deposit", async () => {
    expect(await screeningSubjectOf(executeCalldata([depositAction()]), NO_POLICY_READ)).toBe(
      USER_ADDR
    );
  });

  it("puts up nobody for a transaction carrying neither a deposit nor an open note", async () => {
    const subject = await screeningSubjectOf(
      executeCalldata([invokeExternalAction(SWAP_EXECUTOR)]),
      NO_POLICY_READ
    );

    expect(subject).toBeUndefined();
  });

  it("puts up an open-note funding target whose policy is Required", async () => {
    const reader = policyReader({ [SWAP_EXECUTOR]: "Required" });

    const subject = await screeningSubjectOf(
      executeCalldata([createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)]),
      reader.read
    );

    expect(subject).toBe(SWAP_EXECUTOR);
    // The pool is read off the transaction, not configured, so the read must name the call's target.
    expect(reader.askedPools).toEqual([POOL_ADDR]);
  });

  it("puts up nobody for a target listed Exempt", async () => {
    const reader = policyReader({ [SWAP_EXECUTOR]: "Exempt" });

    const subject = await screeningSubjectOf(
      executeCalldata([createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)]),
      reader.read
    );

    expect(subject).toBeUndefined();
  });

  it("puts up the shadow account of a Delegated interaction, not the anonymizer", async () => {
    // Composed from the transaction's own felts, so reading the wrong ones — a swapped user and
    // viewing key, the pool in place of the anonymizer, the wrong nonce — fails this.
    const expected = shadowAccountAddress(
      shadowAccountCommitment(
        shadowAccountPartialCommitment(
          BigInt(USER_ADDR),
          BigInt(VIEWING_KEY),
          BigInt(ANONYMIZER_ADDR),
          DAPP_NAME
        ),
        NONCE
      ),
      BigInt(ANONYMIZER_ADDR)
    );
    const reader = policyReader({ [ANONYMIZER_ADDR]: "Delegated" });

    const subject = await screeningSubjectOf(
      executeCalldata([createOpenNoteAction(), computeAndInvokeAction()]),
      reader.read
    );

    expect(subject).toBe(num.toHex(expected));
  });

  it("puts up nobody for a plain invoke by a Delegated depositor", async () => {
    // A `Delegated` target only puts up an address for an interaction it runs; a plain invoke
    // carries none, and attesting the target itself would revert with UNEXPECTED_SCREENING.
    const reader = policyReader({ [SWAP_EXECUTOR]: "Delegated" });

    const subject = await screeningSubjectOf(
      executeCalldata([createOpenNoteAction(), invokeExternalAction(SWAP_EXECUTOR)]),
      reader.read
    );

    expect(subject).toBeUndefined();
  });

  it("refuses a deposit combined with a screened invoke, which the pool cannot verify", async () => {
    const reader = policyReader({ [SWAP_EXECUTOR]: "Required" });

    await expect(
      screeningSubjectOf(
        executeCalldata([
          depositAction(),
          createOpenNoteAction(),
          invokeExternalAction(SWAP_EXECUTOR),
        ]),
        reader.read
      )
    ).rejects.toThrow(/one address per transaction/);
  });

  it("still resolves a deposit that rides with an exempt open-note invoke", async () => {
    // One subject, not two: the exempt target puts up nobody, so the deposit's own depositor is
    // the whole requirement and the transaction is provable.
    const reader = policyReader({ [SWAP_EXECUTOR]: "Exempt" });

    const subject = await screeningSubjectOf(
      executeCalldata([
        depositAction(),
        createOpenNoteAction(),
        invokeExternalAction(SWAP_EXECUTOR),
      ]),
      reader.read
    );

    expect(subject).toBe(USER_ADDR);
  });

  it("reads no policy for calldata that is not a pool call", async () => {
    for (const calldata of [[], ["0x1"], ["0x1", POOL_ADDR, "0xsel", "0x2", "0x1", "0x2"]]) {
      expect(await screeningSubjectOf(calldata, NO_POLICY_READ)).toBeUndefined();
    }
  });
});
