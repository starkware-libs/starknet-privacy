/**
 * Mock DiscoveryProvider implementation for testing.
 */

import type {
  Amount,
  DiscoveryProviderInterface,
  Note,
  NoteId,
  ViewingKey,
} from "../interfaces.js";
import { Channel, SetupRequirement, Witness } from "../interfaces.js";
import { TokenChannel } from "../internal/channel.js";
import type { BlockIdentifier } from "starknet";
import { decryptChannelInfo } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { assertViewingKey } from "../utils/validation.js";
import type { PrivacyPool } from "./pool.js";
import { hashes } from "../utils/hashes.js";
import { debugLog } from "../utils/logging.js";

export class MockDiscoveryProvider implements DiscoveryProviderInterface {
  private _currentBlock: BlockIdentifier = 0; // TODO: allow block advancement
  constructor(private pool: PrivacyPool) {}

  discoverNotes(
    address: bigint,
    viewingKey: ViewingKey,
    params: { since?: BlockIdentifier; known?: AddressMap<Note[]>; tokens?: bigint[] } = {}
  ): { timestamp: BlockIdentifier; notes: AddressMap<Note[]> } {
    // TODO(ittay): Add usage of 'since' and 'known'
    assertViewingKey(viewingKey);

    const result = new AddressMap<Note[]>(() => []);

    const channels = this.pool.getChannels(address);

    debugLog("discovery", "discovering notes address", address, "channelCount:", channels.length);
    for (const encryptedChannel of channels) {
      const channel = decryptChannelInfo(encryptedChannel, viewingKey);
      debugLog("discovery", "processing channel key:", channel.key, "sender:", channel.sender);
      const key = channel.key;

      // Iterate token sequences
      let tokenSequence = 0;
      let token: bigint | false;
      while ((token = this.pool.getToken(key, tokenSequence++)) !== false) {
        if (params.tokens && !params.tokens.includes(token)) {
          continue;
        }
        debugLog("discovery", "discovering notes token", token, tokenSequence - 1);
        // Iterate note sequences for this token
        let noteSequence = 0;
        let note: { id: NoteId; amount: Amount; r: bigint; open: boolean } | false; // TODO: add explicit type name
        while ((note = this.pool.getNote(key, noteSequence, token)) !== false) {
          //TODO: cleanup
          const nonce = noteSequence;
          const nullifierResult = this.pool.getNullifier(
            new Witness(key, nonce, note.r),
            token,
            viewingKey
          );
          debugLog("discovery", "checking nullifier", { nonce, noteId: note.id, nullifierResult });
          if (nullifierResult !== false) {
            debugLog("discovery", "skipping nullified note", { nonce, noteId: note.id });
            noteSequence++;
            continue;
          }

          debugLog("discovery", "discovering notes note", {
            token,
            nonce,
            noteId: note.id,
            amount: note.amount,
          });
          result.get(token)!.push({
            id: note.id,
            amount: note.amount,
            witness: new Witness(key, nonce, note.r),
            sender: channel.sender,
            open: note.open,
          });
          noteSequence++;
        }
      }
    }

    return {
      timestamp: this._currentBlock,
      notes: result,
    };
  }

  discoverChannels(
    address: bigint,
    viewingKey: ViewingKey,
    ...recipients: bigint[]
  ): { timestamp: BlockIdentifier; channels: AddressMap<Channel> } {
    assertViewingKey(viewingKey);

    const result = new AddressMap<Channel>();
    for (const recipient of recipients) {
      if (!this.pool.isRegistered(recipient)) {
        continue;
      }
      const publicKey = this.pool.getPublicKey(recipient);
      const key = hashes.channelKey(address, viewingKey, recipient, publicKey);
      if (!this.pool.doesChannelExist(key, address, recipient)) {
        result.set(recipient, new Channel(publicKey));
        continue;
      }

      // Find the highest token nonce sequence
      let tokenSequence = 0;
      let token: bigint | false;
      const tokens = new AddressMap<TokenChannel>();

      while ((token = this.pool.getToken(key, tokenSequence)) !== false) {
        // Find the highest note nonce sequence for this token
        let noteSequence = 0;
        while (this.pool.getNote(key, noteSequence, token) !== false) {
          noteSequence++;
        }
        tokens.set(token, {
          tokenIndex: tokenSequence,
          noteNonce: noteSequence,
        });
        tokenSequence++;
      }

      result.set(recipient, new Channel(publicKey, key, tokens.entries()));
    }

    return { timestamp: this._currentBlock, channels: result };
  }

  async discoverRequirement(
    address: bigint,
    viewingKey: ViewingKey,
    recipient: bigint,
    token: bigint
  ): Promise<SetupRequirement> {
    assertViewingKey(viewingKey);
    if (!this.pool.isRegistered(recipient)) {
      return SetupRequirement.Register;
    }
    const key = hashes.channelKey(
      address,
      viewingKey,
      recipient,
      this.pool.getPublicKey(recipient)
    );

    if (!this.pool.doesChannelExist(key, address, recipient)) {
      return SetupRequirement.SetupChannel;
    }
    if (!this.pool.doesSubchannelExist(key, recipient, token)) {
      return SetupRequirement.SetupToken;
    }
    return SetupRequirement.Ready;
  }
}
