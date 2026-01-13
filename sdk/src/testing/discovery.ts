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
import { NoteNonce, TokenNonce } from "../internal/index.js";
import { decryptChannelInfo, toBigInt } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { assertRecipientAddress, assertViewingKey } from "../utils/validation.js";
import type { PrivacyPool } from "./pool.js";
import { hashes } from "../utils/hashes.js";

export class MockDiscoveryProvider implements DiscoveryProviderInterface {
  private _currentBlock: BlockIdentifier = 0; // TODO: allow block advancement
  constructor(private pool: PrivacyPool) {}

  discoverNotes(
    address: StarknetAddress,
    viewingKey: ViewingKey,
    _params: { since?: BlockIdentifier; known?: AddressMap<Note[]> } = {}
  ): { timestamp: BlockIdentifier; notes: AddressMap<Note[]> } {
    // TODO(ittay): Add usage of 'since' and 'known'
    assertViewingKey(viewingKey);

    const result = new AddressMap<Note[]>(() => []);

    const channels = this.pool.getChannels(address);

    for (const encryptedChannel of channels) {
      const channel = decryptChannelInfo(encryptedChannel, viewingKey);
      const key = channel.key;

      // Iterate token sequences
      let tokenSequence = 0;
      let token: StarknetAddressBigint | false;
      while ((token = this.pool.getToken(key, new NoteNonce(tokenSequence++))) !== false) {
        // Iterate note sequences for this token
        let noteSequence = 0;
        let note: { id: NoteId; amount: Amount; open: boolean } | false;
        while (
          (note = this.pool.getNote(new Witness(key, new NoteNonce(noteSequence)), token)) !== false
        ) {
          const nonce = new NoteNonce(noteSequence);
          if (this.pool.getNullifier(new Witness(key, nonce), token, viewingKey) !== false) {
            noteSequence++;
            continue;
          }

          result.get(token)!.push({
            id: note.id,
            amount: note.amount,
            witness: new Witness(key, nonce),
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
      const recipientPublicKey = toBigInt(this.pool.getPublicKey(addr));
      const key = hashes.channelKey(address, viewingKey, addr, recipientPublicKey);

      // Find the highest token nonce sequence
      let tokenSequence = 0;
      let token: StarknetAddress | false;
      const tokens = new AddressMap<NoteNonce>();

      while ((token = this.pool.getToken(key, new TokenNonce(tokenSequence))) !== false) {
        // Find the highest note nonce sequence for this token
        let noteSequence = 0;
        while (this.pool.getNote(new Witness(key, new NoteNonce(noteSequence)), token) !== false) {
          noteSequence++;
        }
        tokens.set(token, new NoteNonce(noteSequence));
        tokenSequence++;
      }

      const tokenNonce = new TokenNonce(tokenSequence);
      result.set(addr, new Channel(key, recipientPublicKey, tokenNonce, tokens));
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
