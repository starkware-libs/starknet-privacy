/**
 * Mock PrivacyPool implementation for testing.
 * Consumes ClientAction[] (the unwrapped action inputs from the compiler).
 */

import type { Amount, Note, Open, PrivateRegistry, StarknetAddressBigint } from "../interfaces.js";
import { Witness } from "../interfaces.js";
import { Channel } from "../internal/channel.js";
import {
  type Hash,
  type PrivateKey as ViewingKey,
  type PublicKey,
  derivePublicKey,
  ChannelKey,
  generateRandom,
  toBigInt,
} from "../utils/crypto.js";
import { encryptions, type EncChannelInfo, type EncSubchannelInfo } from "../utils/encryptions.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert, isOpen } from "../utils/validation.js";
import type { MockContracts, MockContract } from "./contracts.js";
import {
  compute_channel_key,
  compute_channel_id,
  compute_subchannel_key,
  compute_subchannel_id,
  compute_note_id,
  compute_nullifier,
} from "../utils/hashes.js";
import { ClientAction } from "../internal/client-actions.js";
import { debugLog, hex } from "../utils/logging.js";

type OpenNote = {
  r: bigint;
  amount: Amount;
  token: StarknetAddressBigint;
};

type TrackingState = {
  channels: AddressMap<Channel>;
  notes: AddressMap<Map<bigint, Note>>;
};

/** Snapshot of PrivacyPool state */
/** Encrypted note: either packed encrypted amount or open note */
type EncryptedNote = { packed: bigint; token: bigint; index: number };

export type PrivacyPoolSnapshot = {
  publicKeys: Map<bigint, PublicKey>;
  channels: Map<string, EncChannelInfo[]>;
  channelIds: Set<Hash>;
  subchannels: Map<Hash, EncSubchannelInfo>;
  subchannelIds: Set<Hash>;
  notes: Map<Hash, EncryptedNote | OpenNote>;
  nullifiers: Set<Hash>;
  tracking: Map<bigint, TrackingState>;
};

class ChannelsMap extends AdvancedMap<
  { address: bigint; publicKey: PublicKey },
  EncChannelInfo[],
  string
> {
  constructor() {
    super({
      keyConverter: (key) => `${key.address}:${key.publicKey}`,
      defaultFactory: () => [],
    });
  }
}

/** Callback that performs a state change */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StateCallback = () => any;

export class PrivacyPool implements MockContract {
  private publicKeys = new AddressMap<PublicKey>();
  private channels = new ChannelsMap();
  private channelIds = new Set<Hash>();
  private subchannels = new Map<Hash, EncSubchannelInfo>();
  private subchannelIds = new Set<Hash>();
  private notes = new Map<Hash, EncryptedNote | OpenNote>();
  private nullifiers = new Set<Hash>();

