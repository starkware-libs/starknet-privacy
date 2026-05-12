/**
 * Helpers to predict the on-chain footprint of a transfer the counterparty will
 * make. Used by the OTC flow to commit, at proof time, to the EncNoteCreated
 * event the counterparty must emit — turning a generic InvokeExternal check
 * into a token-and-amount bound check.
 *
 * Matches Cairo: privacy.cairo:create_enc_note → ServerAction::EmitEncNoteCreated.
 */

import { compute_note_id } from "./hashes.js";
import { encryptions } from "./encryptions.js";

/**
 * Compute the (note_id, packed_value) pair that a counterparty's `transfer` will
 * produce as its `EncNoteCreated` ServerAction.
 *
 * - `channelKey`: the counterparty→me channel key, available from incoming
 *   channel discovery (`registry.cursor.incomingChannels.get(sender).channelKey`).
 * - `token`: the token the counterparty is sending.
 * - `index`: the note index in that subchannel where the new note lands.
 *   Available from `incomingChannels.get(sender).noteIndexes.get(token)`.
 * - `salt`: shared 120-bit value both sides agree on (e.g. `trade_id`).
 * - `amount`: the agreed amount.
 */
export function predictReceivedEncNote(params: {
  channelKey: bigint;
  token: bigint;
  index: number;
  salt: bigint;
  amount: bigint;
}): { note_id: bigint; packed_value: bigint } {
  const { channelKey, token, index, salt, amount } = params;
  const note_id = compute_note_id(channelKey, token, index);
  const packed_value = encryptions.encryptNoteAmount(
    channelKey,
    token,
    index,
    salt,
    amount
  );
  return { note_id, packed_value };
}
