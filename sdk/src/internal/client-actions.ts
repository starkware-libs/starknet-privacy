/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * Generated from sdk/src/internal/abi.ts
 * Run: npx tsx scripts/generate-client-actions.ts
 */

import { Call } from "starknet";
import { StarknetAddressBigint } from "../interfaces.js";

export type SetViewingKeyInput = {
  random: bigint;
};

export type OpenChannelInput = {
  recipient_addr: StarknetAddressBigint;
  recipient_public_key: bigint;
  index: number;
  random: bigint;
  salt: bigint;
};

export type OpenSubchannelInput = {
  recipient_addr: StarknetAddressBigint;
  recipient_public_key: bigint;
  channel_key: bigint;
  index: number;
  token: StarknetAddressBigint;
  salt: bigint;
};

export type CreateEncNoteInput = {
  recipient_addr: StarknetAddressBigint;
  recipient_public_key: bigint;
  token: StarknetAddressBigint;
  amount: bigint;
  index: number;
  salt: bigint;
};

export type CreateOpenNoteInput = {
  recipient_addr: StarknetAddressBigint;
  recipient_public_key: bigint;
  token: StarknetAddressBigint;
  index: number;
  depositor: StarknetAddressBigint;
  random: bigint;
};

export type DepositInput = {
  token: StarknetAddressBigint;
  amount: bigint;
};

export type UseNoteInput = {
  channel_key: bigint;
  token: StarknetAddressBigint;
  index: number;
};

export type WithdrawInput = {
  to_addr: StarknetAddressBigint;
  token: StarknetAddressBigint;
  amount: bigint;
  random: bigint;
};

export type SwapInput = {
  swap_executor: StarknetAddressBigint;
  swap_contract: StarknetAddressBigint;
  swap_selector: bigint;
  swap_calldata: unknown;
  in_token: StarknetAddressBigint;
  out_token: StarknetAddressBigint;
  in_amount: bigint;
  channel_key: bigint;
  index: number;
  random: bigint;
};

export type FollowupCallInput = {
  call: Call;
};

/**
 * Union of all client actions.
 */
export type ClientAction =
  | { type: "SetViewingKey"; input: SetViewingKeyInput }
  | { type: "OpenChannel"; input: OpenChannelInput }
  | { type: "OpenSubchannel"; input: OpenSubchannelInput }
  | { type: "CreateEncNote"; input: CreateEncNoteInput }
  | { type: "CreateOpenNote"; input: CreateOpenNoteInput }
  | { type: "Deposit"; input: DepositInput }
  | { type: "UseNote"; input: UseNoteInput }
  | { type: "Withdraw"; input: WithdrawInput }
  | { type: "Swap"; input: SwapInput }
  | { type: "FollowupCall"; input: FollowupCallInput };

/** All valid client action type names */
export const CLIENT_ACTION_TYPES = [
  "SetViewingKey",
  "OpenChannel",
  "OpenSubchannel",
  "CreateEncNote",
  "CreateOpenNote",
  "Deposit",
  "UseNote",
  "Withdraw",
  "Swap",
  "FollowupCall",
] as const;

export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];
