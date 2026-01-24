import { BlockIdentifier } from "starknet";
import { ViewingKey, Note, Channel, StarknetAddressBigint } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { AbstractDiscoveryProvider } from "../internal/abstract-discovery.js";
import { PrivacyPoolContract } from "../internal/private-transfers.js";
import { debugLog, hex } from "../utils/logging.js";
import { toBigInt } from "../utils/crypto.js";
import {
  compute_channel_key,
  compute_channel_id,
  compute_subchannel_key,
  compute_note_id,
  compute_outgoing_channel_key,
} from "../utils/hashes.js";
import { encryptions } from "../utils/encryptions.js";
import { NotesCursor } from "../internal/channel.js";

export class ContractDiscoveryProvider extends AbstractDiscoveryProvider {
  constructor(private readonly pool: PrivacyPoolContract) {
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
        if ((tokens?.size ?? 0) > 0 && !tokens.has(token)) continue;
        debugLog("contract-discovery", "discoverNotes", "subchannel", sender, token, k);
        senderCursor.noteIndexes.set(token, 0);
      }
      senderCursor.subchannelKeyIndex = k;

      // discover notes
      debugLog("contract-discovery", "discoverNotes", "notes", senderCursor.noteIndexes);
      for (const [token, nonce] of senderCursor.noteIndexes) {
        let i;
        for (i = nonce; ; i++) {
          const encAmount = await this.pool.get_note(compute_note_id(channelKey, token, i));
          if (toBigInt(encAmount) === 0n) break;
          const { amount, salt } = encryptions.decryptNoteAmount(
            toBigInt(encAmount),
            channelKey,
            token,
            i
          );
          debugLog("contract-discovery", "discoverNotes", "note", sender, token, i, amount);
          notes.get(token)!.push({
            id: compute_note_id(channelKey, token, i),
            amount,
            created: 0,
            witness: { channelKey, nonce: i, r: salt },
            sender,
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
        channel.tokens.set(token, { tokenNonce: k, noteNonce: 0 });
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
