// Shared types for the wallet-extension module. Kept in its own file so the
// other modules (connect, derive-viewing-key, outside-execution, submit) can
// import without cyclic dependencies.

import type { StarknetWindowObject } from "get-starknet";

export type ConnectedWallet = {
  /** The wallet object returned by get-starknet (`wallet_requestAccounts` etc.). */
  wallet: StarknetWindowObject;
  /** The signing account's address (lowercased, 0x-prefixed). */
  address: string;
  /** Chain id returned by the wallet (hex). */
  chainId: string;
  /** Display name shown in the UI ("Argent X", "Braavos", ...). */
  walletName: string;
};

/** Result of attempting to derive the wallet-ext keys via wallet signature. */
export type ViewingKeyDerivation =
  | {
      kind: "ok";
      viewingKey: bigint;
      /** Stark-curve scalar used as the Signer's private key for ZK proof
       *  generation. Derived from the same wallet signature as `viewingKey`
       *  but with a distinct domain separator. The wallet's master key is
       *  not exposed; this is an app-level secondary key that's registered
       *  on the pool. */
      proofPrivateKey: bigint;
    }
  | { kind: "rejected" } // user declined the signing prompt
  | { kind: "error"; message: string };
