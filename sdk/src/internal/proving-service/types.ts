/**
 * Types for the Proving Service JSON-RPC API (Starknet RPC v0.10).
 */

/** Block identifier for proveTransaction. "pending" is not supported. */
export type BlockId =
  | "latest"
  | "pending"
  | { block_hash: string }
  | { block_number: number };

/** L2 to L1 message in ProveTransactionResult. */
export interface MessageToL1 {
  from_address: string;
  to_address: string;
  payload: string[];
}

/** Result of starknet_proveTransaction. */
export interface ProveTransactionResult {
  /** The generated proof as an array of u32 values */
  proof: number[];
  /** Proof facts as an array of felt hex strings */
  proof_facts: string[];
  /** Messages sent from L2 to L1 during execution */
  l2_to_l1_messages: MessageToL1[];
}

/** Invoke V3 transaction shape expected by the proving service. */
export interface RpcInvokeTransactionV3 {
  type: "INVOKE";
  version: "0x3";
  sender_address: string;
  calldata: string[];
  signature: string[];
  nonce: string;
  resource_bounds: {
    l1_gas: { max_amount: string; max_price_per_unit: string };
    l2_gas: { max_amount: string; max_price_per_unit: string };
    l1_data_gas: { max_amount: string; max_price_per_unit: string };
  };
  tip: string;
  paymaster_data: string[];
  account_deployment_data: string[];
  nonce_data_availability_mode: "L1" | "L2";
  fee_data_availability_mode: "L1" | "L2";
}
