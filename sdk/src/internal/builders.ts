/**
 * Builder implementations for constructing private transfer operations.
 */

import type {
  Amount,
  Channel,
  CreateNoteAction,
  DepositAction,
  ExecuteOptions,
  ExecuteResult,
  Note,
  OpenChannelAction,
  OpenTokenChannelAction,
  PrivateTransfers,
  PrivateTransfersBuilder,
  Actions,
  SetViewingKeyAction,
  StarknetAddress,
  TokenOperationsBuilder,
  UseNoteAction,
  WithdrawAction,
  WithdrawOutput,
  DepositInput,
  TransferOutput,
} from "../interfaces.js";
import type { Call } from "starknet";
import { AddressMap } from "../utils/maps.js";
import { isOpen } from "../utils/validation.js";

// ============ Internal Types ============

/** Internal representation of surplus recipient */
type SurplusRecipient = {
  address: StarknetAddress;
  channel?: Channel;
};

const isChannel = (v: unknown): v is Channel => typeof v === "object" && v !== null && "key" in v;

// ============ Token Operations Builder ============

export class TokenOperationsBuilderImpl implements TokenOperationsBuilder {
  // Actions stored without context - context resolved during execute
  public openTokenChannels: OpenTokenChannelAction[] = [];
  public useNotes: UseNoteAction[] = [];
  public deposits: DepositAction[] = [];
  public createNotes: CreateNoteAction[] = [];
  public withdraws: WithdrawAction[] = [];
  public hasExplicitInputs = false;

  // Surplus recipient (overrides parent builder's surplus recipient for this token)
  public surplusRecipient?: SurplusRecipient;

  constructor(
    private parentBuilder: PrivateTransfersBuilderImpl,
    public readonly token: StarknetAddress
  ) {}

  setup(recipient: StarknetAddress): this {
    this.openTokenChannels.push({ recipient, token: this.token });
    return this;
  }

  inputs(...notes: Note[]): this {
    this.hasExplicitInputs = true;
    for (const note of notes) {
      this.useNotes.push({ token: this.token, note });
    }
    return this;
  }

  deposit(...inputs: DepositInput[]): this {
    for (const input of inputs) {
      if ("noteId" in input) {
        this.deposits.push({ token: this.token, amount: input.amount, noteId: input.noteId });
      } else {
        this.deposits.push({ token: this.token, amount: input.amount });
        this.createNotes.push({
          token: this.token,
          recipient: input.recipient ?? this.parentBuilder.userAddress,
          amount: input.amount,
        });
      }
    }
    return this;
  }

  withdraw(...outputs: WithdrawOutput[]): this {
    for (const output of outputs) {
      this.withdraws.push({
        token: this.token,
        recipient: output.recipient ?? this.parentBuilder.userAddress,
        amount: output.amount,
      });
    }
    return this;
  }

  transfer(...outputs: TransferOutput[]): this {
    for (const output of outputs) {
      this.createNotes.push({
        token: this.token,
        recipient: output.recipient,
        amount: output.amount,
      });
    }
    return this;
  }

  surplusTo(recipient: StarknetAddress | Channel): this {
    this.surplusRecipient = isChannel(recipient)
      ? { address: this.parentBuilder.userAddress, channel: recipient }
      : { address: recipient };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.parentBuilder.with(token);
  }

  done(): PrivateTransfersBuilder {
    return this.parentBuilder;
  }

  async execute(options?: ExecuteOptions): Promise<ExecuteResult> {
    return this.parentBuilder.execute(options);
  }

  reset(): void {
    this.openTokenChannels = [];
    this.useNotes = [];
    this.deposits = [];
    this.withdraws = [];
    this.hasExplicitInputs = false;
    this.surplusRecipient = undefined;
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
  public defaultSurplusRecipient?: SurplusRecipient;

  // Options passed at build time
  private buildOptions?: ExecuteOptions;

  constructor(
    private transfers: PrivateTransfers,
    public readonly userAddress: StarknetAddress,
    options?: ExecuteOptions
  ) {
    this.buildOptions = options;
  }

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

  surplusTo(recipient: StarknetAddress | Channel): this {
    this.defaultSurplusRecipient = isChannel(recipient)
      ? { address: this.userAddress, channel: recipient }
      : { address: recipient };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    return this.tokenBuilders.get(token)!;
  }

  async execute(options?: ExecuteOptions): Promise<ExecuteResult> {
    // Merge build-time options with execute-time options
    const mergedOptions: ExecuteOptions = {
      ...this.buildOptions,
      ...options,
      autoDiscover: {
        ...this.buildOptions?.autoDiscover,
        ...options?.autoDiscover,
      },
    };

    // Collect raw actions from token builders
    // Context resolution will happen in PrivateTransfers.execute via ActionCompiler
    const openTokenChannels: OpenTokenChannelAction[] = [];
    const deposits: DepositAction[] = [];
    const useNotes: UseNoteAction[] = [];
    const createNotes: CreateNoteAction[] = [];
    const withdraws: WithdrawAction[] = [];

    for (const [token, tokenBuilder] of this.tokenBuilders.entries()) {
      openTokenChannels.push(...tokenBuilder.openTokenChannels);

      // Deposits
      deposits.push(...tokenBuilder.deposits);

      // Use notes
      useNotes.push(...tokenBuilder.useNotes);

      // Create notes
      createNotes.push(...tokenBuilder.createNotes);

      // Withdraws
      withdraws.push(...tokenBuilder.withdraws);

      // Handle surplus - calculate and add CreateNoteAction if needed
      const surplusRecipient = tokenBuilder.surplusRecipient ?? this.defaultSurplusRecipient;
      if (surplusRecipient) {
        // Calculate surplus: deposits + useNotes - transfers - withdraws
        const depositSum = tokenBuilder.deposits.reduce(
          (sum, d) => sum + (d.noteId ? 0n : d.amount),
          0n
        );
        const useNoteSum = tokenBuilder.useNotes.reduce((sum, u) => sum + u.note.amount, 0n);
        const createNoteSum = tokenBuilder.createNotes.reduce(
          (sum, c) => sum + (isOpen(c.amount) ? 0n : (c.amount as Amount)),
          0n
        );
        const withdrawSum = tokenBuilder.withdraws.reduce((sum, w) => sum + w.amount, 0n);

        const surplus = depositSum + useNoteSum - createNoteSum - withdrawSum;
        if (surplus > 0n) {
          createNotes.push({
            token,
            recipient: surplusRecipient.address,
            amount: surplus,
          });
        }
      }
    }

    // Build raw actions (no context - ActionCompiler will resolve)
    const actions: Actions = {
      setViewingKey: this.setViewingKey,
      openChannels: this.openChannels.length > 0 ? this.openChannels : undefined,
      openTokenChannels: openTokenChannels.length > 0 ? openTokenChannels : undefined,
      deposits: deposits.length > 0 ? deposits : undefined,
      useNotes: useNotes.length > 0 ? useNotes : undefined,
      createNotes: createNotes.length > 0 ? createNotes : undefined,
      withdraws: withdraws.length > 0 ? withdraws : undefined,
    };

    // Execute via PrivateTransfers - ActionCompiler will resolve contexts
    return this.transfers.execute(actions, mergedOptions);
  }

  reset(): void {
    this.setViewingKey = undefined;
    this.openChannels = [];
    this.callCalls = [];
    this.tokenBuilders.clear();
    this.defaultSurplusRecipient = undefined;
  }
}
