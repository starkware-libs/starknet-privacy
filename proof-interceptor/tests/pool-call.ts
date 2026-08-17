// tests/pool-call.ts
import { CairoCustomEnum, CallData, num } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { ShadowAccountAnonymizerABI } from "@starkware-libs/starknet-privacy-sdk";
import type { ProveTxnV3 } from "../src/types.js";

export const POOL_ADDR = "0x9001";
export const USER_ADDR = "0xaaa111";
export const PRIVATE_KEY = "0xbbb222";
export const TOKEN = "0xdead";
export const ANONYMIZER_ADDR = "0x5678";
export const DAPP_NAME = 0x646170n;
export const NONCE = 7n;

const poolCallData = new CallData(PrivacyPoolABI);
const anonymizerCallData = new CallData(ShadowAccountAnonymizerABI);

/** One dapp call, standing in for whatever the shadow account is asked to run. */
export const DAPP_CALLS = [{ to: TOKEN, selector: "0x1", calldata: ["0x2"] }];

/** One open note, collecting the shadow account's whole balance of `TOKEN`. */
export const OPEN_NOTES = [
  {
    note_id: "0x3",
    token: TOKEN,
    collect_policy: new CairoCustomEnum({ All: {} }),
  },
];

/**
 * The `invoke_additional_data` the SDK's shadow account builder produces: the anonymizer's
 * `privacy_invoke_with_computation` calldata without its leading `identity_commitment`, which the
 * pool prepends from the compute result. Compiled through the anonymizer ABI, so a Cairo-side
 * change to those arguments reaches these tests instead of leaving hand-written felts that still
 * decode into something.
 */
export function invokeAdditionalData(openNotes: unknown[]): string[] {
  return anonymizerCallData
    .compile("privacy_invoke_with_computation", [0n, DAPP_CALLS, openNotes])
    .slice(1);
}

export function depositAction(): CairoCustomEnum {
  return new CairoCustomEnum({ Deposit: { token: TOKEN, amount: "0x64" } });
}

/**
 * A prove request calling the pool's `compile_actions`: a single-call INVOKE
 * whose inner calldata is `[user_addr, user_private_key, ...client actions]`.
 * The pool ABI serializes the actions, so a test reads the calldata a client
 * really sends instead of felts written out by hand.
 */
export function poolCallTransaction(actions: CairoCustomEnum[]): ProveTxnV3 {
  const innerCalldata = poolCallData
    .compile("compile_actions", [USER_ADDR, PRIVATE_KEY, actions])
    .map((felt) => num.toHex(felt));
  return {
    type: "INVOKE",
    version: "0x3",
    sender_address: "0xcontract",
    calldata: [
      "0x1", // 1 call
      POOL_ADDR,
      "0xselector",
      num.toHex(innerCalldata.length),
      ...innerCalldata,
    ],
    signature: ["0x1"],
    nonce: "0x0",
    resource_bounds: {},
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
  } as unknown as ProveTxnV3;
}
