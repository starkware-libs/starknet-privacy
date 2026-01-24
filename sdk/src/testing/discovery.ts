/**
 * Mock DiscoveryProvider implementation for testing.
 */

import type { Amount, Note, NoteId, StarknetAddressBigint, ViewingKey } from "../interfaces.js";
import { Channel, Witness } from "../interfaces.js";
import type { BlockIdentifier } from "starknet";
import { encryptions } from "../utils/encryptions.js";
import { AddressMap } from "../utils/maps.js";
import { assertViewingKey } from "../utils/validation.js";
import type { PrivacyPool } from "./pool.js";
import { compute_channel_key, compute_outgoing_channel_key } from "../utils/hashes.js";
import { toBigInt } from "../utils/crypto.js";
import { debugLog } from "../utils/logging.js";
import { AbstractDiscoveryProvider } from "../internal/abstract-discovery.js";
import { NotesCursor, SenderCursor } from "../internal/channel.js";

export class MockDiscoveryProvider extends AbstractDiscoveryProvider {
  private _currentBlock: BlockIdentifier = 0; // TODO: allow block advancement
  constructor(private pool: PrivacyPool) {
    super();
  }

  async discoverNotes(
    address: bigint,
    viewingKey: ViewingKey,
    params: { since?: BlockIdentifier; cursor?: NotesCursor; tokens?: bigint[] } = {}
  ): Promise<{ timestamp: BlockIdentifier; notes: AddressMap<Note[]>; cursor: NotesCursor }> {
    assertViewingKey(viewingKey);

    const result = new AddressMap<Note[]>(() => []);

    const channels = this.pool.getChannels(address);

    debugLog("discovery", "discovering notes address", address, "channelCount:", channels.length);
    for (const encryptedChannel of channels) {
      const channel = encryptions.decryptChannelInfo(encryptedChannel, toBigInt(viewingKey));
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
      cursor: {
        timestamp: this._currentBlock,
        channelKeyIndex: 0,
        senders: new AddressMap<SenderCursor>(),
      },
    };
  }

  async discoverChannels(
    address: bigint,
    viewingKey: ViewingKey,
    recipients: StarknetAddressBigint[] | "all",
    _params?: { cursor?: AddressMap<Channel> }
  ): Promise<{ timestamp: BlockIdentifier; channels: AddressMap<Channel> }> {
    assertViewingKey(viewingKey);

    // If "all", discover recipients from outgoing channels
    let recipientList: StarknetAddressBigint[];
    if (recipients === "all") {
      recipientList = [];
      for (let s = 0; ; s++) {
        const outgoingChannelKey = compute_outgoing_channel_key(address, toBigInt(viewingKey), s);
        const encOutgoingChannelInfo = this.pool.getOutgoingChannelInfo(outgoingChannelKey);
        if (!encOutgoingChannelInfo) break;
        const { recipientAddr } = encryptions.decryptOutgoingChannelInfo(
          encOutgoingChannelInfo,
          address,
          viewingKey,
          s
        );
        recipientList.push(recipientAddr);
      }
    } else {
      recipientList = recipients;
    }

    const result = new AddressMap<Channel>();
    for (const recipient of recipientList) {
      if (!this.pool.isRegistered(recipient)) {
        continue;
      }
      const publicKey = this.pool.getPublicKey(recipient);
      const key = compute_channel_key(
        address,
        toBigInt(viewingKey),
        recipient,
        toBigInt(publicKey)
      );
      if (!this.pool.doesChannelExist(key, address, recipient)) {
        result.set(recipient, new Channel(publicKey));
        continue;
      }

      // Find the highest token nonce sequence
      let tokenSequence = 0;
      let token: bigint | false;
      const tokens = new AddressMap<{ tokenNonce: number; noteNonce: number }>();

      while ((token = this.pool.getToken(key, tokenSequence)) !== false) {
        // Find the highest note nonce sequence for this token
        let noteSequence = 0;
        while (this.pool.getNote(key, noteSequence, token) !== false) {
          noteSequence++;
        }
        tokens.set(token, {
          tokenNonce: tokenSequence,
          noteNonce: noteSequence,
        });
        tokenSequence++;
      }

      result.set(recipient, new Channel(publicKey, key, tokens.entries()));
    }

    return { timestamp: this._currentBlock, channels: result };
  }
}
