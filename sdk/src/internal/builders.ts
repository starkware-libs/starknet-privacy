/**
 * Builder implementations for constructing private transfer operations.
 */

import type {
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
  SurplusAction,
  FollowupCallAction,
} from "../interfaces.js";
import type { Call } from "starknet";
import { num } from "starknet";
import { AddressMap } from "../utils/maps.js";

import { debugLog } from "../utils/logging.js";

/** Normalize BigNumberish to bigint */
const toBigInt = (value: StarknetAddress): bigint => num.toBigInt(value);

// ============ Token Operations Builder ============

export class TokenOperationsBuilderImpl implements TokenOperationsBuilder {
  // Actions stored without context - context resolved during execute
  public openTokenChannels: OpenTokenChannelAction[] = [];
  public useNotes: UseNoteAction[] = [];
  public deposits: DepositAction[] = [];
  public createNotes: CreateNoteAction[] = [];
  public withdraws: WithdrawAction[] = [];
  // Surplus recipient (overrides parent builder's surplus recipient for this token)
  public surplusAction?: SurplusAction;

  constructor(
    private parentBuilder: PrivateTransfersBuilderImpl,
    public readonly token: StarknetAddress
  ) {
    debugLog("builder", `TokenBuilder created for ${token}`);
  }

  setup(recipient: StarknetAddress): this {
    debugLog("builder", `TokenBuilder.setup for ${this.token} -> ${recipient}`);
    this.openTokenChannels.push({ recipient: toBigInt(recipient), token: toBigInt(this.token) });
    return this;
  }

  inputs(...notes: Note[]): this {
    for (const note of notes) {
      this.useNotes.push({ token: toBigInt(this.token), note });
    }
    return this;
  }

  deposit(...inputs: DepositInput[]): this {
    debugLog("builder", `TokenBuilder.deposit for ${this.token}`, inputs);
    const token = toBigInt(this.token);
    for (const input of inputs) {
      // if ("noteId" in input) {
      //   this.deposits.push({ token, amount: input.amount, noteId: input.noteId });
      // } else {
      this.deposits.push({ token, amount: input.amount });
      // If recipient is specified, set surplus recipient for this token
      // Surplus handling will create a note for them with the remaining balance
      if ("recipient" in input && input.recipient !== undefined) {
        this.surplusAction = {
          recipient: toBigInt(input.recipient),
          token,
          withdraw: false,
        };
        // }
      }
    }
    return this;
  }

  withdraw(...outputs: WithdrawOutput[]): this {
    const token = toBigInt(this.token);
    for (const output of outputs) {
      this.withdraws.push({
        token,
        recipient: toBigInt(output.recipient ?? this.parentBuilder.userAddress),
        amount: output.amount,
      });
    }
    return this;
  }

  transfer(...outputs: TransferOutput[]): this {
    const token = toBigInt(this.token);
    for (const output of outputs) {
      this.createNotes.push({
        token,
        recipient: toBigInt(output.recipient),
        amount: output.amount,
      });
    }
    return this;
  }

  surplusTo(recipient: StarknetAddress, withdraw?: boolean): this {
    this.surplusAction = { recipient: toBigInt(recipient), token: toBigInt(this.token), withdraw };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder;
  with(token: StarknetAddress, ops: (t: TokenOperationsBuilder) => void): this;
  with(
    token: StarknetAddress,
    ops?: (t: TokenOperationsBuilder) => void
  ): TokenOperationsBuilder | this {
    if (ops) {
      ops(this.parentBuilder.with(token));
      return this;
    }
    return this.parentBuilder.with(token);
  }

  done(): PrivateTransfersBuilder {
    return this.parentBuilder;
  }

  async execute(options?: ExecuteOptions): Promise<ExecuteResult> {
    return this.parentBuilder.execute(options);
  }
}

// ============ Private Transfers Builder ============

export class PrivateTransfersBuilderImpl implements PrivateTransfersBuilder {
  public setViewingKey?: SetViewingKeyAction;
  public openChannels: OpenChannelAction[] = [];
  public followupCall?: FollowupCallAction;
  public tokenBuilders = new AddressMap<TokenOperationsBuilderImpl>(
    (token) => new TokenOperationsBuilderImpl(this, token)
  );

  // Default surplus recipient for all tokens
  public defaultSurplusAction?: SurplusAction;

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
    this.openChannels.push({ recipient: toBigInt(recipient) });
    return this;
  }

  call(call: Call): this {
    this.followupCall = { call };
    return this;
  }

  surplusTo(recipient: StarknetAddress, withdraw?: boolean): this {
    this.defaultSurplusAction = { recipient: toBigInt(recipient), token: undefined!, withdraw };
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder;
  with(token: StarknetAddress, ops: (t: TokenOperationsBuilder) => void): this;
  with(
    token: StarknetAddress,
    ops?: (t: TokenOperationsBuilder) => void
  ): TokenOperationsBuilder | this {
    const tokenBuilder = this.tokenBuilders.get(token)!;
    if (ops) {
      ops(tokenBuilder);
      return this;
    }
    return tokenBuilder;
  }

  async execute(options?: ExecuteOptions): Promise<ExecuteResult> {
    debugLog("builder", "PrivateTransfersBuilderImpl.execute called");
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
    const surpluses: SurplusAction[] = [];

    for (const [token, tokenBuilder] of this.tokenBuilders.entries()) {
      debugLog("builder", `Collecting actions for ${token}`, {
        openTokenChannels: tokenBuilder.openTokenChannels,
        deposits: tokenBuilder.deposits.length,
      });
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
      const surplusToAction = tokenBuilder.surplusAction ?? this.defaultSurplusAction;
      if (surplusToAction) {
        surpluses.push({
          ...surplusToAction,
          token: token,
        });
      }
    }

    // Build raw actions (no context - ActionCompiler will resolve)
    const actions: Actions = {
      setViewingKey: this.setViewingKey,
      openChannels: this.openChannels,
      openTokenChannels,
      deposits,
      useNotes,
      createNotes,
      withdraws,
      surpluses,
      followupCall: this.followupCall,
    };

    // Execute via PrivateTransfers - ActionCompiler will resolve contexts
    return this.transfers.execute(actions, mergedOptions);
  }
}
