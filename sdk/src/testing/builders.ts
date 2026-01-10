/**
 * Mock builder implementations for testing.
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
  PrivateRecipient,
  PrivateTransfers,
  PrivateTransfersBuilder,
  SetViewingKeyAction,
  StarknetAddress,
  TokenOperationsBuilder,
  UseNoteAction,
  WithdrawAction,
} from "../interfaces.js";
import type { Call } from "starknet";
import { AddressMap } from "../utils/maps.js";
import { createMockCallAndProof } from "./helpers.js";

// ============ Mock Token Operations Builder ============

const isPrivateRecipient = (v: unknown): v is PrivateRecipient =>
  typeof v === "object" && v !== null && "address" in v && "context" in v;

export class MockTokenOperationsBuilder implements TokenOperationsBuilder {
  // Actions
  public openTokenChannels: OpenTokenChannelAction[] = [];
  public useNotes: UseNoteAction[] = [];
  public deposits: DepositAction[] = [];
  public withdraws: WithdrawAction[] = [];
  public createNotes: CreateNoteAction[] = [];

  constructor(
    private parentBuilder: MockPrivateTransfersBuilder,
    public readonly token: StarknetAddress
  ) {}

  setup(recipient: PrivateRecipient): this {
    // Use getter for lazy context access (context is populated during execute)
    this.openTokenChannels.push({
      recipient: recipient.address,
      get context() {
        return recipient.context;
      },
      token: this.token,
    });
    return this;
  }

  inputs(...notes: Note[]): this {
    for (const note of notes) {
      this.useNotes.push({ token: this.token, note });
    }
    return this;
  }

  deposit(amount: Amount, recipient: PrivateRecipient | NoteId): this {
    if (isPrivateRecipient(recipient)) {
      // Use getter for lazy context access (context is populated during execute)
      this.deposits.push({
        token: this.token,
        amount,
        recipient: recipient.address,
        get context() {
          return recipient.context;
        },
      });
    } else {
      // NoteId - no context needed
      this.deposits.push({ token: this.token, amount, recipient });
    }
    return this;
  }

  withdraw(...outputs: Array<{ recipient?: StarknetAddress; amount: Amount }>): this {
    for (const output of outputs) {
      this.withdraws.push({
        token: this.token,
        recipient: output.recipient ?? this.parentBuilder.userAddress,
        amount: output.amount,
      });
    }
    return this;
  }

  transfer(...outputs: Array<{ recipient: PrivateRecipient; amount: Amount | Open }>): this {
    for (const output of outputs) {
      const recipient = output.recipient;
      // Use getter for lazy context access (context is populated during execute)
      this.createNotes.push({
        token: this.token,
        recipient: recipient.address,
        get context() {
          return recipient.context;
        },
        amount: output.amount,
      });
    }
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.parentBuilder.with(token);
  }

  done(): PrivateTransfersBuilder {
    return this.parentBuilder;
  }

  async execute(): Promise<CallAndProof[]> {
    return this.parentBuilder.execute();
  }

  reset(): void {
    this.openTokenChannels = [];
    this.useNotes = [];
    this.deposits = [];
    this.withdraws = [];
    this.createNotes = [];
  }
}

// ============ Mock Private Transfers Builder ============

export class MockPrivateTransfersBuilder implements PrivateTransfersBuilder {
  public setViewingKey?: SetViewingKeyAction;
  public openChannels: OpenChannelAction[] = [];
  public callCalls: Call[] = [];
  public tokenBuilders = new AddressMap<MockTokenOperationsBuilder>(
    (token) => new MockTokenOperationsBuilder(this, token)
  );

  constructor(
    private transfers: PrivateTransfers,
    public readonly userAddress: StarknetAddress
  ) {}

  register(): this {
    this.setViewingKey = {};
    return this;
  }

  setup(recipient: StarknetAddress): this {
    this.openChannels.push({ recipient });
    return this;
  }

  call(call: Call): this {
    this.callCalls.push(call);
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.tokenBuilders.get(token)!;
  }

  async execute(): Promise<CallAndProof[]> {
    // 1. Collect all actions from token builders
    const openTokenChannels: OpenTokenChannelAction[] = [];
    const deposits: DepositAction[] = [];
    const useNotes: UseNoteAction[] = [];
    const createNotes: CreateNoteAction[] = [];
    const withdraws: WithdrawAction[] = [];

    for (const tokenBuilder of this.tokenBuilders.values()) {
      openTokenChannels.push(...tokenBuilder.openTokenChannels);
      deposits.push(...tokenBuilder.deposits);
      useNotes.push(...tokenBuilder.useNotes);
      createNotes.push(...tokenBuilder.createNotes);
      withdraws.push(...tokenBuilder.withdraws);
    }

    // 4. Execute everything via single pool.execute call
    await this.transfers.execute({
      setViewingKey: this.setViewingKey,
      openChannels: this.openChannels,
      openTokenChannels,
      deposits,
      useNotes,
      createNotes,
      withdraws,
    });

    return [createMockCallAndProof()];
  }

  reset(): void {
    this.setViewingKey = undefined;
    this.openChannels = [];
    this.callCalls = [];
    this.tokenBuilders.clear();
  }
}
