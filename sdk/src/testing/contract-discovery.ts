import { BlockIdentifier } from "starknet";
import { ViewingKey, Note, Channel, StarknetAddressBigint } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { AbstractDiscoveryProvider } from "../internal/abstract-discovery.js";
import { debugLog, hex } from "../utils/logging.js";
import { toBigInt } from "../utils/crypto.js";
import {
  compute_channel_key,
  compute_channel_id,
  compute_subchannel_key,
  compute_note_id,
  compute_outgoing_channel_key,
} from "../utils/hashes.js";
import {
  encryptions,
  type EncChannelInfo,
  type EncSubchannelInfo,
  type EncOutgoingChannelInfo,
} from "../utils/encryptions.js";
import { NotesCursor } from "../internal/channel.js";

/**
 * Interface for pool contract view methods used by ContractDiscoveryProvider.
 * Both MockPoolContract and PrivacyPoolContract satisfy this interface.
 */
export interface IPoolContract {
  get_public_key(userAddr: string): Promise<bigint>;
  get_num_of_channels(recipientAddr: string): Promise<bigint>;
  get_channel_info(recipientAddr: string, index: number): Promise<EncChannelInfo>;
  get_subchannel_info(subchannelKey: string): Promise<EncSubchannelInfo>;
  get_outgoing_channel_info(outgoingChannelKey: string): Promise<EncOutgoingChannelInfo>;
  get_note(noteId: string): Promise<bigint>;
  channel_exists(channelId: string): Promise<boolean>;
  /** Check if a note is an open note (for swap helper deposits) */
  is_note_open?(noteId: string): Promise<boolean>;
}

export class ContractDiscoveryProvider extends AbstractDiscoveryProvider {
  constructor(private readonly pool: IPoolContract) {
    super();
  }

  async discoverNotes(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    params?: { cursor?: NotesCursor; tokens?: StarknetAddressBigint[] }
  ): Promise<{ timestamp: BlockIdentifier; notes: AddressMap<Note[]>; cursor: NotesCursor }> {
    const tokens = new Set([...(params?.tokens ?? [])]);
    const notes = new AddressMap<Note[]>(() => []);
    const cursor: NotesCursor = this.cloneNotesCursor(params?.cursor);
    const addressStr = hex(address);

    // identify channels
    debugLog("contract-discovery", "discoverNotes", "start", cursor);
    const nc = await this.pool.get_num_of_channels(addressStr);
    debugLog("contract-discovery", "discoverNotes", "num of channels", nc);
    let c;
    for (c = cursor.channelKeyIndex ?? 0; c < nc; c++) {
      const encryptedChannel = await this.pool.get_channel_info(addressStr, c);
      const channel = encryptions.decryptChannelInfo(encryptedChannel, viewingKey);
      debugLog("contract-discovery", "discoverNotes", "channel", channel);
      cursor.senders.set(channel.sender, {
        channelKey: channel.key,
        subchannelKeyIndex: 0,
        noteIndexes: new AddressMap<number>(),
      });
    }
    cursor.channelKeyIndex = c;

    // discover subchannels
    debugLog("contract-discovery", "discoverNotes", "senders", cursor.senders);
    for (const [sender, senderCursor] of cursor.senders) {
      const channelKey = senderCursor.channelKey;
      let k: number;
      for (k = senderCursor.subchannelKeyIndex; ; k++) {
        const encSubchannel = await this.pool.get_subchannel_info(
          hex(compute_subchannel_key(channelKey, k))
        );
        if (toBigInt(encSubchannel.salt) === 0n) break;
        debugLog(
          "contract-discovery",
          "discoverNotes",
          "encSubchannel",
          encSubchannel,
          () => compute_subchannel_key(channelKey, k),
          k
        );
        const { token } = encryptions.decryptSubchannelInfo(encSubchannel, channelKey, k);
        // skip tokens the caller doesn't want to discover
        if ((tokens?.size ?? 0) > 0 && !tokens.has(token)) {
          debugLog("contract-discovery", "discoverNotes", "skipping token", token);
          continue;
        }
        debugLog("contract-discovery", "discoverNotes", "subchannel", sender, token, k);
        senderCursor.noteIndexes.set(token, 0);
      }
      senderCursor.subchannelKeyIndex = k;

      // discover notes
      debugLog("contract-discovery", "discoverNotes", "notes", senderCursor.noteIndexes);
      for (const [token, nonce] of senderCursor.noteIndexes) {
        let i;
        for (i = nonce; ; i++) {
          const noteId = compute_note_id(channelKey, token, i);
          const noteIdHex = hex(noteId);
          const encAmount = await this.pool.get_note(noteIdHex);
          if (toBigInt(encAmount) === 0n) break;

          // Check if this is an open note (for swap helper deposits)
          const isOpen = this.pool.is_note_open ? await this.pool.is_note_open(noteIdHex) : false;

          let amount: bigint;
          let salt: bigint;
          if (isOpen) {
            // Open notes store the raw amount, not encrypted
            amount = toBigInt(encAmount);
            salt = 1n; // Open note marker
          } else {
            const decrypted = encryptions.decryptNoteAmount(
              toBigInt(encAmount),
              channelKey,
              token,
              i
            );
            amount = decrypted.amount;
            salt = decrypted.salt;
          }

          debugLog("contract-discovery", "discoverNotes", "note", sender, token, i, amount, isOpen);
          notes.get(token)!.push({
            id: noteId,
            amount,
            created: 0,
            witness: { channelKey, nonce: i, r: salt },
            sender,
            open: isOpen,
          });
        }
        senderCursor.noteIndexes.set(token, i);
      }
    }
    return {
      timestamp: 0,
      notes,
      cursor,
    };
  }

