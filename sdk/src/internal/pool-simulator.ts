/**
 * PoolSimulator - Minimal state tracker for the compiler.
 *
 * This class tracks channel and note state without encryption, hashing, or balance validation.
 * It's used by the ActionCompiler to simulate action execution and track nonces.
 *
 * Key differences from PrivacyPool:
 * - No encrypted state (publicKeys, channels, subchannels, notes, nullifiers, outgoingChannels)
 * - No encryption utilities
 * - No balance validation
 * - No callbacks - state is updated directly
 * - Just tracks Channel objects with nonces and Note objects
 */

import type { Note, PrivateRegistry, StarknetAddressBigint, ViewingKey } from "../interfaces.js";
import { Channel } from "./channel.js";
import { derivePublicKey, toBigInt } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import {
  ClientAction,
  CreateNoteInput,
  OpenChannelInput,
  OpenSubchannelInput,
  SetViewingKeyInput,
  UseNoteInput,
} from "./client-actions.js";
import { compute_channel_key, compute_note_id } from "../utils/hashes.js";
import { debugLog, hex } from "../utils/logging.js";

export class PoolSimulator {
  // Per-user state: channels from this user to recipients, notes owned by this user
  private channels = new AddressMap<Channel>();
  private notes = new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>());

  constructor(private readonly userAddress: StarknetAddressBigint) {}

  /**
   * Execute a client action, updating the tracked state.
   * No encryption, no hashing, no balance checks.
   */
  execute(privateKey: ViewingKey, action: ClientAction): void {
    switch (action.type) {
      case "SetViewingKey":
        this.handleSetViewingKey(privateKey, action.input);
        break;

      case "OpenChannel":
        this.handleOpenChannel(privateKey, action.input);
        break;

      case "OpenSubchannel":
        this.handleOpenSubchannel(action.input);
        break;

      case "Deposit":
        // Deposits don't affect tracking state (handled by MockPoolContract)
        break;

      case "UseNote":
        this.handleUseNote(action.input);
        break;

      case "CreateNote":
        this.handleCreateNote(privateKey, action.input);
        break;

      case "Withdraw":
        // Withdrawals don't affect tracking state (handled by MockPoolContract)
        break;

      case "FollowupCall":
        // Followup calls don't affect tracking state
        break;
    }
  }

  /**
   * Get the channel to a recipient.
   */
  getChannel(recipient: StarknetAddressBigint): Channel | undefined {
    return this.channels.get(recipient);
  }

  /**
   * Check if a note exists by ID.
   */
  hasNote(token: StarknetAddressBigint, noteId: bigint): boolean {
    return this.notes.get(token)?.has(noteId) ?? false;
  }

  /**
   * Setup a channel from registry/discovery.
   * Used to initialize state before compilation.
   */
  setupChannel(recipientAddress: StarknetAddressBigint, channel: Channel): void {
    this.channels.set(recipientAddress, new Channel(channel.publicKey, channel.key));

    if (!channel.key) return;

    // Copy token nonces from the channel
    for (const [token, nonces] of channel.tokens.entries()) {
      this.channels.get(recipientAddress)!.tokens.set(token, { ...nonces });
    }
  }

  /**
   * Setup a note from registry.
   * Used to initialize state before compilation.
   */
  setupNote(token: StarknetAddressBigint, note: Note): void {
    this.notes.get(token)!.set(toBigInt(note.id), note);
  }

  /**
   * Export tracked state back to the registry.
   */
  updateRegistry(registry: PrivateRegistry): PrivateRegistry {
    for (const [address, channel] of this.channels.entries()) {
      registry.channels.set(address, channel);
    }
    for (const [token, notes] of this.notes.entries()) {
      registry.notes.set(token, Array.from(notes.values()));
    }
    return registry;
  }

  private handleSetViewingKey(privateKey: ViewingKey, _input: SetViewingKeyInput): void {
    // Derive the real public key from the private key and create self-channel entry
    const publicKey = derivePublicKey(privateKey);
    this.channels.set(this.userAddress, new Channel(publicKey));

    debugLog("pool-simulator", "SetViewingKey", hex(this.userAddress));
  }

  private handleOpenChannel(privateKey: ViewingKey, input: OpenChannelInput): void {
    const { recipientAddr, recipientPublicKey } = input;

    // Compute the real channel key
    const channelKey = compute_channel_key(
      this.userAddress,
      toBigInt(privateKey),
      recipientAddr,
      toBigInt(recipientPublicKey)
    );

    // Create/update channel
    const channel = this.channels.get(recipientAddr, () => new Channel(recipientPublicKey))!;

    channel.key = channelKey;

    debugLog("pool-simulator", "OpenChannel", hex(this.userAddress), "->", hex(recipientAddr));
  }

  private handleOpenSubchannel(input: OpenSubchannelInput): void {
    const { recipientAddr, token, index } = input;

    // Update channel's token nonces
    const channel = this.channels.get(recipientAddr)!;

    channel.tokens.set(token, {
      tokenIndex: index,
      noteNonce: 0,
    });

    debugLog(
      "pool-simulator",
      "OpenSubchannel",
      hex(this.userAddress),
      "->",
      hex(recipientAddr),
      "token:",
      hex(token)
    );
  }

  private handleUseNote(input: UseNoteInput): void {
    const { token } = input;

    // Remove the note from tracking (it's being spent)
    const tokenNotes = this.notes.get(token)!;

    const noteId = compute_note_id(input.channelKey, token, input.noteIndex);

    tokenNotes.delete(noteId);

    debugLog("pool-simulator", "UseNote", hex(this.userAddress), "token:", hex(token));
  }

  private handleCreateNote(privateKey: ViewingKey, input: CreateNoteInput): void {
    const { recipientAddr, recipientPublicKey, token, amount, index } = input;

    // Update sender's channel note nonce
    const senderChannel = this.channels.get(recipientAddr)!;
    senderChannel.incrementNoteNonce(token);

    // Only track note if this is a self-transfer (recipient is us)
    if (recipientAddr === this.userAddress) {
      // Compute the channel key to generate the note ID
      const channelKey = compute_channel_key(
        this.userAddress,
        toBigInt(privateKey),
        recipientAddr,
        toBigInt(recipientPublicKey)
      );

      // Compute the proper note ID using the hash function
      const noteId = compute_note_id(channelKey, token, index);

      this.notes.get(token)!.set(noteId, {
        id: noteId,
        amount: typeof amount === "bigint" ? amount : 0n,
        witness: {
          channelKey,
          nonce: index,
          r: input.random,
        },
        sender: this.userAddress,
      });
    }

    debugLog(
      "pool-simulator",
      "CreateNote",
      hex(this.userAddress),
      "->",
      hex(recipientAddr),
      "token:",
      hex(token)
    );
  }
}
