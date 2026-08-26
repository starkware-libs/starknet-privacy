// tests/shadow-account.test.ts
import { describe, it, expect } from "vitest";
import { CairoCustomEnum, type BigNumberish } from "starknet";
import {
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "@starkware-libs/starknet-privacy-sdk";
import { decodeClientActions } from "../src/pool-transaction.js";
import {
  getShadowAccountAddress,
  getShadowAccountInteraction,
} from "../src/shadow-account.js";
import {
  ANONYMIZER_ADDR,
  DAPP_NAME,
  NONCE,
  OPEN_NOTES,
  POOL_ADDR,
  PRIVATE_KEY,
  USER_ADDR,
  depositAction,
  invokeAdditionalData,
  poolCallTransaction,
} from "./pool-call.js";

function computeAndInvoke(input: {
  contract_address?: string;
  compute_additional_data?: BigNumberish[];
  invoke_additional_data?: BigNumberish[];
}): CairoCustomEnum {
  return new CairoCustomEnum({
    ComputeAndInvoke: {
      contract_address: input.contract_address ?? ANONYMIZER_ADDR,
      compute_additional_data: input.compute_additional_data ?? [
        DAPP_NAME,
        NONCE,
      ],
      invoke_additional_data:
        input.invoke_additional_data ?? invokeAdditionalData(OPEN_NOTES),
    },
  });
}

function interactionOf(
  actions: CairoCustomEnum[],
  anonymizerAddress = ANONYMIZER_ADDR
) {
  const poolCall = decodeClientActions(poolCallTransaction(actions), POOL_ADDR);
  expect(poolCall).not.toBeNull();
  return getShadowAccountInteraction(poolCall!.actions, anonymizerAddress);
}

function addressOf(
  actions: CairoCustomEnum[],
  anonymizerAddress = ANONYMIZER_ADDR
) {
  const poolCall = decodeClientActions(poolCallTransaction(actions), POOL_ADDR);
  expect(poolCall).not.toBeNull();
  return getShadowAccountAddress(poolCall!, anonymizerAddress);
}

describe("getShadowAccountInteraction", () => {
  it("returns the dapp name and nonce of an interaction settling an open note", () => {
    expect(interactionOf([computeAndInvoke({})])).toEqual({
      kind: "interaction",
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("puts up nobody when the interaction settles no open note", () => {
    // Not `undetermined`: the pool reads the depositor's policy only for an invoke that returns
    // deposits, so a transaction depositing nothing is one it asks for no subject for at all.
    const action = computeAndInvoke({
      invoke_additional_data: invokeAdditionalData([]),
    });
    expect(interactionOf([action])).toEqual({ kind: "noOpenNotes" });
  });

  it("puts up nobody when an interaction settling no open note has unusable compute data", () => {
    // The open notes are read first: with nothing deposited the pool never reaches the compute
    // arguments, so their shape cannot turn a transaction that needs no subject into a refusal.
    const action = computeAndInvoke({
      compute_additional_data: [DAPP_NAME],
      invoke_additional_data: invokeAdditionalData([]),
    });
    expect(interactionOf([action])).toEqual({ kind: "noOpenNotes" });
  });

  it("returns undetermined when the compute-invoke targets another contract", () => {
    const action = computeAndInvoke({ contract_address: "0x4321" });
    expect(interactionOf([action])).toEqual({ kind: "undetermined" });
  });

  it("matches the anonymizer regardless of leading zeros and case", () => {
    const action = computeAndInvoke({ contract_address: "0x0000005678" });
    expect(interactionOf([action], "0X5678")).toEqual({
      kind: "interaction",
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns undetermined when no action is a compute-invoke", () => {
    expect(interactionOf([depositAction()])).toEqual({ kind: "undetermined" });
  });

  it("finds the interaction alongside a deposit in the same transaction", () => {
    expect(interactionOf([depositAction(), computeAndInvoke({})])).toEqual({
      kind: "interaction",
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns undetermined when the invoke data is truncated", () => {
    const truncated = invokeAdditionalData(OPEN_NOTES).slice(0, 2);
    expect(
      interactionOf([computeAndInvoke({ invoke_additional_data: truncated })])
    ).toEqual({ kind: "undetermined" });
  });

  it("returns undetermined when the invoke data claims more open notes than it carries", () => {
    const data = invokeAdditionalData(OPEN_NOTES);
    // The open notes follow the calls; their length prefix is the felt after them.
    const openNotesLengthIndex = data.length - 1 - 3;
    data[openNotesLengthIndex] = "2";
    expect(
      interactionOf([computeAndInvoke({ invoke_additional_data: data })])
    ).toEqual({ kind: "undetermined" });
  });

  it("returns undetermined when the compute data is not a dapp name and a nonce", () => {
    for (const computeData of [[DAPP_NAME], [DAPP_NAME, NONCE, 1n]]) {
      const action = computeAndInvoke({ compute_additional_data: computeData });
      expect(interactionOf([action])).toEqual({ kind: "undetermined" });
    }
  });
});

describe("getShadowAccountAddress", () => {
  it("derives the address the anonymizer would deploy the interaction's account to", () => {
    // Composed here from the transaction's own felts, so the test fails if the derivation reads the
    // wrong ones: a swapped user and viewing key, or the pool address in place of the anonymizer.
    const expected = shadowAccountAddress(
      shadowAccountCommitment(
        shadowAccountPartialCommitment(
          BigInt(USER_ADDR),
          BigInt(PRIVATE_KEY),
          BigInt(ANONYMIZER_ADDR),
          DAPP_NAME
        ),
        NONCE
      ),
      BigInt(ANONYMIZER_ADDR)
    );
    expect(addressOf([computeAndInvoke({})])).toEqual({
      kind: "address",
      address: "0x" + expected.toString(16),
    });
  });

  it("returns undetermined for an unparseable user address instead of throwing", () => {
    // `user_addr` is caller-controlled and reaches the derivation as a bigint. An unparseable one
    // must void the derivation, not escape as an exception: the interceptor turns a thrown error
    // into a block whose reason is the exception text, where reasons are opaque codes.
    const transaction = poolCallTransaction([computeAndInvoke({})]);
    transaction.calldata[4] = "not-a-felt";
    const poolCall = decodeClientActions(transaction, POOL_ADDR);

    expect(poolCall).not.toBeNull();
    expect(getShadowAccountAddress(poolCall!, ANONYMIZER_ADDR)).toEqual({
      kind: "undetermined",
    });
  });

  it("puts up nobody when an unparseable viewing key rides an interaction settling nothing", () => {
    // The felts the derivation needs are only reached once there is something to derive for. An
    // invoke depositing nothing asks for no subject, however unusable the rest of the call is.
    const transaction = poolCallTransaction([
      computeAndInvoke({ invoke_additional_data: invokeAdditionalData([]) }),
    ]);
    transaction.calldata[5] = "not-a-felt";
    const poolCall = decodeClientActions(transaction, POOL_ADDR);

    expect(poolCall).not.toBeNull();
    expect(getShadowAccountAddress(poolCall!, ANONYMIZER_ADDR)).toEqual({
      kind: "noOpenNotes",
    });
  });

  it("returns undetermined when the transaction runs no interaction", () => {
    expect(addressOf([depositAction()])).toEqual({ kind: "undetermined" });
  });

  it("puts up nobody when the interaction settles no open note", () => {
    expect(
      addressOf([
        computeAndInvoke({ invoke_additional_data: invokeAdditionalData([]) }),
      ])
    ).toEqual({ kind: "noOpenNotes" });
  });

  it("gives each nonce its own address", () => {
    const first = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME, 1n] }),
    ]);
    const second = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME, 2n] }),
    ]);
    expect(first).toMatchObject({ kind: "address" });
    expect(first).not.toEqual(second);
  });

  it("gives each dapp its own address", () => {
    const other = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME + 1n, NONCE] }),
    ]);
    expect(other).toMatchObject({ kind: "address" });
    expect(addressOf([computeAndInvoke({})])).not.toEqual(other);
  });

  it("finds the interaction alongside a deposit", () => {
    expect(addressOf([depositAction(), computeAndInvoke({})])).toEqual(
      addressOf([computeAndInvoke({})])
    );
  });
});
