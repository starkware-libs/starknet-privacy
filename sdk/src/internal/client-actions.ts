/**
 * Client action input types - TypeScript equivalents of Cairo ClientAction inputs.
 * These are the "unwrapped" action types that contain all information needed
 * for proof generation and on-chain execution.
 *
 * See packages/privacy/src/actions.cairo for the Cairo definitions.
 */

import { Call } from "starknet";
import type { Amount, NoteId, Open, StarknetAddress, ViewingKey } from "../interfaces.js";

/**
 * Input for the SetViewingKey action.
 */
export type SetViewingKeyInput = {
  /** The viewing key (private key) to set */
  privateKey: ViewingKey;
  /** Random value use to encrypt the private key for compliance */
  random: bigint;
};

/**
 * Input for the OpenChannel action.
 */
export type OpenChannelInput = {
  /** The sender's private key (viewing key) */
  senderPrivateKey: ViewingKey;
  /** The recipient's address */
  recipientAddr: StarknetAddress;
  /** The recipient's public key */
  recipientPublicKey: bigint;
  /** Random value used to encrypt the channel info for the recipient */
  random: bigint;
};

/**
 * Input for the OpenSubchannel (token channel) action.
 */
export type OpenSubchannelInput = {
  /** The recipient's address */
  recipientAddr: StarknetAddress;
  /** The recipient's public key */
  recipientPublicKey: bigint;
  /** The channel key of the subchannel */
  channelKey: bigint;
  /** The index of the subchannel within the channel (token nonce) */
  index: number;
  /** The token address */
  token: StarknetAddress;
  /** Random value used to encrypt the subchannel token */
  random: bigint;
};

/**
 * Input for the CreateNote action.
 */
export type CreateNoteInput = {
  /** The sender's private key (viewing key) */
  senderPrivateKey: ViewingKey;
  /** The recipient's address */
  recipientAddr: StarknetAddress;
  /** The recipient's public key */
  recipientPublicKey: bigint;
  /** The token's address */
  token: StarknetAddress;
  /** The amount the note represents */
  amount: Amount | Open;
  /** The index of the note within the channel (note nonce) */
  index: number;
  /** Random value used to encrypt the note amount (must be 120 bits) */
  random: bigint;
};

/**
 * Input for the Deposit action.
 */
export type DepositInput = {
  /** The token's address */
  token: StarknetAddress;
  /** The amount to deposit */
  amount: Amount;
  /** The note id to deposit to (open note) */
  noteId?: NoteId;
};

/**
 * Input for the UseNote action.
 */
export type UseNoteInput = {
  /** The owner's private key (viewing key) */
  ownerPrivateKey: ViewingKey;
  /** The channel key of the note's channel */
  channelKey: bigint;
  /** The note's token address */
  token: StarknetAddress;
  /** The index of the note within the channel (note nonce) */
  noteIndex: number;
};

/**
 * Input for the Withdraw action.
 */
export type WithdrawInput = {
  /** The target of the withdrawal */
  withdrawalTarget: StarknetAddress;
  /** The token's address */
  token: StarknetAddress;
  /** The amount to withdraw */
  amount: Amount;
};

export type FollowupCallInput = {
  call: Call;
};

export type ClientAction =
  | { type: "SetViewingKey"; input: SetViewingKeyInput }
  | { type: "OpenChannel"; input: OpenChannelInput }
  | { type: "OpenSubchannel"; input: OpenSubchannelInput }
  | { type: "Deposit"; input: DepositInput }
  | { type: "UseNote"; input: UseNoteInput }
  | { type: "CreateNote"; input: CreateNoteInput }
  | { type: "Withdraw"; input: WithdrawInput }
  | { type: "FollowupCall"; input: FollowupCallInput };