  // state tracking, not part of the official spec
  private tracking = new AddressMap<TrackingState>(() => ({
    channels: new AddressMap<Channel>(),
    notes: new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>()),
  }));

  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: bigint,
    private contracts: MockContracts,
    private validateExecutionBalances: boolean = true
  ) {}

  // ============ Snapshot/Restore ============

  /** Create a snapshot of the current pool state */
  snapshot(): PrivacyPoolSnapshot {
    // Deep copy channels arrays to prevent mutation affecting snapshot
    const channelsSnapshot = new Map<string, EncChannelInfo[]>();
    for (const [key, arr] of this.channels.entries()) {
      channelsSnapshot.set(key, [...arr]);
    }

    // Deep copy notes objects to prevent mutation affecting snapshot
    const notesSnapshot = new Map<Hash, EncryptedNote | OpenNote>();
    for (const [key, note] of this.notes) {
      notesSnapshot.set(key, { ...note });
    }

    // Deep copy tracking data
    const trackingSnapshot = new Map<bigint, TrackingState>();

    for (const [user, data] of this.tracking.entries()) {
      const channelsCopy = new AddressMap<Channel>();
      for (const [addr, channel] of data.channels.entries()) {
        channelsCopy.set(addr, channel.clone());
      }

      const notesCopy = new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>());
      for (const [token, notesMap] of data.notes.entries()) {
        notesCopy.set(token, new Map<bigint, Note>(notesMap.entries()));
      }

      trackingSnapshot.set(user, {
        channels: channelsCopy,
        notes: notesCopy,
      });
    }

    return {
      publicKeys: new Map(this.publicKeys.entries()),
      channels: channelsSnapshot,
      channelIds: new Set(this.channelIds),
      subchannels: new Map(this.subchannels),
      subchannelIds: new Set(this.subchannelIds),
      notes: notesSnapshot,
      nullifiers: new Set(this.nullifiers),
      tracking: trackingSnapshot,
    };
  }

  /** Restore pool state from a snapshot */
  restore(snapshot: unknown): void {
    const s = snapshot as PrivacyPoolSnapshot;
    // AdvancedMaps need clear + refill (can't replace internal map)
    this.publicKeys.clear();
    for (const [k, v] of s.publicKeys) this.publicKeys.set(k, v);

    this.channels.clear();
    for (const [strKey, value] of s.channels) {
      const [address, publicKey] = strKey.split(":");
      this.channels.set({ address: BigInt(address), publicKey: BigInt(publicKey) }, value);
    }

    // Regular Maps/Sets can be replaced directly
    this.channelIds = new Set(s.channelIds);
    this.subchannels = new Map(s.subchannels);
    this.subchannelIds = new Set(s.subchannelIds);
    this.notes = new Map(s.notes);
    this.nullifiers = new Set(s.nullifiers);

    // Restore tracking by deep cloning the snapshot's structure
    this.tracking.clear();
    for (const [user, data] of s.tracking) {
      const channelsMap = new AddressMap<Channel>();
      for (const [addr, channel] of data.channels) {
        channelsMap.set(addr, channel.clone());
      }

      const notesMap = new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>());
      for (const [token, notes] of data.notes) {
        notesMap.set(token, new Map(notes.entries()));
      }

      this.tracking.set(user, {
        channels: channelsMap,
        notes: notesMap,
      });
    }
  }

  // ============ Public Methods ============

  isRegistered(address: bigint): boolean {
    return this.publicKeys.has(address);
  }

  getPublicKey(address: bigint): PublicKey {
    this.assertRegistered(address);
    return this.publicKeys.get(address)!;
  }

  getChannels(address: bigint): EncChannelInfo[] {
    const pk = this.getPublicKey(address);
    const result = this.channels.get({ address, publicKey: pk })!;
    debugLog("pool", "getChannels debug", {
      address: hex(address),
      publicKey: hex(pk),
      resultLength: result?.length ?? 0,
      allKeys: [...this.channels.keys()],
    });
    return result;
  }

  doesChannelExist(channelKey: bigint, from: bigint, to: bigint): boolean {
    return this.channelIds.has(
      compute_channel_id(channelKey, from, to, toBigInt(this.getPublicKey(to)))
    );
  }

  getToken(channelKey: Hash, nonce: number): StarknetAddressBigint | false {
    const subchannelKey = compute_subchannel_key(channelKey, nonce);
    const encrypted = this.subchannels.get(subchannelKey);
    if (!encrypted) return false;
    return encryptions.decryptSubchannelInfo(encrypted, channelKey, nonce).token;
  }

  doesSubchannelExist(channelKey: bigint, address: bigint, token: bigint): boolean {
    return this.subchannelIds.has(
      compute_subchannel_id(channelKey, address, toBigInt(this.getPublicKey(address)), token)
    );
  }

  getNote(channelKey: ChannelKey, index: number, token: bigint) {
    const noteId = compute_note_id(channelKey, token, index);
    const note = this.notes.get(noteId);
    if (note === undefined) return false;
    if ("r" in note && note.r == 1n) {
      return { id: noteId, amount: (note as OpenNote).amount, r: 1n, open: true };
    }
    const packed = note as { packed: bigint; token: bigint; index: number };
    const { amount, salt } = encryptions.decryptNoteAmount(
      packed.packed,
      channelKey,
      packed.token,
      packed.index
    );
    return {
      id: noteId,
      amount,
      r: salt,
      open: false,
    };
  }

  hasNoteById(noteId: bigint) {
    return this.notes.has(noteId);
  }

  getNullifier(witness: Witness, token: bigint, ownerPrivateKey: ViewingKey): boolean {
    return this.nullifiers.has(
      compute_nullifier(witness.channelKey, token, witness.nonce, toBigInt(ownerPrivateKey))
    );
  }

  getUsersChannel(sender: bigint, recipient: bigint): Channel | undefined {
    return this.tracking.get(sender)?.channels.get(recipient);
  }

  openDeposit(noteId: bigint, token: bigint, amount: Amount): void {
    this.fillOpenNote(noteId, token, amount);
    this.deposit(this.address, token, amount);
  }

  /**
   * Execute client actions. Actions must be in the correct order:
   * 1. SetViewingKey (optional, at most 1)
   * 2. OpenChannel (any number)
   * 3. OpenSubchannel (any number)
   * 4. Deposit (any number)
   * 5. UseNote (any number)
   * 6. CreateNote (any number)
   * 7. Withdraw (any number)
   *
   * Returns callbacks that can replay the state changes.
   * The pool state is restored after validation, so the callbacks
   * must be invoked to actually apply the changes.
   *
   * @param sender The sender's address
   * @param clientActions The array of client action inputs from the compiler
   * @returns Array of callbacks that perform the state changes
   */
  execute(sender: bigint, ...clientActions: ClientAction[]): StateCallback[] {
    // Validate token totals before mutating state
    if (this.validateExecutionBalances) {
      this.validateTokenTotals(sender, clientActions);
    }

    const callbacks: StateCallback[] = [];

    // Process actions in order
    for (const action of clientActions) {
      let callback: StateCallback | undefined = undefined;

      switch (action.type) {
        case "SetViewingKey":
          callback = this.register(sender, action.input.privateKey, action.input.random);
          break;

        case "OpenChannel":
          callback = this.setChannel(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.random
          );
          break;

        case "OpenSubchannel":
          callback = this.setToken(
            sender,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.channelKey,
            action.input.token,
            action.input.index,
            action.input.random
          );
          break;

        case "Deposit":
          callback = this.deposit(sender, action.input.token, action.input.amount);
          if (action.input.noteId !== undefined) {
            const noteId = action.input.noteId;
            const token = action.input.token;
            const amount = action.input.amount;
            callback = () => {
              this.openDeposit(noteId, token, amount);
            };
          }
          break;

        case "UseNote":
          callback = this.useNote(
            sender,
            action.input.ownerPrivateKey,
            action.input.token,
            action.input.channelKey,
            action.input.noteIndex
          );
          break;

        case "CreateNote":
          callback = this.createNote(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.token,
            action.input.index,
            action.input.amount,
            action.input.random
          );
          break;

        case "Withdraw":
          callback = this.withdraw(
            action.input.token,
            action.input.withdrawalTarget,
            action.input.amount
          );
          break;

        case "FollowupCall":
          callbacks.push(() => {
            this.contracts.call(
              action.input.call.contractAddress,
              action.input.call.entrypoint,
              ...(action.input.call.calldata ? (action.input.call.calldata as unknown[]) : [])
            );
          });
          break;
      }

      // Execute callback and store it
      if (callback) {
        callback();
        callbacks.push(callback);
      }
    }

    return callbacks;
  }

  setupChannel(
    userAddress: bigint,
    viewingKey: ViewingKey,
    address: bigint,
    channel: Channel
  ): void {
    this.publicKeys.set(address, channel.publicKey);
    this.tracking
      .get(userAddress)!
      .channels.set(address, new Channel(channel.publicKey, channel.key));

    if (!channel.key) return;
    this.setChannel(userAddress, viewingKey, address, channel.publicKey, generateRandom())();

    // Use tokenNonce from the channel object
    for (const [token, nonces] of channel.tokens.entries()) {
      this.setToken(
        userAddress,
        address,
        channel.publicKey,
        channel.key,
        token,
        nonces.tokenIndex,
        generateRandom()
      )();

      // create an open note for the previous note nonce to pass assertion on creation of new one
      if (nonces.noteNonce > 0) {
        this.notes.set(compute_note_id(channel.key, token, nonces.noteNonce - 1), {
          r: 1n,
          amount: 0n,
          token,
        });
      }

      // Restore the nonces
      this.tracking.get(userAddress)!.channels.get(address)!.tokens.set(token, nonces);
    }
  }

  setupNote(userAddress: bigint, note: Note, token: bigint) {
    this.subchannelIds.add(
      compute_subchannel_id(
        note.witness.channelKey,
        userAddress,
        toBigInt(this.getPublicKey(userAddress)),
        token
      )
    );
    const noteIndex = note.witness.nonce;
    this.notes.set(
      note.id as bigint,
      note.open
        ? { r: 1n, amount: note.amount, token }
        : {
            packed: encryptions.encryptNoteAmount(
              note.witness.channelKey,
              token,
              noteIndex,
              note.witness.r,
              note.amount as bigint
            ),
            token,
            index: noteIndex,
          }
    );

    this.tracking
      .get(userAddress)!
      .notes.get(token)!
      .set(note.id as bigint, note);
  }

  updateRegistry(userAddress: bigint, registry: PrivateRegistry): PrivateRegistry {
    for (const [address, channel] of this.tracking.get(userAddress)!.channels.entries()) {
      registry.channels.set(address, channel);
    }
    for (const [token, notes] of this.tracking.get(userAddress)!.notes.entries()) {
      registry.notes.set(token, Array.from(notes.values()));
    }
    return registry;
  }

  // ============ Private Methods ============

  private assertRegistered(address: bigint): void {
    debugLog(
      "pool",
      "assertRegistered",
      hex(address),
      "has?",
      this.publicKeys.has(address),
      "keys:",
      [...this.publicKeys.keys()].map(hex)
    );
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${hex(address)} is not registered`);
    }
  }

  private register(address: bigint, privateKey: ViewingKey, _random: bigint): StateCallback {
    const publicKey = derivePublicKey(privateKey);
    return () => {
      this.publicKeys.set(address, publicKey);
      this.tracking.get(address)!.channels.set(address, new Channel(publicKey));
    };
  }

  private setChannel(
    from: bigint,
    fromPrivateKey: ViewingKey,
    to: bigint,
    toPublicKey: PublicKey,
    random: bigint
  ): StateCallback {
    this.assertRegistered(from);
    const channelKey = compute_channel_key(
      from,
      toBigInt(fromPrivateKey),
      to,
      toBigInt(toPublicKey)
    );
    const channelInfo = encryptions.encryptChannelInfo(
      random,
      toBigInt(toPublicKey),
      channelKey,
      from
    );
    return () => {
      debugLog("pool.callback", "setChannel callback executing from:", hex(from), "to:", hex(to));
      this.tracking.get(from)!.channels.get(to, () => new Channel(toPublicKey))!.key = channelKey;
      this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
      this.channelIds.add(compute_channel_id(channelKey, from, to, toBigInt(toPublicKey)));
      debugLog("pool.callback", "channels after setChannel", {
        to: hex(to),
        channelsLength: this.channels.get({ address: to, publicKey: toPublicKey })!.length,
      });
    };
  }

  private setToken(
    from: bigint,
    to: bigint,
    toPublicKey: PublicKey,
    channelKey: Hash,
    token: bigint,
    index: number,
    random: bigint
  ): StateCallback {
    this.assertRegistered(from);

    debugLog("pool", "setToken", { from, to, toPublicKey, channelKey, token, index, random });
    assert(
      this.channelIds.has(compute_channel_id(channelKey, from, to, toBigInt(toPublicKey))),
      () => `Channel does not exist between ${from} and ${to}`
    );

    assert(
      index == 0 || this.subchannels.has(compute_subchannel_key(channelKey, index - 1)),
      () => `Nonce ${index} is not sequential`
    );

    const subchannelKey = compute_subchannel_key(channelKey, index);
    assert(!this.subchannels.has(subchannelKey), () => `Token ${hex(token)} already exists`);

    // Verify no other subchannel exists for this token in the channel
    const userChannel = this.tracking.get(from)!.channels.get(to)!;
    assert(
      !userChannel.tokens.has(token),
      () =>
        `Token ${hex(token)} already exists in channel with index ${
          userChannel.tokens.get(token)!.tokenIndex
        }`
    );

    const subchannelId = compute_subchannel_id(channelKey, to, toBigInt(toPublicKey), token);
    const encryptedSubchannelInfo = encryptions.encryptSubchannelInfo(
      channelKey,
      index,
      token,
      random
    );

    return () => {
      assert(
        !this.subchannelIds.has(subchannelId),
        () => `Subchannel ${hex(subchannelId)} already exists`
      );
      this.subchannels.set(subchannelKey, encryptedSubchannelInfo);
      this.subchannelIds.add(subchannelId);

      const userChannel = this.tracking.get(from)!.channels.get(to)!;
      // this method may run from setupToken, so the channel is already set
      if (!userChannel.tokens.has(token)) {
        userChannel.tokens.set(token, {
          tokenIndex: index,
          noteNonce: 0,
        });
      } else {
        assert(
          userChannel.tokens.get(token)!.tokenIndex == index,
          () =>
            `Channel with ${to}: Token ${token} nonce mismatch between the user channel and arguments ${userChannel.tokens.get(token)!.tokenIndex} != ${index}`
        );
      }
    };
  }

  private useNote(
    owner: bigint,
    ownerPrivateKey: ViewingKey,
    token: bigint,
    channelKey: Hash,
    noteIndex: number
  ): StateCallback {
    const ownerPublicKey = this.getPublicKey(owner);
    assert(
      this.subchannelIds.has(
        compute_subchannel_id(channelKey, owner, toBigInt(ownerPublicKey), token)
      ),
      () => `Token ${token} does not exist`
    );

    const noteId = compute_note_id(channelKey, token, noteIndex);
    assert(this.notes.has(noteId), () => `Note ${noteId} does not exist`);

    const nullifier = compute_nullifier(channelKey, token, noteIndex, toBigInt(ownerPrivateKey));
    assert(!this.nullifiers.has(nullifier), () => `Nullifier ${nullifier} already exists`);

    return () => {
      debugLog("pool.callback", "useNote callback - adding nullifier", {
        nullifier: hex(nullifier),
        nullifiersSize: this.nullifiers.size,
      });
      this.tracking.get(owner)!.notes.get(token)!.delete(noteId);
      this.nullifiers.add(nullifier);
      debugLog("pool.callback", "useNote callback - after add", {
        nullifiersSize: this.nullifiers.size,
      });
    };
  }

  createNote(
    sender: bigint,
    senderPrivateKey: ViewingKey,
    to: bigint,
    toPublicKey: PublicKey,
    token: bigint,
    index: number,
    amount: Amount | Open,
    random: bigint
  ): StateCallback {
    const channelKey = compute_channel_key(
      sender,
      toBigInt(senderPrivateKey),
      to,
      toBigInt(toPublicKey)
    );
    const subchannelId = compute_subchannel_id(channelKey, to, toBigInt(toPublicKey), token);
    assert(this.subchannelIds.has(subchannelId), () => `Token ${token} does not exist`);

    assert(
      index == 0 || this.notes.has(compute_note_id(channelKey, token, index - 1)),
      () => `Nonce ${index} is not sequential`
    );

    const noteId = compute_note_id(channelKey, token, index);

    assert(!this.notes.has(noteId), () => `Note ${noteId} already exists`);

    const noteData: EncryptedNote | OpenNote = isOpen(amount)
      ? { r: 1n, amount: 0n, token }
      : {
          packed: encryptions.encryptNoteAmount(channelKey, token, index, random, amount),
          token,
          index,
        };

    return () => {
      this.tracking.get(sender)!.channels.get(to)!.incrementNoteNonce(token);
      this.tracking
        .get(to)!
        .notes.get(token)!
        .set(noteId, {
          id: noteId,
          amount: amount as bigint,
          witness: { channelKey, nonce: index, r: random },
          sender: sender,
        });
      this.notes.set(noteId, noteData);
    };
  }

  private deposit(from: bigint, token: bigint, amount: Amount): StateCallback {
    return () => this.contracts.get(token).transfer(from, this.address, amount);
  }

  private withdraw(token: bigint, recipient: bigint, amount: Amount): StateCallback {
    return () => this.contracts.get(token).transfer(this.address, recipient, amount);
  }

  /**
   * Fill an open note with an amount (for deposits to open notes).
   */
  fillOpenNote(noteId: bigint, token: bigint, amount: Amount): void {
    const note = this.notes.get(noteId)! as OpenNote;
    assert(note, () => `Note ${hex(noteId)} does not exist`);
    assert(note.r == 1n, () => `Note ${hex(noteId)} is not open`);
    assert(note.token == token, () => `Note ${hex(noteId)} is not for token ${token}`);
    assert(note.amount == 0n, () => `Note ${hex(noteId)} has already been filled`);
    note.amount = amount;
  }

  private validateTokenTotals(sender: bigint, clientActions: ClientAction[]): void {
    const runningTotals = new Map<bigint, bigint>();

    const updateTotal = (token: bigint, delta: bigint) => {
      const current = runningTotals.get(token) ?? 0n;
      const updated = current + delta;
      assert(
        updated >= 0n,
        () => `Running total for token ${hex(token)} went negative: ${updated}`
      );
      runningTotals.set(token, updated);
    };

    for (const action of clientActions) {
      switch (action.type) {
        case "Deposit":
          // Validate amount is non-negative
          assert(
            action.input.amount >= 0n,
            () => `Deposit amount must be non-negative: ${action.input.amount}`
          );
          // If depositing to a specific noteId (open note), it doesn't affect running total
          // as it's a direct fill, not unallocated funds.
          if (!("noteId" in action.input) || action.input.noteId === undefined) {
            updateTotal(action.input.token, action.input.amount);
          }
          break;

        case "UseNote": {
          // Using a note increases available balance
          const noteData = this.getNote(
            action.input.channelKey,
            action.input.noteIndex,
            action.input.token
          );
          assert(noteData, () => `Note not found`);
          assert(!noteData.open, () => `Cannot use open note as input`);
          updateTotal(action.input.token, noteData.amount);
          break;
        }

        case "CreateNote": {
          // Creating a note decreases available balance (0 for open notes)
          const amount = action.input.amount;
          if (!isOpen(amount)) {
            assert(amount >= 0n, () => `CreateNote amount must be non-negative: ${amount}`);
            updateTotal(action.input.token, -amount);
          }
          break;
        }

        case "Withdraw":
          // Validate amount is non-negative
          assert(
            action.input.amount >= 0n,
            () => `Withdraw amount must be non-negative: ${action.input.amount}`
          );
          // Withdrawals decrease available balance
          updateTotal(action.input.token, -action.input.amount);
          break;

        default:
          // Other actions don't affect token totals
          break;
      }
    }

    // Validate all totals end at 0
    for (const [token, total] of runningTotals.entries()) {
      if (total !== 0n) {
        debugLog("pool", "validateTokenTotals", hex(token), clientActions);
      }
      assert(total === 0n, () => `Final total for token ${hex(token)} is ${total}, expected 0`);
    }
  }
}
