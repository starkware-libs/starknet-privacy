/**
 * RegistryUpdater - Applies optimistic updates to the registry after pool execution.
 *
 * After executing actions on the pool, the registry needs to be updated to reflect
 * the new state. This is an "optimistic" update because in real-world scenarios,
 * the transaction hasn't been confirmed on-chain yet.
 *
 * Updates:
 * - Channel nonces (tokenNonce from openTokenChannels, noteNonces from deposits/createNotes)
 * - Removes spent notes (from useNotes actions)
 *
 * Note: Created notes (from deposits/createNotes) are NOT added to the sender's registry
 * - those notes belong to the recipients.
 *
 * Note: openChannels actions don't need handling here - the channel is already in the
 * registry from the compile phase (via discoverChannels) with initial nonces.
 */

import type { Actions, PrivateRegistry } from "../interfaces.js";

/**
 * Apply optimistic updates to the registry after pool execution.
 *
 * @param actions - The compiled actions that were executed
 * @param registry - The registry to update
 */
export function applyOptimisticUpdate(actions: Actions, registry: PrivateRegistry): void {
  // 1. Update channel token nonces (from openTokenChannels)
  if (actions.openTokenChannels) {
    for (const action of actions.openTokenChannels) {
      const channel = registry.channels.get(action.recipient);
      if (channel) {
        channel.incrementTokenNonce();
      }
    }
  }

  // 2. Update channel note nonces (from deposits and createNotes)
  if (actions.deposits) {
    for (const action of actions.deposits) {
      if ("recipient" in action) {
        const channel = registry.channels.get(action.recipient);
        if (channel) {
          channel.incrementNoteNonce(action.token);
        }
      }
    }
  }

  if (actions.createNotes) {
    for (const action of actions.createNotes) {
      const channel = registry.channels.get(action.recipient);
      if (channel) {
        channel.incrementNoteNonce(action.token);
      }
    }
  }

  // 3. Remove spent notes
  if (actions.useNotes) {
    for (const action of actions.useNotes) {
      const noteId = action.note.id;
      // Search all tokens for this note
      for (const [, tokenNotes] of registry.notes.entries()) {
        const index = tokenNotes.findIndex(
          (n) => BigInt(n.id as bigint) === BigInt(noteId as bigint)
        );
        if (index !== -1) {
          tokenNotes.splice(index, 1);
          break;
        }
      }
    }
  }
}
