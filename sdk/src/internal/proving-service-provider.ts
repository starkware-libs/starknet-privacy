/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Uses Invoke V3 transaction format; fetches nonce from the chain.
 */

import type { Account, constants, ProviderInterface } from "starknet";
import { num, stark } from "starknet";
import type { Proof, ProofInvocationWithPayload } from "../interfaces.js";
import { ensureHexCalldata, toHex } from "../utils/convert.js";
import { AbstractProofProvider } from "./abstract-proof-provider.js";
import { ProvingService } from "./proving-service.js";

const DEFAULT_PROVING_SERVICE_PORT = 3000;
/** Default request timeout: 600s (proofs take ~1–2 min; guide recommends --max-time 600). */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Decode base64 to bytes (Node: Buffer; browser: atob). */
function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Proof to bytes: u32[] packed big-endian, or base64 string decoded. */
function proofToBytes(proof: number[] | string): Uint8Array {
  if (typeof proof === "string") {
    return base64ToBytes(proof);
  }
  const buf = new Uint8Array(proof.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < proof.length; i++) {
    view.setUint32(i * 4, proof[i] >>> 0, false);
  }
  return buf;
}

/**
 * Proving service URL. If a host is given (no scheme), defaults to http and port 3000.
 */
export function normalizeProvingServiceUrl(hostOrUrl: string): string {
  const s = hostOrUrl.trim();
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return s;
  }
  return s.includes(":") ? `http://${s}` : `http://${s}:${DEFAULT_PROVING_SERVICE_PORT}`;
}

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. Proofs take ~1–2 min; default 600_000 (10 min). */
  requestTimeoutMs?: number;
};

/**
 * Proof provider that sends the invocation to a remote proving service (JSON-RPC)
 * and returns the STARK proof. Server actions for execute_actions come from the
 * L2-to-L1 message payload (from_address = pool).
 */
export class ProvingServiceProofProvider extends AbstractProofProvider {
  private readonly provingService: ProvingService;

  constructor(
    provingServiceUrl: string,
    private readonly provider: ProviderInterface,
    private readonly chainId: constants.StarknetChainId,
    private readonly account: Account,
    options: ProvingServiceProofProviderOptions = {}
  ) {
    super();
    this.provingService = new ProvingService({
      baseUrl: normalizeProvingServiceUrl(provingServiceUrl),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  protected getChainId(): constants.StarknetChainId {
    return this.chainId;
  }

  async prove(invocation: ProofInvocationWithPayload): Promise<Proof> {
    const inv = invocation;
    const transactionPayload = {
      type: "INVOKE",
      version: "0x3",
      sender_address: toHex(inv.contractAddress),
      calldata: ensureHexCalldata(inv.calldata as string[]),
      signature: stark
        .formatSignature(inv.signature ?? [])
        .map((s: string) =>
          typeof s === "string" && s.startsWith("0x") ? s : num.toHex(s)
        ),
      nonce: num.toHex(inv.nonce),
      resource_bounds: {
        l1_gas: {
          max_amount: num.toHex(inv.resourceBounds.l1_gas.max_amount),
          max_price_per_unit: num.toHex(inv.resourceBounds.l1_gas.max_price_per_unit),
        },
        l2_gas: {
          max_amount: num.toHex(inv.resourceBounds.l2_gas.max_amount),
          max_price_per_unit: num.toHex(inv.resourceBounds.l2_gas.max_price_per_unit),
        },
        l1_data_gas: {
          max_amount: num.toHex(inv.resourceBounds.l1_data_gas.max_amount),
          max_price_per_unit: num.toHex(inv.resourceBounds.l1_data_gas.max_price_per_unit),
        },
      },
      tip: num.toHex(inv.tip),
      paymaster_data: inv.paymasterData ?? [],
      account_deployment_data: inv.accountDeploymentData ?? [],
      nonce_data_availability_mode: inv.nonceDataAvailabilityMode ?? "L1",
      fee_data_availability_mode: inv.feeDataAvailabilityMode ?? "L1",
    };

    const result = await this.provingService.proveTransaction("latest", transactionPayload);

    // Server actions for execute_actions: from L2-to-L1 message payload (no execute_view call)
    const poolAddressHex = toHex(invocation.contractAddress);
    const poolMessage = result.l2_to_l1_messages?.find(
      (m) => m.from_address?.toLowerCase() === poolAddressHex.toLowerCase()
    );
    const output = poolMessage?.payload ?? [];

    const proofBytes = proofToBytes(result.proof);
    const proofFacts = result.proof_facts ?? [];

    return {
      data: proofBytes,
      output,
      proof_facts: proofFacts,
    };
  }
}
