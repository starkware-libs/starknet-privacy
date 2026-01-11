/**
 * Mock builder implementations for testing.
 */

import type {
  Amount,
  CallAndProof,
  Note,
  NoteId,
  PrivateRecipient,
  PrivateTransfersBuilder,
  StarknetAddress,
  TokenOperationsBuilder,
  TransferOutput,
  WithdrawOutput,
} from "../interfaces.js";
import { Channel } from "../interfaces.js";
import type { Call } from "starknet";
import { type PrivateKey } from "../utils/crypto.js";
import { assert, isOpen, toBigInt } from "../utils/index.js";
import type { CompositeInput, CompositeOutput, PrivacyPool } from "./pool.js";
import { createMockCallAndProof } from "./helpers.js";
import { Withdrawal } from "./index.js";

// ============ Mock Token Operations Builder ============

export class MockTokenOperationsBuilder implements TokenOperationsBuilder {
  // Queued operations
  public setupCalls: PrivateRecipient[] = [];
  public inputNotes: Note[] = [];
  public depositCalls: Array<{ amount: Amount; recipient: PrivateRecipient | NoteId }> = [];
  public withdrawCalls: WithdrawOutput[] = [];
  public transferCalls: TransferOutput[] = [];

  constructor(
    private parentBuilder: MockPrivateTransfersBuilder,
    public readonly token: StarknetAddress
  ) {}

  setup(recipient: PrivateRecipient): this {
    this.setupCalls.push(recipient);
    return this;
  }

  inputs(...notes: Note[]): this {
    this.inputNotes.push(...notes);
    return this;
  }

  deposit(amount: Amount, recipient: PrivateRecipient | NoteId): this {
    this.depositCalls.push({ amount, recipient });
    return this;
  }

  withdraw(...outputs: WithdrawOutput[]): this {
    this.withdrawCalls.push(...outputs);
    return this;
  }

  transfer(...outputs: TransferOutput[]): this {
    this.transferCalls.push(...outputs);
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
    this.setupCalls = [];
    this.inputNotes = [];
    this.depositCalls = [];
    this.withdrawCalls = [];
    this.transferCalls = [];
  }
}

// ============ Mock Private Transfers Builder ============

export class MockPrivateTransfersBuilder implements PrivateTransfersBuilder {
  public registerCalled = false;
  public setupCalls: PrivateRecipient[] = [];
  public callCalls: Call[] = [];
  public tokenBuilders = new Map<string, MockTokenOperationsBuilder>();

  constructor(
    private pool: PrivacyPool,
    private userAddress: StarknetAddress,
    private userPrivateKey: PrivateKey
  ) {}

  register(): this {
    this.registerCalled = true;
    return this;
  }

  setup(recipient: PrivateRecipient): this {
    this.setupCalls.push(recipient);
    return this;
  }

  call(call: Call): this {
    this.callCalls.push(call);
    return this;
  }

  with(token: StarknetAddress): TokenOperationsBuilder {
    if (!this.tokenBuilders.has(String(token))) {
      this.tokenBuilders.set(String(token), new MockTokenOperationsBuilder(this, token));
    }
    return this.tokenBuilders.get(String(token))!;
  }

