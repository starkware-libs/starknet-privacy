import type { PrivacyClient, PrivacyClientConfig } from "./interfaces.js";

/**
 * The dapp client. Holds the config (wallet + read context: provider + sub-account anonymizer); the
 * operation builder and `addresses()` are added upstack and read through them and
 * `wallet.partialCommitment(dappName)`.
 */
class PrivacyClientImpl implements PrivacyClient {
  constructor(private readonly config: PrivacyClientConfig) {}
}

/**
 * Creates a dapp client for Starknet privacy from a {@link PrivacyWallet} the dapp constructs — a
 * get-starknet v6 wallet directly, or (upstack) an `SdkWallet` over a signer.
 */
export function createPrivacyClient(config: PrivacyClientConfig): PrivacyClient {
  return new PrivacyClientImpl(config);
}
