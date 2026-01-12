/**
 * RegistryUpdater - Applies optimistic updates to the registry after pool execution.
 *
 * After executing actions on the pool, the registry needs to be updated to reflect
 * the new state. This is an "optimistic" update because in real-world scenarios,
 * the transaction hasn't been confirmed on-chain yet.
 *
 * Updates:
 * - Channel nonces (tokenNonce from OpenSubchannel, noteNonces from CreateNote)
 * - Removes spent notes (from UseNote actions)
 *
 * Note: Created notes are NOT added to the sender's registry
 * - those notes belong to the recipients.
 *
 * Note: OpenChannel actions don't need handling here - the channel is already in the
 * registry from the compile phase (via discoverChannels) with initial nonces.
 */

import type { PrivateRegistry } from "../interfaces.js";
import { Witness } from "../interfaces.js";
import { NoteNonce } from "./index.js";
import type { ClientAction } from "../client-actions.js";
import { hashes } from "../utils/hashes.js";

/**
 * Apply optimistic updates to the registry after pool execution.
 *
 * @param clientActions - The client actions that were executed
 * @param registry - The registry to update
 */
export function applyOptimisticUpdate(
  clientActions: ClientAction[],
  registry: PrivateRegistry
): void {
  for (const action of clientActions) {
    switch (action.type) {
      case "OpenSubchannel": {
        // Increment token nonce for the channel to this recipient
        const channel = registry.channels.get(action.input.recipientAddr);
        if (channel) {
          channel.incrementTokenNonce();
        }
        break;
      }

      case "CreateNote": {
        // Increment note nonce for the channel/token
        const channel = registry.channels.get(action.input.recipientAddr);
        if (channel) {
          channel.incrementNoteNonce(action.input.token);
        }
        break;
      }

      case "UseNote": {
        // Compute the note ID and remove from registry
        const nonce = new NoteNonce(action.input.noteIndex);
        const witness = new Witness(action.input.channelKey, nonce);
        const noteId = hashes.noteId(witness, action.input.token);

        // Search all tokens for this note and remove it
        for (const [, tokenNotes] of registry.notes.entries()) {
          const index = tokenNotes.findIndex((n) => BigInt(n.id as bigint) === BigInt(noteId));
          if (index !== -1) {
            tokenNotes.splice(index, 1);
            break;
          }
        }
        break;
      }

      // Other action types don't affect the registry optimistically
      default:
        break;
    }
  }
}
