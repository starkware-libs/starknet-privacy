// Asserts that `runBuilder(...)` produces the 5-action client-call shape the
// anonymizer expects (UseNote → CreateOpenNote × 2 → Withdraw → InvokeExternal)
// and that the `Call` it ships off is a single `apply_actions` invocation.
//
// We don't run the real SDK end-to-end here — it would require a live prover.
// Instead, we feed `runBuilder` a fake `PrivateTransfersInterface` that wires
// the builder primitives to a flat captured-actions log, then assert on it.
import { describe, expect, it, vi } from "vitest";
import { Open, Witness, type Note } from "starknet-sdk";
import { runBuilder } from "./pool-builder";
import { STRK_TOKEN_ADDRESS } from "./chain";
import { privacyInvokeCalldata } from "./anonymizer";

const ANONYMIZER = "0x0000000000000000000000000000000000000000000000000000000000000aaa";
const DEPOSIT_ADDRESS = "0x" + "d".repeat(64);
const SWAP_ID = "0x0123456789abcdef";
const IN_AMOUNT = 1_000_000_000_000_000_000n; // 1 STRK in base units

function makeNote(amount: bigint): Note {
  return {
    id: amount,
    amount,
    witness: new Witness(0n, 0, 0n),
    sender: STRK_TOKEN_ADDRESS,
  };
}

interface CapturedAction {
  kind: "useNote" | "createOpenNote" | "withdraw" | "invoke";
  details: Record<string, unknown>;
}

/**
 * Minimal fake that records every builder call as a flat action log. The
 * shape mirrors the SDK `Actions` order:
 *   useNotes, createNotes (with `amount === Open` → CreateOpenNote), withdraws,
 *   invoke.
 */
function createFakeTransfers() {
  const actions: CapturedAction[] = [];
  let capturedInvokeCall: { contractAddress: string; calldata: unknown[] } | null = null;

  const tokenBuilder = {
    inputs(...notes: Note[]) {
      for (const note of notes) {
        actions.push({
          kind: "useNote",
          details: { token: STRK_TOKEN_ADDRESS, noteId: note.id, amount: note.amount },
        });
      }
      return tokenBuilder;
    },
    transfer(...outputs: { recipient: string; amount: bigint | typeof Open }[]) {
      for (const output of outputs) {
        if (output.amount === Open) {
          actions.push({
            kind: "createOpenNote",
            details: { token: STRK_TOKEN_ADDRESS, recipient: output.recipient },
          });
        }
      }
      return tokenBuilder;
    },
    withdraw(...outputs: { recipient: string; amount: bigint }[]) {
      for (const output of outputs) {
        actions.push({
          kind: "withdraw",
          details: {
            token: STRK_TOKEN_ADDRESS,
            recipient: output.recipient,
            amount: output.amount,
          },
        });
      }
      return tokenBuilder;
    },
  };

  const builder = {
    with(_token: string, op: (t: typeof tokenBuilder) => void) {
      op(tokenBuilder);
      return builder;
    },
    invoke(
      cb: (args: {
        openNotes: { noteId: bigint; token: bigint }[];
        withdrawals: { recipient: bigint; token: bigint; amount: bigint }[];
        poolAddress: bigint;
      }) => { contractAddress: string; calldata: unknown[] },
    ) {
      // Mirror SDK invariants: openNotes preserves declaration order; we expose
      // two open notes here so the callback's index lookup matches production.
      const openNotes = [
        { noteId: 0xfeed0n, token: BigInt(STRK_TOKEN_ADDRESS) },
        { noteId: 0xfeed1n, token: BigInt(STRK_TOKEN_ADDRESS) },
      ];
      const withdrawals = [
        {
          recipient: BigInt(ANONYMIZER),
          token: BigInt(STRK_TOKEN_ADDRESS),
          amount: IN_AMOUNT,
        },
      ];
      const result = cb({
        openNotes,
        withdrawals,
        poolAddress: BigInt("0x1"),
      });
      capturedInvokeCall = result;
      actions.push({ kind: "invoke", details: { ...result } });
      return builder;
    },
    async execute() {
      // The SDK's `execute()` returns `{ callAndProof: { call, proof }, ... }`
      // The wallet pop happens against `call`; for the test we just synthesize
      // a structurally-correct `apply_actions` placeholder.
      return {
        callAndProof: {
          call: {
            contractAddress: "0xpool",
            entrypoint: "apply_actions",
            // Production calldata is the serialized proof output; for assertion
            // purposes we stash the captured invoke calldata here so the test
            // can verify it round-tripped through `.invoke(...)`.
            calldata: capturedInvokeCall?.calldata ?? [],
          },
          proof: { data: "", output: [], proofFacts: [] },
        },
        registry: {} as never,
        warnings: [],
      };
    },
  };

  // Mocks the `transfers.build()` entrypoint that `runBuilder` calls.
  return {
    actions,
    fake: { build: vi.fn(() => builder) } as unknown as Parameters<
      typeof runBuilder
    >[0],
  };
}

