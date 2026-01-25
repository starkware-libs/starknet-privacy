// Re-export all utilities

export { jsonStringify, jsonParse } from "./json.js";
export {
  withLogging,
  consoleLogCallback,
  noopLogCallback,
  isDebugEnabled,
  debugHint,
  DEBUG_ENV_VAR,
  type LogCallback,
} from "./logging.js";
export { AdvancedMap, AddressMap } from "./maps.js";
export { assert, assertViewingKey, assertRecipientAddress, isOpen } from "./validation.js";
export {
  hash,
  shortStringToFelt,
  encryptChannelInfo,
  decryptChannelInfo,
  derivePublicKey,
  encryptSymmetric,
  decryptSymmetric,
  toBigInt,
  type Hash,
  type ChannelKey,
  type PublicKey,
  type PrivateKey,
  type EncChannelInfo,
  type ChannelInfo,
  type SymmetricEncryption,
} from "./crypto.js";
// Hash functions - both new snake_case API and deprecated hashes object
export {
  // New API (snake_case, matches Cairo 1:1)
  compute_channel_key,
  compute_channel_id,
  compute_subchannel_key,
  compute_subchannel_id,
  compute_note_id,
  compute_nullifier,
  compute_enc_amount_hash,
  compute_enc_token_hash,
  compute_enc_private_key_hash,
  compute_enc_address_hash,
  compute_enc_channel_key_hash,
  compute_enc_sender_addr_hash,
  // Deprecated backwards-compatible API
  hashes,
} from "./hashes.js";
