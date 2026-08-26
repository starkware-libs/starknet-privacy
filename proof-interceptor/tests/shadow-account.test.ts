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
  createsOpenNotes,
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
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns the compute arguments even when the invoke creates no open note", () => {
    // The identity commitment determines the address; the note count does not enter it.
    const action = computeAndInvoke({
      invoke_additional_data: invokeAdditionalData([]),
    });
    expect(interactionOf([action])).toEqual({
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns null when the compute-invoke targets another contract", () => {
    const action = computeAndInvoke({ contract_address: "0x4321" });
    expect(interactionOf([action])).toBeNull();
  });

  it("matches the anonymizer regardless of leading zeros and case", () => {
    const action = computeAndInvoke({ contract_address: "0x0000005678" });
    expect(interactionOf([action], "0X5678")).toEqual({
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns null when no action is a compute-invoke", () => {
    expect(interactionOf([depositAction()])).toBeNull();
  });

  it("finds the interaction alongside a deposit in the same transaction", () => {
    expect(interactionOf([depositAction(), computeAndInvoke({})])).toEqual({
      dappName: DAPP_NAME,
      nonce: NONCE,
    });
  });

  it("returns null when the compute data is not a dapp name and a nonce", () => {
    for (const computeData of [[DAPP_NAME], [DAPP_NAME, NONCE, 1n]]) {
      const action = computeAndInvoke({ compute_additional_data: computeData });
      expect(interactionOf([action])).toBeNull();
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
    expect(addressOf([computeAndInvoke({})])).toBe(
      "0x" + expected.toString(16)
    );
  });

  it("returns null for an unparseable user address instead of throwing", () => {
    // `user_addr` is caller-controlled and reaches the derivation as a bigint. An unparseable one
    // must void the derivation, not escape as an exception: the interceptor turns a thrown error
    // into a block whose reason is the exception text, where reasons are opaque codes.
    const transaction = poolCallTransaction([computeAndInvoke({})]);
    transaction.calldata[4] = "not-a-felt";
    const poolCall = decodeClientActions(transaction, POOL_ADDR);

    expect(poolCall).not.toBeNull();
    expect(getShadowAccountAddress(poolCall!, ANONYMIZER_ADDR)).toBeNull();
  });

  it("returns null when the transaction runs no interaction", () => {
    expect(addressOf([depositAction()])).toBeNull();
  });

  it("derives the address even when the invoke creates no open note", () => {
    expect(
      addressOf([
        computeAndInvoke({ invoke_additional_data: invokeAdditionalData([]) }),
      ])
    ).toBe(addressOf([computeAndInvoke({})]));
  });

  it("gives each nonce its own address", () => {
    const first = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME, 1n] }),
    ]);
    const second = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME, 2n] }),
    ]);
    expect(first).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("gives each dapp its own address", () => {
    const other = addressOf([
      computeAndInvoke({ compute_additional_data: [DAPP_NAME + 1n, NONCE] }),
    ]);
    expect(addressOf([computeAndInvoke({})])).not.toBe(other);
  });

  it("finds the interaction alongside a deposit", () => {
    expect(addressOf([depositAction(), computeAndInvoke({})])).toBe(
      addressOf([computeAndInvoke({})])
    );
  });
});

describe("createsOpenNotes", () => {
  it("is true for an interaction carrying an open note", () => {
    expect(createsOpenNotes(computeAndInvoke({}))).toBe(true);
  });

  it("is false for an interaction carrying none", () => {
    expect(
      createsOpenNotes(
        computeAndInvoke({ invoke_additional_data: invokeAdditionalData([]) })
      )
    ).toBe(false);
  });

  it("is false when the invoke data does not decode", () => {
    const truncated = invokeAdditionalData(OPEN_NOTES).slice(0, 2);
    expect(
      createsOpenNotes(computeAndInvoke({ invoke_additional_data: truncated }))
    ).toBe(false);
  });

  it("is false when the invoke data claims more open notes than it carries", () => {
    const data = invokeAdditionalData(OPEN_NOTES);
    // The open notes follow the calls; their length prefix is the felt after them.
    const openNotesLengthIndex = data.length - 1 - 3;
    data[openNotesLengthIndex] = "2";
    expect(
      createsOpenNotes(computeAndInvoke({ invoke_additional_data: data }))
    ).toBe(false);
  });
});
