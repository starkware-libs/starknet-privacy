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

import type { Note, PrivateRegistry, ViewingKey } from "../interfaces.js";
import { Channel } from "./channel.js";
import type { PublicKey } from "../utils/crypto.js";
import { derivePublicKey, toBigInt } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { ClientAction } from "./client-actions.js";
import { compute_channel_key, compute_note_id } from "../utils/hashes.js";
import { debugLog, hex } from "../utils/logging.js";

type TrackingState = {
  channels: AddressMap<Channel>;
  notes: AddressMap<Map<bigint, Note>>;
};

export class PoolSimulator {
  private tracking = new AddressMap<TrackingState>(() => ({
    channels: new AddressMap<Channel>(),
    notes: new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>()),
  }));

  // Track registered public keys (simplified - just the mapping)
  private publicKeys = new AddressMap<PublicKey>();

  // Track note IDs that exist (for hasNoteById check)
  private noteIds = new Set<bigint>();

  /**
   * Execute client actions, updating the tracked state.
   * No encryption, no hashing, no balance checks.
   */
  execute(userAddress: bigint, ...clientActions: ClientAction[]): void {
    for (const action of clientActions) {
      this.processAction(userAddress, action);
    }
  }

  /**
   * Get the channel between sender and recipient.
   */
  getUsersChannel(sender: bigint, recipient: bigint): Channel | undefined {
    return this.tracking.get(sender)?.channels.get(recipient);
  }

  /**
   * Check if an address is registered (has a public key).
   */
  isRegistered(address: bigint): boolean {
    return this.publicKeys.has(address);
  }

  /**
   * Check if a note exists by ID.
   */
  hasNoteById(noteId: bigint): boolean {
    return this.noteIds.has(noteId);
  }

  /**
   * Setup a channel from registry/discovery.
   * Used to initialize state before compilation.
   */
  setupChannel(
    userAddress: bigint,
    _viewingKey: ViewingKey, // kept for API compatibility, not used
    recipientAddress: bigint,
    channel: Channel
  ): void {
    // Register the recipient's public key
    this.publicKeys.set(recipientAddress, channel.publicKey);

    // Create a tracking entry for the user if needed and store the channel
    const userTracking = this.tracking.get(userAddress)!;
    userTracking.channels.set(recipientAddress, new Channel(channel.publicKey, channel.key));

    if (!channel.key) return;

    // Copy token nonces from the channel
    for (const [token, nonces] of channel.tokens.entries()) {
      userTracking.channels.get(recipientAddress)!.tokens.set(token, { ...nonces });
    }
  }

  /**
   * Setup a note from registry.
   * Used to initialize state before compilation.
   */
  setupNote(userAddress: bigint, note: Note, token: bigint): void {
    const noteId = note.id as bigint;

    // Track the note ID
    this.noteIds.add(noteId);

    // Store in tracking
    this.tracking.get(userAddress)!.notes.get(token)!.set(noteId, note);
  }

  /**
   * Export tracked state back to the registry.
   */
  updateRegistry(userAddress: bigint, registry: PrivateRegistry): PrivateRegistry {
    const userTracking = this.tracking.get(userAddress);
    if (!userTracking) return registry;

    for (const [address, channel] of userTracking.channels.entries()) {
      registry.channels.set(address, channel);
    }
    for (const [token, notes] of userTracking.notes.entries()) {
      registry.notes.set(token, Array.from(notes.values()));
    }
    return registry;
  }

  /**
   * Process a single action and update tracking state.
   */
  private processAction(userAddress: bigint, action: ClientAction): void {
    switch (action.type) {
      case "SetViewingKey":
        this.handleSetViewingKey(userAddress, action.input);
        break;

      case "OpenChannel":
        this.handleOpenChannel(userAddress, action.input);
        break;

      case "OpenSubchannel":
        this.handleOpenSubchannel(userAddress, action.input);
        break;

      case "Deposit":
        // Deposits don't affect tracking state (handled by MockPoolContract)
        break;

      case "UseNote":
        this.handleUseNote(userAddress, action.input);
        break;

      case "CreateNote":
        this.handleCreateNote(userAddress, action.input);
        break;

      case "Withdraw":
        // Withdrawals don't affect tracking state (handled by MockPoolContract)
        break;

      case "FollowupCall":
        // Followup calls don't affect tracking state
        break;
    }
  }

  private handleSetViewingKey(
    userAddress: bigint,
    input: { privateKey: ViewingKey; random: bigint }
  ): void {
    // Derive the real public key from the private key
    const publicKey = derivePublicKey(input.privateKey);
    this.publicKeys.set(userAddress, publicKey);

    // Create self-channel entry
    const userTracking = this.tracking.get(userAddress)!;
    userTracking.channels.set(userAddress, new Channel(publicKey));

    debugLog("pool-simulator", "SetViewingKey", hex(userAddress));
  }

  private handleOpenChannel(
    userAddress: bigint,
    input: {
      senderPrivateKey: ViewingKey;
      recipientAddr: bigint;
      recipientPublicKey: PublicKey;
      random: bigint;
    }
  ): void {
    const { senderPrivateKey, recipientAddr, recipientPublicKey } = input;

    // Store recipient's public key
    this.publicKeys.set(recipientAddr, recipientPublicKey);

    // Compute the real channel key
    const channelKey = compute_channel_key(
      userAddress,
      toBigInt(senderPrivateKey),
      recipientAddr,
      toBigInt(recipientPublicKey)
    );

    // Create/update channel in tracking
    const userTracking = this.tracking.get(userAddress)!;
    const existingChannel = userTracking.channels.get(recipientAddr);

    if (existingChannel) {
      existingChannel.key = channelKey;
    } else {
      userTracking.channels.set(recipientAddr, new Channel(recipientPublicKey, channelKey));
    }

    debugLog("pool-simulator", "OpenChannel", hex(userAddress), "->", hex(recipientAddr));
  }

  private handleOpenSubchannel(
    _userAddress: bigint,
    input: {
      recipientAddr: bigint;
      recipientPublicKey: PublicKey;
      channelKey: bigint;
      token: bigint;
      index: number;
      random: bigint;
    }
  ): void {
    const { recipientAddr, token, index } = input;

    // Update channel's token nonces
    const userTracking = this.tracking.get(_userAddress)!;
    const channel = userTracking.channels.get(recipientAddr);

    if (channel) {
      channel.tokens.set(token, {
        tokenNonce: index,
        noteNonce: 0,
      });
    }

    debugLog(
      "pool-simulator",
      "OpenSubchannel",
      hex(_userAddress),
      "->",
      hex(recipientAddr),
      "token:",
      hex(token)
    );
  }

  private handleUseNote(
    userAddress: bigint,
    input: {
      ownerPrivateKey: ViewingKey;
      channelKey: bigint;
      token: bigint;
      noteIndex: number;
    }
  ): void {
    const { token } = input;

    // Remove the note from tracking (it's being spent)
    const userTracking = this.tracking.get(userAddress);
    if (userTracking) {
      const tokenNotes = userTracking.notes.get(token);
      if (tokenNotes) {
        // Find and remove the note with matching channel key and index
        // Since we don't have the noteId directly, we need to find it
        for (const [noteId, note] of tokenNotes) {
          if (
            note.witness.channelKey === input.channelKey &&
            note.witness.nonce === input.noteIndex
          ) {
            tokenNotes.delete(noteId);
            this.noteIds.delete(noteId);
            break;
          }
        }
      }
    }

    debugLog("pool-simulator", "UseNote", hex(userAddress), "token:", hex(token));
  }

  private handleCreateNote(
    userAddress: bigint,
    input: {
      senderPrivateKey: ViewingKey;
      recipientAddr: bigint;
      recipientPublicKey: PublicKey;
      token: bigint;
      amount: bigint | symbol;
      index: number;
      random: bigint;
    }
  ): void {
    const { senderPrivateKey, recipientAddr, recipientPublicKey, token, amount, index } = input;

    // Update sender's channel note nonce
    const senderTracking = this.tracking.get(userAddress)!;
    const senderChannel = senderTracking.channels.get(recipientAddr);
    if (senderChannel) {
      senderChannel.incrementNoteNonce(token);
    }

    // Compute the channel key to generate the note ID
    const channelKey = compute_channel_key(
      userAddress,
      toBigInt(senderPrivateKey),
      recipientAddr,
      toBigInt(recipientPublicKey)
    );

    // Compute the proper note ID using the hash function
    const noteId = compute_note_id(channelKey, token, index);

    const recipientTracking = this.tracking.get(recipientAddr)!;
    recipientTracking.notes.get(token)!.set(noteId, {
      id: noteId,
      amount: typeof amount === "bigint" ? amount : 0n,
      witness: {
        channelKey,
        nonce: index,
        r: input.random,
      },
      sender: userAddress,
    });

    this.noteIds.add(noteId);

    debugLog(
      "pool-simulator",
      "CreateNote",
      hex(userAddress),
      "->",
      hex(recipientAddr),
      "token:",
      hex(token)
    );
  }
}
