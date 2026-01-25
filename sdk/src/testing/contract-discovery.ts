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
 * Uses bigint for addresses/keys to align with Cairo felts.
 */
export interface IPoolContract {
  get_public_key(userAddr: bigint): bigint | Promise<bigint>;
  get_num_of_channels(recipientAddr: bigint): bigint | Promise<bigint>;
  get_channel_info(recipientAddr: bigint, index: number): EncChannelInfo | Promise<EncChannelInfo>;
  get_subchannel_info(subchannelKey: bigint): EncSubchannelInfo | Promise<EncSubchannelInfo>;
  get_outgoing_channel_info(
    outgoingChannelKey: bigint
  ): EncOutgoingChannelInfo | Promise<EncOutgoingChannelInfo>;
  get_note(noteId: bigint): bigint | Promise<bigint>;
  channel_exists(channelId: bigint): boolean | Promise<boolean>;
  /** Check if a note is an open note (for swap helper deposits) */
  is_note_open?(noteId: bigint): boolean | Promise<boolean>;
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

    // identify channels
    debugLog("contract-discovery", "discoverNotes", "start", cursor);
    const nc = await this.pool.get_num_of_channels(address);
    debugLog("contract-discovery", "discoverNotes", "num of channels", nc);
    let c;
    for (c = cursor.incomingChannelsCount ?? 0; c < nc; c++) {
      const encryptedChannel = await this.pool.get_channel_info(address, c);
      const channel = encryptions.decryptChannelInfo(encryptedChannel, viewingKey);
      debugLog("contract-discovery", "discoverNotes", "channel", channel);
      cursor.incomingChannels.set(channel.sender, {
        channelKey: channel.key,
        subchannelKeyIndex: 0,
        noteIndexes: new AddressMap<number>(),
      });
    }
    cursor.incomingChannelsCount = c;

    // discover subchannels
    debugLog("contract-discovery", "discoverNotes", "incomingChannels", cursor.incomingChannels);
    for (const [sender, incomingChannelCursor] of cursor.incomingChannels) {
      const channelKey = incomingChannelCursor.channelKey;
      let k: number;
      for (k = incomingChannelCursor.subchannelKeyIndex; ; k++) {
        const encSubchannel = await this.pool.get_subchannel_info(
          compute_subchannel_key(channelKey, k)
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
        incomingChannelCursor.noteIndexes.set(token, 0);
      }
      incomingChannelCursor.subchannelKeyIndex = k;

      // discover notes
      debugLog("contract-discovery", "discoverNotes", "notes", incomingChannelCursor.noteIndexes);
      for (const [token, nonce] of incomingChannelCursor.noteIndexes) {
        let i;
        for (i = nonce; ; i++) {
          const noteId = compute_note_id(channelKey, token, i);
          const encAmount = await this.pool.get_note(noteId);
          if (toBigInt(encAmount) === 0n) break;

          // Check if this is an open note (for swap helper deposits)
          const isOpen = this.pool.is_note_open ? await this.pool.is_note_open(noteId) : false;

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
        incomingChannelCursor.noteIndexes.set(token, i);
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
          compute_outgoing_channel_key(address, toBigInt(viewingKey), s)
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
        channels.get(recipient)?.publicKey ?? (await this.pool.get_public_key(recipient));
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

      if (await this.pool.channel_exists(channelId)) {
        channel.key = channelKey;
      }
    }

    // discover subchannels
    for (const [, channel] of channels) {
      if (!channel.key) continue;
      for (let k = channel.tokens.size ?? 0; ; k++) {
        const encSubchannel = await this.pool.get_subchannel_info(
          compute_subchannel_key(channel.key, k)
        );
        if (toBigInt(encSubchannel.salt) === 0n) break;
        const { token } = encryptions.decryptSubchannelInfo(encSubchannel, channel.key, k);
        channel.tokens.set(token, { tokenIndex: k, noteNonce: 0 });
      }

      // discover note indexes
      for (const [token, nonces] of channel.tokens) {
        let i;
        for (i = nonces.noteNonce; ; i++) {
          const encAmount = await this.pool.get_note(compute_note_id(channel.key, token, i));
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