describe("runBuilder", () => {
  it("composes the 5-action shape in canonical order", async () => {
    const { actions, fake } = createFakeTransfers();
    await runBuilder(fake, {
      inputNote: makeNote(IN_AMOUNT),
      inAmount: IN_AMOUNT,
      swapId: SWAP_ID,
      depositAddress: DEPOSIT_ADDRESS,
      anonymizerAddress: ANONYMIZER,
    });

    expect(actions).toHaveLength(5);
    expect(actions[0]).toMatchObject({ kind: "useNote", details: { amount: IN_AMOUNT } });
    expect(actions[1]).toMatchObject({
      kind: "createOpenNote",
      details: { recipient: ANONYMIZER },
    });
    expect(actions[2]).toMatchObject({
      kind: "createOpenNote",
      details: { recipient: ANONYMIZER },
    });
    expect(actions[3]).toMatchObject({
      kind: "withdraw",
      details: { recipient: ANONYMIZER, amount: IN_AMOUNT },
    });
    expect(actions[4]).toMatchObject({
      kind: "invoke",
      details: { contractAddress: ANONYMIZER },
    });
  });

  it("invoke calldata matches privacyInvokeCalldata(...) byte-for-byte", async () => {
    const { actions, fake } = createFakeTransfers();
    await runBuilder(fake, {
      inputNote: makeNote(IN_AMOUNT),
      inAmount: IN_AMOUNT,
      swapId: SWAP_ID,
      depositAddress: DEPOSIT_ADDRESS,
      anonymizerAddress: ANONYMIZER,
    });

    const invokeAction = actions[4];
    expect(invokeAction?.kind).toBe("invoke");
    const calldata = invokeAction?.details.calldata as string[];

    // The two open notes are emitted in declaration order: N_out then N_refund.
    const expected = privacyInvokeCalldata({
      swapId: SWAP_ID,
      assetIn: STRK_TOKEN_ADDRESS,
      inAmount: IN_AMOUNT,
      assetOut: STRK_TOKEN_ADDRESS,
      noteIdOut: `0x${(0xfeed0n).toString(16)}`,
      refundNoteId: `0x${(0xfeed1n).toString(16)}`,
      depositAddress: DEPOSIT_ADDRESS,
    });
    expect(calldata).toEqual(expected);
  });

  it("returns a single apply_actions call to feed to account.execute(...)", async () => {
    const { fake } = createFakeTransfers();
    const tx = await runBuilder(fake, {
      inputNote: makeNote(IN_AMOUNT),
      inAmount: IN_AMOUNT,
      swapId: SWAP_ID,
      depositAddress: DEPOSIT_ADDRESS,
      anonymizerAddress: ANONYMIZER,
    });

    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]).toMatchObject({
      contractAddress: "0xpool",
      entrypoint: "apply_actions",
    });
    expect(tx.executeOpts.tip).toBe(0n);
  });
});
