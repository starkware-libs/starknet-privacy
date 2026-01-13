/**
 * Mock DiscoveryProvider implementation for testing.
 */

import type {
  Amount,
  DiscoveryProviderInterface,
  Note,
  NoteId,
  StarknetAddress,
  StarknetAddressBigint,
  ViewingKey,
} from "../interfaces.js";
import { Channel, SetupRequirement, Witness } from "../interfaces.js";
import type { BlockIdentifier } from "starknet";
import { decryptChannelInfo, toBigInt } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { assertRecipientAddress, assertViewingKey } from "../utils/validation.js";
import type { PrivacyPool } from "./pool.js";
import { hashes } from "../utils/hashes.js";
import { debugLog } from "../utils/logging.js";

export class MockDiscoveryProvider implements DiscoveryProviderInterface {
  private _currentBlock: BlockIdentifier = 0; // TODO: allow block advancement
  constructor(private pool: PrivacyPool) {}

  discoverNotes(
    address: StarknetAddress,
    viewingKey: ViewingKey,
    params: { since?: BlockIdentifier; known?: AddressMap<Note[]>; tokens?: StarknetAddress[] } = {}
  ): { timestamp: BlockIdentifier; notes: AddressMap<Note[]> } {
    // TODO(ittay): Add usage of 'since' and 'known'
    assertViewingKey(viewingKey);

    const result = new AddressMap<Note[]>(() => []);

    const channels = this.pool.getChannels(address);

    debugLog("discovery", "discovering notes address", address);
    for (const encryptedChannel of channels) {
      const channel = decryptChannelInfo(encryptedChannel, viewingKey);
      const key = channel.key;

      // Iterate token sequences
      let tokenSequence = 0;
      let token: StarknetAddressBigint | false;
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
          if (
            this.pool.getNullifier(new Witness(key, nonce, note.r), token, viewingKey) !== false
          ) {
            noteSequence++;
            continue;
          }

          debugLog("discovery", "discovering notes note", note);
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
    address: StarknetAddress,
    viewingKey: ViewingKey,
    ...recipients: StarknetAddress[]
  ): { timestamp: BlockIdentifier; channels: AddressMap<Channel> } {
    assertViewingKey(viewingKey);

    const result = new AddressMap<Channel>();
    for (const recipient of recipients) {
      const addr = assertRecipientAddress(recipient);
      if (!this.pool.isRegistered(addr)) {
        continue;
      }
      const publicKey = toBigInt(this.pool.getPublicKey(addr));
      const key = hashes.channelKey(address, viewingKey, addr, publicKey);

      // Find the highest token nonce sequence
      let tokenSequence = 0;
      let token: StarknetAddress | false;
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

      result.set(addr, new Channel(publicKey, key, tokens.entries()));
    }

    return { timestamp: this._currentBlock, channels: result };
  }

  async discoverRequirement(
    address: StarknetAddress,
    viewingKey: ViewingKey,
    recipient: StarknetAddress,
    token: StarknetAddress
  ): Promise<SetupRequirement> {
    assertViewingKey(viewingKey);
    const addr = assertRecipientAddress(recipient);
    if (!this.pool.isRegistered(addr)) {
      return SetupRequirement.Register;
    }
    const key = hashes.channelKey(address, viewingKey, addr, this.pool.getPublicKey(addr));

    if (!this.pool.doesChannelExist(key, address, addr)) {
      return SetupRequirement.SetupChannel;
    }
    if (!this.pool.doesSubchannelExist(key, addr, token)) {
      return SetupRequirement.SetupToken;
    }
    return SetupRequirement.Ready;
  }
}
