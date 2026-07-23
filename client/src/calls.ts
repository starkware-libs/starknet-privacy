import type { Call, STRK20_CALLDATA_ITEM } from "starknet";

/**
 * A Starknet call in strk20 (snake_case) wire form — the shape shared by the wallet-api call
 * (`STRK20_CALL_AND_PROOF["call"]`) and the local `Strk20Call` shim. `calldata` may be omitted.
 */
export interface Strk20WireCall {
  contract_address: string;
  entry_point: string;
  calldata?: STRK20_CALLDATA_ITEM[];
}

/** Map a starknet.js {@link Call} to the strk20 (snake_case) wire shape (`calldata` always present). */
export function toStrk20Call(call: Call): Required<Strk20WireCall> {
  return {
    contract_address: String(call.contractAddress),
    entry_point: call.entrypoint,
    calldata: (call.calldata ?? []) as STRK20_CALLDATA_ITEM[],
  };
}

/** Map a strk20 (snake_case) call back to a starknet.js {@link Call}. */
export function toStarknetCall(call: Strk20WireCall): Call {
  return {
    contractAddress: call.contract_address,
    entrypoint: call.entry_point,
    calldata: call.calldata,
  };
}
