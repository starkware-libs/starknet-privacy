import type { Call, EstimateFeeResponseOverhead } from "starknet";
import { createPrivacyBuilder } from "./builder.js";
import { toStarknetCall } from "./calls.js";
import type {
  PrivacyBuilder,
  PrivacyClient,
  PrivacyClientConfig,
  Strk20Action,
  SubmitOptions,
  SubmitResult,
} from "./interfaces.js";

/**
 * The dapp client. Holds the injected wallet + read context (provider + sub-account anonymizer) and
 * drives the wallet seam. A native get-starknet v6 wallet satisfies {@link PrivacyWallet} directly,
 * so `submit` passes straight through to its strk20 methods; an `SdkWallet` (upstack) makes the same
 * seam calls but proves + submits through the core SDK + paymaster. The operation builder is added
 * upstack over this low-level entry point.
 */
class PrivacyClientImpl implements PrivacyClient {
  constructor(private readonly config: PrivacyClientConfig) {}

  submit(
    actions: Strk20Action[],
    options?: SubmitOptions & { simulate?: false }
  ): Promise<SubmitResult>;
  submit(
    actions: Strk20Action[],
    options: SubmitOptions & { simulate: true }
  ): Promise<EstimateFeeResponseOverhead>;
  async submit(
    actions: Strk20Action[],
    options: SubmitOptions & { simulate?: boolean } = {}
  ): Promise<SubmitResult | EstimateFeeResponseOverhead> {
    const { wallet } = this.config;
    const { preCalls = [], postCalls = [], simulate = false } = options;

    // Fast path: nothing wraps the invoke and we are broadcasting → the combined prepare+submit.
    if (preCalls.length === 0 && postCalls.length === 0 && !simulate) {
      return wallet.strk20InvokeTransaction(actions);
    }

    const { call, proof } = await wallet.strk20PrepareInvoke(actions, simulate);
    const calls: Call[] = [...preCalls, toStarknetCall(call), ...postCalls];
    // simulate: estimate the assembled invoke on the node (empty proof) for a fee quote/preview.
    return simulate ? wallet.estimateInvokeFee(calls) : wallet.executeWithProof(calls, proof);
  }

  build(): PrivacyBuilder {
    return createPrivacyBuilder(this.config.userAddress, this.submit.bind(this));
  }
}

/**
 * Creates a dapp client for Starknet privacy from a {@link PrivacyWallet} the dapp constructs — a
 * get-starknet v6 wallet directly, or (upstack) an `SdkWallet` over a signer.
 */
export function createPrivacyClient(config: PrivacyClientConfig): PrivacyClient {
  return new PrivacyClientImpl(config);
}
