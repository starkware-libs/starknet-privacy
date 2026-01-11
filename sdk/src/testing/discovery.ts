/**
 * Mock DiscoveryProvider implementation for testing.
 */

import type {
  Amount,
  DiscoveryProviderInterface,
  Note,
  PrivateRecipient,
  StarknetAddress,
  StarknetAddressBigint,
  ViewingKey,
} from "../interfaces.js";
import { Channel, SetupRequirement, Witness } from "../interfaces.js";
import type { BlockIdentifier } from "starknet";
import { NoteNonce, TokenNonce } from "../internal/index.js";
import { decryptChannelInfo } from "../utils/crypto.js";
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

      for (let slot = 0; slot < NoteNonce.MAX_SLOTS; slot++) {
        let sequence = 0;
        let token: StarknetAddressBigint | false;
        while ((token = this.pool.getToken(key, new NoteNonce(slot, sequence++))) !== false) {
          for (let noteSlot = 0; noteSlot < NoteNonce.MAX_SLOTS; noteSlot++) {
            let note: { amount: Amount; open: boolean } | false;
            let nonce = new NoteNonce(noteSlot, 0);
            while ((note = this.pool.getNote(new Witness(key, nonce), token)) !== false) {
              if (this.pool.getNullifier(new Witness(key, nonce), token, viewingKey) !== false) {
                nonce = nonce.increment();
                continue;
              }

              result.get(token)!.push({
                id: hashes.noteId(new Witness(key, nonce), token),
                amount: note.amount,
                witness: new Witness(key, nonce),
                sender: channel.sender,
                open: note.open,
              });
              nonce = nonce.increment();
            }
          }
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
    ...recipients: (StarknetAddress | PrivateRecipient)[]
  ): { timestamp: BlockIdentifier; channels: AddressMap<Channel> } {
    assertViewingKey(viewingKey);

    const result = new AddressMap<Channel>();
    for (const recipient of recipients) {
      const addr = assertRecipientAddress(recipient);
      const key = hashes.channelKey(address, viewingKey, addr, this.pool.getPublicKey(addr));
      // TODO: simulate the logarithmic search?
      const nonces: TokenNonce[] = [];
      const tokens = new AddressMap<NoteNonce[]>(() => []);
      for (let slot = 0; slot < TokenNonce.MAX_SLOTS; slot++) {
        let sequence = 0;
        let token: StarknetAddress | false;
        let nonce: TokenNonce;
        while (
          ((nonce = new TokenNonce(slot, sequence++)),
          (token = this.pool.getToken(key, nonce)),
          token !== false)
        ) {
          for (let noteSlot = 0; noteSlot < NoteNonce.MAX_SLOTS; noteSlot++) {
            let noteSequence = 0;
            let nonce: NoteNonce;
            while (
              ((nonce = new NoteNonce(noteSlot, noteSequence++)),
              this.pool.getNote(new Witness(key, nonce), token) !== false)
            ) {
              // just iterate until no note exists
            }
            if (nonce.sequence > 0) {
              tokens.get(token)!.push(nonce.decrement());
            }
          }
        }
        if (nonce.sequence > 0) {
          nonces.push(nonce.decrement());
        }
      }
      result.set(addr, new Channel(key, nonces, tokens));
    }

    return { timestamp: this._currentBlock, channels: result };
  }

  async discoverRequirement(
    address: StarknetAddress,
    viewingKey: ViewingKey,
    recipient: PrivateRecipient,
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