  async execute(): Promise<CallAndProof[]> {
    const results: CallAndProof[] = [];

    // 1. Register user if requested
    if (this.registerCalled) {
      this.pool.register(this.userAddress, this.userPrivateKey);
      results.push(createMockCallAndProof());
    }

    // 2. Setup initial channels for recipients (and populate their context)
    for (const recipient of this.setupCalls) {
      const channelKey = this.pool.setChannel(
        this.userAddress,
        this.userPrivateKey,
        recipient.address
      );
      // Only overwrite context if undefined or key differs (preserves nonces/tokens)
      if (!recipient.context || recipient.context.key !== channelKey) {
        recipient.context = new Channel(channelKey);
      }
      results.push(createMockCallAndProof());
    }

    // 3. Setup tokens for recipients (from all token builders)
    for (const tokenBuilder of this.tokenBuilders.values()) {
      for (const recipient of tokenBuilder.setupCalls) {
        const channel = recipient.context;
        const nonce = channel.incrementTokenNonce();
        this.pool.setToken(
          this.userAddress,
          recipient.address,
          channel.key,
          tokenBuilder.token,
          nonce
        );
        results.push(createMockCallAndProof());
      }
    }

    // 4. Gather all inputs and outputs from all token builders
    const allInputs: CompositeInput[] = [];
    const allOutputs: CompositeOutput[] = [];

    for (const tokenBuilder of this.tokenBuilders.values()) {
      const token = tokenBuilder.token;

      // Input notes
      for (const note of tokenBuilder.inputNotes) {
        allInputs.push({ token, witnessOrAmount: note.witness });
      }

      function isPrivateRecipient(value: unknown): value is PrivateRecipient {
        return (
          typeof value === "object" && value !== null && "address" in value && "context" in value
        );
      }

      // Deposits (amount as input)
      for (const { amount, recipient } of tokenBuilder.depositCalls) {
        const nonceOrId = isPrivateRecipient(recipient)
          ? recipient.context.incrementNoteNonce(token)
          : recipient;
        if (isPrivateRecipient(recipient)) {
          allInputs.push({ token, witnessOrAmount: amount });
          allOutputs.push({
            token,
            recipient: recipient.address,
            context: nonceOrId,
            amount,
          });
        } else {
          allInputs.push({ token, witnessOrAmount: amount });
          allOutputs.push({ token, recipient: recipient, context: nonceOrId, amount });
        }
      }

      // Withdrawals
      for (const output of tokenBuilder.withdrawCalls) {
        allOutputs.push({
          token,
          recipient: output.recipient ?? this.userAddress,
          context: Withdrawal,
          amount: output.amount,
        });
      }

      // Transfers
      for (const output of tokenBuilder.transferCalls) {
        const channel = output.recipient.context;
        allOutputs.push({
          token,
          recipient: output.recipient.address,
          context: channel.incrementNoteNonce(token),
          amount: output.amount,
        });
      }
    }

    // 5. Validate input/output balance per token before calling composite
    if (allInputs.length > 0 || allOutputs.length > 0) {
      const inputTotals = new Map<string, bigint>();
      const outputTotals = new Map<string, bigint>();

      for (const input of allInputs) {
        const tokenKey = String(toBigInt(input.token));
        // For witness inputs, we need to look up the note amount from the pool
        if (typeof input.witnessOrAmount !== "bigint") {
          // This is a Witness - we need to get the note amount from the pool
          const note = this.pool.getNote(input.witnessOrAmount, input.token);
          assert(note, `Note not found for witness in token ${tokenKey}`);
          assert(!note.open, `Cannot use open note as input`);
          inputTotals.set(tokenKey, (inputTotals.get(tokenKey) ?? 0n) + note.amount);
        } else {
          inputTotals.set(tokenKey, (inputTotals.get(tokenKey) ?? 0n) + input.witnessOrAmount);
        }
      }

      for (const output of allOutputs) {
        const tokenKey = String(toBigInt(output.token));
        const amount = isOpen(output.amount) ? 0n : output.amount;
        outputTotals.set(tokenKey, (outputTotals.get(tokenKey) ?? 0n) + amount);
      }

      // Check each token balances
      const allTokens = new Set([...inputTotals.keys(), ...outputTotals.keys()]);
      for (const tokenKey of allTokens) {
        const inputTotal = inputTotals.get(tokenKey) ?? 0n;
        const outputTotal = outputTotals.get(tokenKey) ?? 0n;
        assert(
          inputTotal === outputTotal,
          `Builder: input/output mismatch for token ${tokenKey}: input=${inputTotal}, output=${outputTotal}. ` +
            `Use remainder() to send change back to self.`
        );
      }

      this.pool.composite(this.userAddress, this.userPrivateKey, allInputs, allOutputs);
      results.push(createMockCallAndProof());
    }

    return results;
  }

  reset(): void {
    this.registerCalled = false;
    this.setupCalls = [];
    this.callCalls = [];
    this.tokenBuilders.clear();
  }
}