  async discoverChannels(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    _recipients: StarknetAddressBigint[] | "all",
    params?: { cursor?: AddressMap<Channel> }
  ): Promise<{ timestamp: BlockIdentifier; channels: AddressMap<Channel> }> {
    const recipients = _recipients === "all" ? [] : [..._recipients];
    const channels = new AddressMap([...(params?.cursor?.entries() ?? [])]);
    if (_recipients === "all") {
      for (let s = 0; ; s++) {
        const encOutgoingChannelInfo = await this.pool.get_outgoing_channel_info(
          hex(compute_outgoing_channel_key(address, toBigInt(viewingKey), s))
        );
        if (toBigInt(encOutgoingChannelInfo.salt) === 0n) break;
        const { recipientAddr } = encryptions.decryptOutgoingChannelInfo(
          encOutgoingChannelInfo,
          address,
          viewingKey,
          s
        );
        recipients.push(recipientAddr);
      }
    }

    // discover channel
    for (const recipient of recipients) {
      debugLog("contract-discovery", "discoverChannels", "recipient", hex(recipient));
      if (channels.has(recipient) && channels.get(recipient)!.key !== 0n) continue;
      const publicKey =
        channels.get(recipient)?.publicKey ?? (await this.pool.get_public_key(hex(recipient)));
      debugLog("contract-discovery", "discoverChannels", "publicKey", publicKey);
      if (!publicKey) continue;
      const channel = channels.get(recipient, () => new Channel(publicKey))!;
      const channelKey = compute_channel_key(
        address,
        toBigInt(viewingKey),
        recipient,
        toBigInt(publicKey)
      );
      const channelId = compute_channel_id(channelKey, address, recipient, toBigInt(publicKey));

      if (await this.pool.channel_exists(hex(channelId))) {
        channel.key = channelKey;
      }
    }

    // discover subchannels
    for (const [, channel] of channels) {
      if (!channel.key) continue;
      for (let k = channel.tokens.size ?? 0; ; k++) {
        const encSubchannel = await this.pool.get_subchannel_info(
          hex(compute_subchannel_key(channel.key, k))
        );
        if (toBigInt(encSubchannel.salt) === 0n) break;
        const { token } = encryptions.decryptSubchannelInfo(encSubchannel, channel.key, k);
        channel.tokens.set(token, { tokenNonce: k, noteNonce: 0 });
      }

      // discover note indexes
      for (const [token, nonces] of channel.tokens) {
        let i;
        for (i = nonces.noteNonce; ; i++) {
          const encAmount = await this.pool.get_note(hex(compute_note_id(channel.key, token, i)));
          if (toBigInt(encAmount) === 0n) break;
        }
        nonces.noteNonce = i;
      }
    }
    return {
      timestamp: 0,
      channels,
    };
  }
}
