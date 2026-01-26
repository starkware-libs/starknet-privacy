import type { BlockIdentifier } from "starknet";
import type {
  Channel,
  DiscoveryProviderInterface,
  Note,
  StarknetAddressBigint,
  ViewingKey,
} from "../interfaces.js";
import { SetupRequirement } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { NotesCursor, IncomingChannelCursor } from "./channel.js";

export abstract class AbstractDiscoveryProvider implements DiscoveryProviderInterface {
  // Abstract methods that subclasses must implement
  abstract discoverNotes(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    params?: {
      since?: BlockIdentifier;
      known?: AddressMap<Note[]>;
      tokens?: StarknetAddressBigint[];
    }
  ): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
    cursor: NotesCursor;
  }>;

  abstract discoverChannels(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    recipients: StarknetAddressBigint[] | "all",
    params?: { cursor?: AddressMap<Channel> }
  ): Promise<{ timestamp: BlockIdentifier; channels: AddressMap<Channel> }>;

  // Default implementation provided by the abstract class
  async discoverRequirement(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    recipient: StarknetAddressBigint,
    token: StarknetAddressBigint
  ): Promise<SetupRequirement> {
    const { channels } = await this.discoverChannels(address, viewingKey, [recipient]);
    const channel = channels.get(recipient);
    return channel?.toSetupRequirement(token) ?? SetupRequirement.Register;
  }

  protected cloneNotesCursor(cursor?: NotesCursor): NotesCursor {
    if (!cursor) {
      return {
        blockId: 0,
        incomingChannelsCount: 0,
        incomingChannels: new AddressMap<IncomingChannelCursor>(),
      };
    }

    const cloneIncomingChannelCursor = (sc: IncomingChannelCursor): IncomingChannelCursor => ({
      channelKey: sc.channelKey,
      subchannelKeyIndex: sc.subchannelKeyIndex,
      noteIndexes: new AddressMap<number>(sc.noteIndexes.entries()),
    });

    const incomingChannels = new AddressMap<IncomingChannelCursor>(
      [...cursor.incomingChannels.entries()].map(
        ([k, v]): [StarknetAddressBigint, IncomingChannelCursor] => [
          k,
          cloneIncomingChannelCursor(v),
        ]
      )
    );
    return {
      blockId: cursor.blockId,
      incomingChannelsCount: cursor.incomingChannelsCount,
      incomingChannels: incomingChannels,
    };
  }
}
