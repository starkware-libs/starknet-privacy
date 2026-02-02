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
    for (c = cursor.incomingChannelsCount ?? 0; c < nc; c++) {
      const encryptedChannel = await this.pool.get_channel_info(addressStr, c);
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
          const noteData = await this.pool.get_note(noteId);
          const packedValue = toBigInt(noteData.packed_value);
          if (packedValue === 0n) break;

          // Extract salt from upper 128 bits to determine note type
          // OPEN_NOTE_SALT = 1, ENC_NOTE_MIN_SALT = 2
          const packedSalt = packedValue >> 128n;
          const isOpenNote = packedSalt === 1n;

          let amount: bigint;
          let salt: bigint;

          if (isOpenNote) {
            // Open notes: amount is in lower 128 bits (plaintext), salt is always 1
            amount = packedValue & ((1n << 128n) - 1n);
            salt = 1n;
          } else {
            // Encrypted notes: decrypt to get amount and salt
            const decrypted = encryptions.decryptNoteAmount(packedValue, channelKey, token, i);
            amount = decrypted.amount;
            salt = decrypted.salt;
          }

          debugLog(
            "contract-discovery",
            "discoverNotes",
            "note",
            sender,
            token,
            i,
            amount,
            isOpenNote ? "open" : "encrypted"
          );
          notes.get(token)!.push({
            id: noteId,
            amount,
            created: 0,
            witness: { channelKey, nonce: i, r: salt },
            sender,
            open: isOpenNote,
            depositor: isOpenNote ? toBigInt(noteData.depositor) : undefined,
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
        channel.tokens.set(token, { tokenIndex: k, noteNonce: 0 });
      }

      // discover note indexes
      for (const [token, nonces] of channel.tokens) {
        let i;
        for (i = nonces.noteNonce; ; i++) {
          const noteData = await this.pool.get_note(compute_note_id(channel.key, token, i));
          if (toBigInt(noteData.packed_value) === 0n) break;
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
