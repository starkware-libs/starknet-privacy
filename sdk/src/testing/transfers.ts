/**
 * Mock PrivateTransfers implementation for testing.
 */

import type {
  Amount,
  CallAndProof,
  CreateNoteAction,
  DepositAction,
  Note,
  NoteId,
  Open,
  OpenChannelAction,
  OpenTokenChannelAction,
  PrivateInvocationResult,
  PrivateRecipient,
  PrivateTransfers,
  PrivateTransfersBuilder,
  SetViewingKeyAction,
  StarknetAddress,
  UseNoteAction,
  WithdrawAction,
} from "../interfaces.js";
import { Channel, SetupRequirement } from "../interfaces.js";
import type { BlockIdentifier } from "starknet";
import type { PrivateKey } from "../utils/crypto.js";
import { hashes } from "../utils/hashes.js";
import { AddressMap } from "../utils/maps.js";
import { createMockCallAndProof } from "./helpers.js";
import type { PrivacyPool } from "./pool.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { PrivateTransfersBuilderImpl } from "../internal/builders.js";

export class MockPrivateTransfers implements PrivateTransfers {
  private pool: PrivacyPool;
  private _currentBlock: BlockIdentifier = 0;

  // User credentials (set via configure)
  private userAddress: StarknetAddress = "0x0";
  private userViewingKey: PrivateKey = 0n;
  private discoveryProvider: MockDiscoveryProvider;

  constructor(pool: PrivacyPool, userAddress: StarknetAddress, userPrivateKey: PrivateKey) {
    this.pool = pool;
    this.discoveryProvider = new MockDiscoveryProvider(pool);
    this.userAddress = userAddress;
    this.userViewingKey = userPrivateKey;
  }

  async discoverRequirement(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<SetupRequirement> {
    return this.discoveryProvider.discoverRequirement(
      this.userAddress,
      this.userViewingKey,
      recipient,
      token
    );
  }

  async register(): Promise<CallAndProof> {
    return this.build().register().execute();
  }

  async setupChannel(
    recipient: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    const invocationData = await this.build().setup(recipient).execute();
    // Compute the channel key
    const recipientPublicKey = this.pool.getPublicKey(recipient);
    const channelKey = hashes.channelKey(
      this.userAddress,
      this.userViewingKey,
      recipient,
      recipientPublicKey
    );
    return { invocationData, channel: new Channel(channelKey) };
  }

  async setupToken(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    const channel = recipient.context;
    const invocationData = await this.build().with(token).setup(recipient).execute();
    return { invocationData, channel };
  }

  async deposit(params: {
    token: StarknetAddress;
    amount: Amount;
    recipient: PrivateRecipient | NoteId;
  }): Promise<PrivateInvocationResult> {
    const invocationData = await this.build()
      .with(params.token)
      .deposit(params.amount, params.recipient)
      .execute();
    return { invocationData };
  }

  private async withdrawOrTransfer(params: {
    token: StarknetAddress;
    inputs: Note[];
    recipientAddress?: StarknetAddress;
    recipientPrivate?: PrivateRecipient;
    amount?: Amount;
    selfChannel?: Channel;
    isWithdraw: boolean;
  }): Promise<PrivateInvocationResult> {
    const builder = this.build()
      .with(params.token)
      .inputs(...params.inputs);

    // Compute amount and handle change
    const availableAmount = this.availableAmount(params.inputs);
    const amount = params.amount ?? availableAmount;

    // Add main output (withdraw or transfer)
    if (params.isWithdraw) {
      builder.withdraw({ recipient: params.recipientAddress, amount });
    } else {
      builder.transfer({ recipient: params.recipientPrivate!, amount });
    }

    // If there's change, transfer it back to self
    if (amount < availableAmount && params.selfChannel) {
      builder.transfer({
        recipient: { address: this.userAddress, context: params.selfChannel },
        amount: availableAmount - amount,
      });
    }

    const invocationData = await builder.execute();
    return { invocationData };
  }

  async withdraw(params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient?: StarknetAddress;
    amount?: Amount;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult> {
    return this.withdrawOrTransfer({
      token: params.token,
      inputs: params.inputs,
      recipientAddress: params.recipient,
      amount: params.amount,
      selfChannel: params.selfChannel,
      isWithdraw: true,
    });
  }

  async transfer(params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient: PrivateRecipient;
    amount?: Amount | Open;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult> {
    return this.withdrawOrTransfer({
      token: params.token,
      inputs: params.inputs,
      recipientPrivate: params.recipient,
      amount: params.amount as Amount | undefined,
      selfChannel: params.selfChannel,
      isWithdraw: false,
    });
  }

  async execute(actions: {
    setViewingKey?: SetViewingKeyAction;
    openChannels?: OpenChannelAction[];
    openTokenChannels?: OpenTokenChannelAction[];
    deposits?: DepositAction[];
    useNotes?: UseNoteAction[];
    createNotes?: CreateNoteAction[];
    withdraws?: WithdrawAction[];
  }): Promise<CallAndProof> {
    this.pool.execute(this.userAddress, this.userViewingKey, actions);
    return createMockCallAndProof();
  }

  build(): PrivateTransfersBuilder {
    return new PrivateTransfersBuilderImpl(this, this.userAddress);
  }

  discoverNotes(params: { since?: BlockIdentifier; known?: AddressMap<Note[]> } = {}): {
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  } {
    return this.discoveryProvider.discoverNotes(this.userAddress, this.userViewingKey, params);
  }

  discoverChannels(..._recipients: (StarknetAddress | PrivateRecipient)[]): {
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  } {
    return this.discoveryProvider.discoverChannels(
      this.userAddress,
      this.userViewingKey,
      ..._recipients
    );
  }

  /** Access the underlying PrivacyPool for advanced testing */
  getPool(): PrivacyPool {
    return this.pool;
  }

  availableAmount(inputs: Note[]): bigint {
    return inputs.reduce((acc, input) => acc + input.amount, 0n);
  }
}
