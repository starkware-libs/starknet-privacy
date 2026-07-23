import { constants, type RpcProvider, type SignerInterface } from "starknet";
import {
  Devnet,
  ScreeningCallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createEmptyRegistry,
  type StarknetAddress,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  createPrivacyClient,
  CorePrivateTransfersProver,
  SdkWallet,
} from "@starkware-libs/starknet-privacy-client";
import type {
  Paymaster,
  PaymasterExecute,
  PrivacyClient,
} from "@starkware-libs/starknet-privacy-client";

/**
 * Shared devnet plumbing for the client-driven signing/sub-account tests: the identical
 * `CorePrivateTransfersProver` construction, an `SdkWallet`-backed client, a token-balance read, and
 * the `executeOutside` broadcast of a proven `apply_actions`. Only the signer and the paymaster/wallet
 * seam differ between tests, so those stay in each test.
 */

const CHAIN_ID = constants.StarknetChainId.SN_SEPOLIA;

export interface CoreProverParams {
  signer: SignerInterface;
  address: StarknetAddress;
  passphrase: string;
  provider: RpcProvider;
  indexerApiUrl: string;
  poolAddress: string;
  /** Only needed when the flow calls `subaccounts(...)`; unused otherwise. */
  subAccountAnonymizerAddress?: string;
}

/** The `CorePrivateTransfersProver` every client test builds (mock prover, indexer discovery). */
export function makeCoreProver(
  params: CoreProverParams,
): CorePrivateTransfersProver {
  return new CorePrivateTransfersProver({
    signer: params.signer,
    address: params.address,
    passphrase: params.passphrase,
    provider: params.provider,
    discovery: new IndexerDiscoveryProvider(
      params.indexerApiUrl,
      params.poolAddress,
    ),
    prover: new ScreeningCallMockProofProvider(params.provider, CHAIN_ID),
    poolContractAddress: params.poolAddress,
    subAccountAnonymizerAddress: params.subAccountAnonymizerAddress ?? "0x1",
    storage: {
      loadRegistry: async () => createEmptyRegistry(),
      saveRegistry: async () => {},
    },
  });
}

/** A `PrivacyClient` over `SdkWallet` (prover + the given paymaster) — the shape both signing tests use. */
export function makeSdkWalletClient(
  params: CoreProverParams & { paymaster: Paymaster },
): PrivacyClient {
  const prover = makeCoreProver(params);
  const wallet = new SdkWallet({
    prover,
    paymaster: params.paymaster,
    poolContractAddress: params.poolAddress,
    signer: params.signer,
    userAddress: params.address,
  });
  return createPrivacyClient({
    wallet,
    userAddress: params.address,
    provider: params.provider,
    subAccountAnonymizerAddress: params.subAccountAnonymizerAddress ?? "0x1",
  });
}

/** The token balance `holder` holds, as a bigint (u256 `balance_of`). */
export async function tokenBalance(
  provider: RpcProvider,
  token: string,
  holder: string,
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: token,
    entrypoint: "balance_of",
    calldata: [holder],
  });
  return BigInt(result[0]) + (BigInt(result[1]) << 128n);
}

/** Broadcast a proven `apply_actions` call with an ordinary account, as a paymaster would. */
export async function broadcastProvenCall(
  devnet: Devnet,
  call: { contractAddress: string; entrypoint: string; calldata: string[] },
  proof: { data: string; output?: string[]; proofFacts: string[] },
): Promise<{ transaction_hash: string }> {
  const receipt = await devnet.executeOutside({
    call,
    proof: {
      data: proof.data,
      output: proof.output ?? [],
      proofFacts: proof.proofFacts,
    },
  });
  return { transaction_hash: receipt.transaction_hash };
}

/**
 * Broadcast the proven `apply_actions` from a paymaster `execute` request with an ordinary account —
 * the public leg a real paymaster performs after relaying any user-signed invoke.
 */
export function broadcastAppliedActions(
  devnet: Devnet,
  execute: PaymasterExecute,
): Promise<{ transaction_hash: string }> {
  return broadcastProvenCall(
    devnet,
    {
      contractAddress: execute.applyActionsCall.to,
      entrypoint: "apply_actions",
      calldata: execute.applyActionsCall.calldata,
    },
    { data: execute.proof, proofFacts: execute.proofFacts },
  );
}
