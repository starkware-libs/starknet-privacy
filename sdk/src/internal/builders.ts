/**
 * Builder implementations for constructing private transfer operations.
 */

import type {
  Amount,
  CallAndProof,
  Channel,
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
import { calculateSurplus } from "../utils/validation.js";
import { createMockCallAndProof } from "../testing/helpers.js";

// ============ Token Operations Builder ============

const isPrivateRecipient = (v: unknown): v is PrivateRecipient =>
  typeof v === "object" && v !== null && "address" in v && "context" in v;

export class TokenOperationsBuilderImpl implements TokenOperationsBuilder {
  // Actions
  public openTokenChannels: OpenTokenChannelAction[] = [];
  public useNotes: UseNoteAction[] = [];
  public deposits: DepositAction[] = [];
  public withdraws: WithdrawAction[] = [];
  public createNotes: CreateNoteAction[] = [];

  // Surplus recipient (overrides parent builder's surplus recipient for this token)
  public surplusRecipient?: PrivateRecipient;

  constructor(
    private parentBuilder: PrivateTransfersBuilderImpl,
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

  surplusTo(recipient: PrivateRecipient | Channel): this {
    this.surplusRecipient = isPrivateRecipient(recipient)
      ? recipient
      : { address: this.parentBuilder.userAddress, context: recipient };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.parentBuilder.with(token);
  }

  done(): PrivateTransfersBuilder {
    return this.parentBuilder;
  }

  async execute(): Promise<CallAndProof> {
    return this.parentBuilder.execute();
  }

  reset(): void {
    this.openTokenChannels = [];
    this.useNotes = [];
    this.deposits = [];
    this.withdraws = [];
    this.createNotes = [];
    this.surplusRecipient = undefined;
  }

  /**
   * Calculate the surplus for this token builder.
   * Returns the surplus amount (inputs - outputs).
   * @throws Error if outputs exceed inputs
   */
  calculateSurplus(): bigint {
    return calculateSurplus(
      this.deposits.map((d) => d.amount),
      this.useNotes.map((u) => u.note.amount),
      this.createNotes.map((c) => c.amount),
      this.withdraws.map((w) => w.amount)
    );
  }
}

// ============ Private Transfers Builder ============

export class PrivateTransfersBuilderImpl implements PrivateTransfersBuilder {
  public setViewingKey?: SetViewingKeyAction;
  public openChannels: OpenChannelAction[] = [];
  public callCalls: Call[] = [];
  public tokenBuilders = new AddressMap<TokenOperationsBuilderImpl>(
    (token) => new TokenOperationsBuilderImpl(this, token)
  );

  // Default surplus recipient for all tokens
  public defaultSurplusRecipient?: PrivateRecipient;

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

  surplusTo(recipient: PrivateRecipient | Channel): this {
    this.defaultSurplusRecipient = isPrivateRecipient(recipient)
      ? recipient
      : { address: this.userAddress, context: recipient };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.tokenBuilders.get(token)!;
  }

  async execute(): Promise<CallAndProof> {
    // 1. Collect all actions from token builders
    const openTokenChannels: OpenTokenChannelAction[] = [];
    const deposits: DepositAction[] = [];
    const useNotes: UseNoteAction[] = [];
    const createNotes: CreateNoteAction[] = [];
    const withdraws: WithdrawAction[] = [];

    for (const [token, tokenBuilder] of this.tokenBuilders.entries()) {
      openTokenChannels.push(...tokenBuilder.openTokenChannels);
      deposits.push(...tokenBuilder.deposits);
      useNotes.push(...tokenBuilder.useNotes);
      createNotes.push(...tokenBuilder.createNotes);
      withdraws.push(...tokenBuilder.withdraws);

      // 2. Handle surplus for this token
      const surplusRecipient = tokenBuilder.surplusRecipient ?? this.defaultSurplusRecipient;
      if (surplusRecipient) {
        const surplus = tokenBuilder.calculateSurplus();
        if (surplus > 0n) {
          // Create a note for the surplus
          createNotes.push({
            token,
            recipient: surplusRecipient.address,
            context: surplusRecipient.context,
            amount: surplus,
          });
        }
      }
    }

    // 3. Execute everything via single pool.execute call
    await this.transfers.execute({
      setViewingKey: this.setViewingKey,
      openChannels: this.openChannels,
      openTokenChannels,
      deposits,
      useNotes,
      createNotes,
      withdraws,
    });

    return createMockCallAndProof();
  }

  reset(): void {
    this.setViewingKey = undefined;
    this.openChannels = [];
    this.callCalls = [];
    this.tokenBuilders.clear();
    this.defaultSurplusRecipient = undefined;
  }
}
