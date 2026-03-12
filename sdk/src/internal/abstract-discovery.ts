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
import type { ChannelCursor, NotesCursor } from "./channel.js";

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
    recipients: StarknetAddressBigint[] | undefined,
    params?: { cursor?: ChannelCursor }
  ): Promise<{
    timestamp: BlockIdentifier;
    channels?: AddressMap<Channel>;
    total?: number;
    cursor: ChannelCursor;
  }>;

  // Default implementation provided by the abstract class
  async discoverRequirement(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    recipient: StarknetAddressBigint,
    token: StarknetAddressBigint
  ): Promise<SetupRequirement> {
    const { channels } = await this.discoverChannels(address, viewingKey, [recipient]);
    const channel = channels?.get(recipient);
    return channel?.toSetupRequirement(token) ?? SetupRequirement.Register;
  }
}
