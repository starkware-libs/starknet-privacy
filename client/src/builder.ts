import { num } from "starknet";
import type { BigNumberish, EstimateFeeResponseOverhead, STRK20_CALLDATA_ITEM } from "starknet";
import type { StarknetAddress } from "@starkware-libs/starknet-privacy-sdk";
import type {
  PrivacyBuilder,
  PrivacyClient,
  PrivacyComputeInvokeCallBuilder,
  PrivacyInvokeArgs,
  PrivacyInvokeCallBuilder,
  PrivacyTokenBuilder,
  Strk20Action,
  SubmitResult,
} from "./interfaces.js";

const toFelt = (value: BigNumberish): string => num.toHex(num.toBigInt(value));

/**
 * The fluent operation builder behind {@link PrivacyClient.build}. Each method appends a
 * {@link Strk20Action}; `submit`/`simulate` hand the accumulated actions to `client.submit`.
 *
 * Invoke call builders receive `${openNoteIds[N]}` / `${poolAddress}` placeholders the wallet
 * substitutes at proving time. `openNoteIds` is sized to the open notes created *so far*, so open
 * notes must be created before the `invoke` / `invokeWithComputation` that references them —
 * `createOpenNote` after an invoke throws.
 */
class PrivacyBuilderImpl implements PrivacyBuilder {
  private readonly actions: Strk20Action[] = [];
  private openNoteCount = 0;
  private invoked = false;

  constructor(
    private readonly userAddress: StarknetAddress,
    private readonly submitActions: PrivacyClient["submit"]
  ) {}

  with(token: StarknetAddress): PrivacyTokenBuilder {
    return new PrivacyTokenBuilderImpl(this, toFelt(token));
  }

  invoke(callBuilder: PrivacyInvokeCallBuilder): PrivacyBuilder {
    this.invoked = true;
    const details = callBuilder(this.invokeArgs());
    return this.append({
      type: "invoke",
      contract: String(details.contractAddress),
      calldata: (details.calldata ?? []) as STRK20_CALLDATA_ITEM[],
    });
  }

  invokeWithComputation(callBuilder: PrivacyComputeInvokeCallBuilder): PrivacyBuilder {
    this.invoked = true;
    const details = callBuilder(this.invokeArgs());
    return this.append({
      type: "compute_and_invoke",
      contract: details.contractAddress,
      compute_calldata: details.computeCalldata,
      invoke_calldata: details.invokeCalldata,
    });
  }

  submit(): Promise<SubmitResult> {
    return this.submitActions(this.actions);
  }

  simulate(): Promise<EstimateFeeResponseOverhead> {
    return this.submitActions(this.actions, { simulate: true });
  }

  /** Append an action and return the builder for chaining. Used by the sub-builders. */
  append(action: Strk20Action): PrivacyBuilder {
    this.actions.push(action);
    return this;
  }

  /** Append an open note (a transfer of `"OPEN"` to the user), enforcing open-notes-before-invoke. */
  appendOpenNote(token: string): PrivacyBuilder {
    if (this.invoked) {
      throw new Error(
        "PrivacyBuilder: create open notes before invoke/invokeWithComputation (an invoke's " +
          "calldata references the open notes by index)"
      );
    }
    this.openNoteCount += 1;
    return this.append({
      type: "transfer",
      token,
      amount: "OPEN",
      recipient: toFelt(this.userAddress),
    });
  }

  private invokeArgs(): PrivacyInvokeArgs {
    return {
      openNoteIds: Array.from(
        { length: this.openNoteCount },
        (_, index) => `\${openNoteIds[${index}]}`
      ),
      poolAddress: "${poolAddress}",
    };
  }
}

/** Token-scoped operations for one token, opened by {@link PrivacyBuilderImpl.with}. */
class PrivacyTokenBuilderImpl implements PrivacyTokenBuilder {
  constructor(
    private readonly builder: PrivacyBuilderImpl,
    private readonly token: string
  ) {}

  deposit({ amount }: { amount: BigNumberish }): PrivacyBuilder {
    return this.builder.append({ type: "deposit", token: this.token, amount: toFelt(amount) });
  }

  withdraw(args: { amount: BigNumberish; recipient: StarknetAddress }): PrivacyBuilder {
    return this.recipientAction("withdraw", args);
  }

  transfer(args: { amount: BigNumberish; recipient: StarknetAddress }): PrivacyBuilder {
    return this.recipientAction("transfer", args);
  }

  private recipientAction(
    type: "withdraw" | "transfer",
    { amount, recipient }: { amount: BigNumberish; recipient: StarknetAddress }
  ): PrivacyBuilder {
    return this.builder.append({
      type,
      token: this.token,
      amount: toFelt(amount),
      recipient: toFelt(recipient),
    } as Strk20Action);
  }

  createOpenNote(): PrivacyBuilder {
    return this.builder.appendOpenNote(this.token);
  }
}

/** Create the fluent operation builder for {@link PrivacyClient.build}. */
export function createPrivacyBuilder(
  userAddress: StarknetAddress,
  submit: PrivacyClient["submit"]
): PrivacyBuilder {
  return new PrivacyBuilderImpl(userAddress, submit);
}
