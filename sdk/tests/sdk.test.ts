import { describe, expectTypeOf, it } from "vitest";
import type {
  AccountInvocationsFactory,
  CallAndProof,
  Note,
  NotesStore,
  PrivacyPool,
  PrivacyPoolConfig,
  PrivateInvocationResult,
  ProviderInterface,
  ProviderOptions
} from "../src/index.js";
import type { Account, AccountInterface, Call, StarknetAddress } from "starknet";

describe("Privacy pool interface contracts", () => {
  it("allows constructing a typed privacy pool config", async () => {
    const provider: ProviderInterface = {
      prove: async () => ({
        data: new Uint8Array([1, 2, 3]),
        output: new Uint8Array([4, 5, 6])
      })
    };

    const noteStore: NotesStore = {
      load: async () => [],
      persist: async () => undefined
    };

    const factory: AccountInvocationsFactory = {
      buildInvocation: async (account, callAndProof) => ({
        account,
        call: callAndProof.call,
        proof: callAndProof.proof,
        metadata: { strategy: "private-transfer" }
      })
    };

    const config: PrivacyPoolConfig = {
      account: {} as Account,
      viewingSigner: "0xdeadbeef",
      provingProvider: provider,
      existingNotes: [{ channel: 0n, index: 0, amount: 1n }],
      noteStore,
      noteSelector: ({ available }) => available.slice(0, 1),
      accountInvocationsFactory: factory
    };

    expectTypeOf(config.provingProvider).toMatchTypeOf<ProviderOptions | ProviderInterface>();
    expectTypeOf(config.existingNotes?.[0]).toMatchTypeOf<Note>();
  });

  it("describes the privacy pool surface area", async () => {
    const proof = { data: new Uint8Array([0]), output: new Uint8Array([1]) };
    const callAndProof: CallAndProof = { call: {} as Call, proof };

    const invocationResult: PrivateInvocationResult = {
      invocationData: callAndProof,
      remainder: { channel: 1n, index: 1, amount: 1n }
    };

    const provider: ProviderInterface = {
      prove: async () => proof
    };

    const pool: PrivacyPool = {
      account: {} as AccountInterface,
      viewingSigner: 1n,
      provingProvider: provider,
      notes: [],
      noteSelector: ({ available }) => available,
      isRegistered: async () => true,
      register: async () => callAndProof,
      transfer: async () => invocationResult,
      deposit: async () => invocationResult,
      withdraw: async () => invocationResult,
      discoverNotes: async () => [],
      getPrivateCall: async () => callAndProof
    };

    expectTypeOf(await pool.register()).toMatchTypeOf<CallAndProof>();
    expectTypeOf(await pool.transfer("0x0" as StarknetAddress, [], "0x1" as StarknetAddress, 1n)).toMatchTypeOf<
      PrivateInvocationResult
    >();
  });
});
