// SNIP-9 outside-execution helpers.
//
// SNIP-9 lets an account holder pre-authorize a set of calls (the
// `OutsideExecution` struct) by signing a SNIP-12 typed-data hash. Any other
// address can then submit `account.execute_from_outside_v2(outside_exec, signature)`,
// and the account contract verifies the signature against its own owner key
// before relaying the inner calls.
//
// This module:
//   1. Builds the typed-data object the wallet must sign.
//   2. Serializes the OutsideExecution struct + signature into the calldata
//      shape that `execute_from_outside_v2` expects on the user's account.
//
// Reference: https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-9.md
// Argent X / Braavos both support the v2 (revision 1) variant.

import { hash, num, type Call } from "starknet";

// Special caller value defined by SNIP-9 meaning "any address may submit".
// We use this so the relayer's address isn't baked into the signed message —
// the user signs an OutsideExecution that any submitter can broadcast.
export const ANY_CALLER = "0x414e595f43414c4c4552"; // shortstring "ANY_CALLER"

export type OutsideExecution = {
  caller: string;
  nonce: string;
  executeAfter: number;
  executeBefore: number;
  calls: Call[];
};

/**
 * Build a fresh OutsideExecution with a 1-hour validity window and a random
 * 252-bit nonce. The nonce is local entropy — the user's account contract
 * still maintains its own nonce-replay storage to reject re-submissions.
 */
export function newOutsideExecution(
  calls: Call[],
  caller: string = ANY_CALLER
): OutsideExecution {
  const nowSecs = Math.floor(Date.now() / 1000);
  return {
    caller,
    nonce: randomFelt(),
    // 60s of clock-skew tolerance on the "after" side; 1 hour deadline.
    executeAfter: nowSecs - 60,
    executeBefore: nowSecs + 3600,
    calls,
  };
}

// SNIP-12 typed-data payload that the wallet signs. The shape is mandated
// by the SNIP-9 spec; field names + types must match the on-chain contract's
// expectations or signature verification will fail.
export function buildOutsideExecutionTypedData(
  outsideExec: OutsideExecution,
  chainId: string
) {
  return {
    domain: {
      name: "Account.execute_from_outside",
      version: shortString("2"),
      chainId,
      revision: "1",
    },
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      OutsideExecution: [
        { name: "Caller", type: "ContractAddress" },
        { name: "Nonce", type: "felt" },
        { name: "Execute After", type: "u128" },
        { name: "Execute Before", type: "u128" },
        { name: "Calls", type: "Call*" },
      ],
      Call: [
        { name: "To", type: "ContractAddress" },
        { name: "Selector", type: "selector" },
        { name: "Calldata", type: "felt*" },
      ],
    },
    primaryType: "OutsideExecution",
    message: {
      Caller: outsideExec.caller,
      Nonce: outsideExec.nonce,
      "Execute After": outsideExec.executeAfter,
      "Execute Before": outsideExec.executeBefore,
      Calls: outsideExec.calls.map((call) => ({
        To: call.contractAddress,
        Selector: call.entrypoint,
        Calldata: (asCalldataArray(call.calldata) ?? []).map((felt) => felt.toString()),
      })),
    },
  };
}

/**
 * Serialize the OutsideExecution + signature into the felt-array calldata
 * that the account contract's `execute_from_outside_v2` consumes. The order
 * and flat felt layout must match the Cairo struct definitions.
 *
 * Layout:
 *   [caller, nonce, execute_after, execute_before,
 *    calls_len, (to, selector, calldata_len, ...calldata)*,
 *    signature_len, ...signature]
 */
export function serializeOutsideExecution(
  outsideExec: OutsideExecution,
  signature: string[]
): string[] {
  const out: string[] = [];
  out.push(toHex(outsideExec.caller));
  out.push(toHex(outsideExec.nonce));
  out.push(toHex(outsideExec.executeAfter));
  out.push(toHex(outsideExec.executeBefore));
  out.push(toHex(outsideExec.calls.length));
  for (const call of outsideExec.calls) {
    out.push(toHex(call.contractAddress));
    out.push(toHex(selectorOf(call.entrypoint)));
    const calldata = (asCalldataArray(call.calldata) ?? []).map((felt) => toHex(felt));
    out.push(toHex(calldata.length));
    out.push(...calldata);
  }
  out.push(toHex(signature.length));
  out.push(...signature.map(toHex));
  return out;
}

function selectorOf(entrypoint: string): string {
  return hash.getSelectorFromName(entrypoint);
}

// starknet.js's `CallDetails.calldata` type is `RawArgs | Calldata`. The SDK
// flattens proofs/transfers into a `Calldata` (string[]) before they reach
// us, but TS can't infer that. Narrow defensively: if it's already an array
// of strings, return it; otherwise treat as empty (and the caller surfaces
// a runtime error if the shape is wrong).
function asCalldataArray(calldata: unknown): (string | number | bigint)[] | undefined {
  if (Array.isArray(calldata)) return calldata as (string | number | bigint)[];
  return undefined;
}

function toHex(value: string | number | bigint): string {
  return num.toHex(value);
}

function randomFelt(): string {
  // 252-bit random felt. Browser-safe — crypto.getRandomValues is universal.
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return "0x" + hex;
}

// SNIP-12 "shortstring" type — the actual encoding is just the regular
// ASCII bytes of the string, but starknet.js expects the typed-data builder
// to pass the raw value. Keeping a wrapper so we can swap to a felt-encoded
// form if the wallet ever complains.
function shortString(value: string): string {
  return value;
}
