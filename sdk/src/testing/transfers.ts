/**
 * Mock PrivateTransfers implementation for testing.
 */

import type {
  Amount,
  CallAndProof,
  Note,
  NoteId,
  Open,
  PrivateInvocationResult,
  PrivateRecipient,
  PrivateTransfers,
  PrivateTransfersBuilder,
  StarknetAddress,
} from "../interfaces.js";
import { Channel } from "../interfaces.js";
import type { BlockIdentifier } from "starknet";
import type { PrivateKey } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import type { PrivacyPool } from "./pool.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { MockPrivateTransfersBuilder } from "./builders.js";

export class MockPrivateTransfers implements PrivateTransfers {
  private pool: PrivacyPool;
  private _currentBlock: BlockIdentifier = 0;

  // User credentials (set via configure)
  private userAddress: StarknetAddress = "0x0";
  private userPrivateKey: PrivateKey = 0n;
  private discoveryProvider: MockDiscoveryProvider;

  constructor(pool: PrivacyPool, userAddress: StarknetAddress, userPrivateKey: PrivateKey) {
    this.pool = pool;
    this.discoveryProvider = new MockDiscoveryProvider(pool);
    this.userAddress = userAddress;
    this.userPrivateKey = userPrivateKey;
  }

  async isRegistered(): Promise<boolean> {
    return !(
      await this.discoveryProvider.setupRequirement(
        this.userAddress,
        this.userPrivateKey,
        { address: this.userAddress, context: undefined! },
        0x0
      )
    ).register;
  }

  async register(): Promise<CallAndProof> {
    const results = await this.build().register().execute();
    return results[0];
  }

  async setupRequirement(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<{ register: boolean; initial: boolean; token: boolean }> {
    return this.discoveryProvider.setupRequirement(
      this.userAddress,
      this.userPrivateKey,
      recipient,
      token
    );
  }

  async setupInitial(
    recipient: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    const privateRecipient: PrivateRecipient = { address: recipient, context: undefined! };
    const results = await this.build().setup(privateRecipient).execute();
    return { invocationData: results[0], channel: privateRecipient.context };
  }

  async setupToken(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }> {
    const channel = recipient.context;
    const results = await this.build().with(token).setup(recipient).execute();
    return { invocationData: results[0], channel };
  }

  async deposit(params: {
    token: StarknetAddress;
    amount: Amount;
    recipient: PrivateRecipient | NoteId;
  }): Promise<PrivateInvocationResult> {
    const results = await this.build()
      .with(params.token)
      .deposit(params.amount, params.recipient)
      .execute();
    return { invocationData: results[0] };
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

    const results = await builder.execute();
    return { invocationData: results[0] };
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

  build(): PrivateTransfersBuilder {
    return new MockPrivateTransfersBuilder(this.pool, this.userAddress, this.userPrivateKey);
  }

  discoverNotes(params: { since?: BlockIdentifier; known?: AddressMap<Note[]> } = {}): {
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  } {
    return this.discoveryProvider.discoverNotes(this.userAddress, this.userPrivateKey, params);
  }

  discoverChannels(..._recipients: (StarknetAddress | PrivateRecipient)[]): {
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  } {
    return this.discoveryProvider.discoverChannels(
      this.userAddress,
      this.userPrivateKey,
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
