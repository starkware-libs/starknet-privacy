/**
 * Mock PrivacyPool implementation for testing.
 * Consumes ClientAction[] (the unwrapped action inputs from the compiler).
 */

import type {
  Amount,
  NoteId,
  Open,
  StarknetAddress,
  StarknetAddressBigint,
} from "../interfaces.js";
import { Witness } from "../interfaces.js";
import { BigNumberish } from "starknet";
import { NoteNonce, TokenNonce } from "../internal/index.js";
import {
  encryptChannelInfo,
  encryptSymmetric,
  decryptSymmetric,
  toBigInt,
  type EncChannelInfo,
  type Hash,
  type PrivateKey as ViewingKey,
  type PublicKey,
  type SymmetricEncryption,
  derivePublicKey,
} from "../utils/crypto.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert, isOpen } from "../utils/validation.js";
import type { MockContracts, MockContract } from "./contracts.js";
import { hashes } from "../utils/hashes.js";
import type { ClientAction } from "../client-actions.js";

type OpenNote = {
  r: bigint;
  amount: Amount;
  token: StarknetAddressBigint;
};

/** Snapshot of PrivacyPool state */
export type PrivacyPoolSnapshot = {
  publicKeys: Map<bigint, PublicKey>;
  channels: Map<string, EncChannelInfo[]>;
  channelIds: Set<Hash>;
  subchannels: Map<Hash, SymmetricEncryption>;
  subchannelIds: Set<Hash>;
  notes: Map<Hash, SymmetricEncryption | OpenNote>;
  nullifiers: Set<Hash>;
};

class ChannelsMap extends AdvancedMap<
  { address: StarknetAddress; publicKey: PublicKey },
  EncChannelInfo[],
  string
> {
  constructor() {
    super({ keyConverter: (key) => `${key.address}:${key.publicKey}`, defaultFactory: () => [] });
  }
}

/** Callback that performs a state change */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StateCallback = () => any;

export class PrivacyPool implements MockContract {
  private publicKeys = new AddressMap<PublicKey>();
  private channels = new ChannelsMap();
  private channelIds = new Set<Hash>();
  private subchannels = new Map<Hash, SymmetricEncryption>();
  private subchannelIds = new Set<Hash>();
  private notes = new Map<Hash, SymmetricEncryption | OpenNote>();
  private nullifiers = new Set<Hash>();
  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: StarknetAddress,
    private contracts: MockContracts
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
    const notesSnapshot = new Map<Hash, SymmetricEncryption | OpenNote>();
    for (const [key, note] of this.notes) {
      notesSnapshot.set(key, { ...note });
    }

    return {
      publicKeys: new Map(this.publicKeys.entries()),
      channels: channelsSnapshot,
      channelIds: new Set(this.channelIds),
      subchannels: new Map(this.subchannels),
      subchannelIds: new Set(this.subchannelIds),
      notes: notesSnapshot,
      nullifiers: new Set(this.nullifiers),
    };
  }

  /** Restore pool state from a snapshot */
  restore(snapshot: PrivacyPoolSnapshot): void {
    // AdvancedMaps need clear + refill (can't replace internal map)
    this.publicKeys.clear();
    for (const [k, v] of snapshot.publicKeys) this.publicKeys.set(k, v);

    this.channels.clear();
    for (const [strKey, value] of snapshot.channels) {
      const [address, publicKey] = strKey.split(":");
      this.channels.set({ address, publicKey: BigInt(publicKey) }, value);
    }

    // Regular Maps/Sets can be replaced directly
    this.channelIds = new Set(snapshot.channelIds);
    this.subchannels = new Map(snapshot.subchannels);
    this.subchannelIds = new Set(snapshot.subchannelIds);
    this.notes = new Map(snapshot.notes);
    this.nullifiers = new Set(snapshot.nullifiers);
  }

  // ============ Public Methods ============

  isRegistered(address: StarknetAddress): boolean {
    return this.publicKeys.has(address);
  }

  getPublicKey(address: StarknetAddress): PublicKey {
    this.assertRegistered(address);
    return this.publicKeys.get(address)!;
  }

  getChannels(address: StarknetAddress): EncChannelInfo[] {
    return this.channels.get({ address: address, publicKey: this.getPublicKey(address) })!;
  }

  doesChannelExist(channelKey: BigNumberish, from: StarknetAddress, to: StarknetAddress): boolean {
    return this.channelIds.has(
      hashes.channelId(toBigInt(channelKey), from, to, this.getPublicKey(to))
    );
  }

  getToken(channelKey: Hash, nonce: TokenNonce): StarknetAddressBigint | false {
    const subchannelKey = hashes.subchannelKey(channelKey, nonce.sequence);
    const encrypted = this.subchannels.get(subchannelKey);
    if (!encrypted) return false;
    return decryptSymmetric(encrypted, channelKey);
  }

  doesSubchannelExist(
    channelKey: BigNumberish,
    address: StarknetAddress,
    token: StarknetAddress
  ): boolean {
    return this.subchannelIds.has(
      hashes.subchannelId(toBigInt(channelKey), address, this.getPublicKey(address), token)
    );
  }

  getNote(
    witness: Witness,
    token: StarknetAddress
  ): { id: NoteId; amount: Amount; open: boolean } | false {
    const noteId = hashes.noteId(witness.channelKey, token, witness.nonce.sequence);
    const note = this.notes.get(noteId);
    if (note === undefined) return false;
    if (note.r == 1n) {
      return { id: noteId, amount: (note as OpenNote).amount, open: true };
    }
    return {
      id: noteId,
      amount: decryptSymmetric(note as SymmetricEncryption, witness.channelKey),
      open: false,
    };
  }

  getNullifier(witness: Witness, token: StarknetAddress, ownerPrivateKey: ViewingKey): boolean {
    return this.nullifiers.has(
      hashes.nullifier(witness.channelKey, token, witness.nonce.sequence, ownerPrivateKey)
    );
  }

  openDeposit(noteId: NoteId, token: StarknetAddress, amount: Amount): void {
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
  execute(sender: StarknetAddress, clientActions: ClientAction[]): StateCallback[] {
    // Validate token totals before mutating state
    this.validateTokenTotals(sender, clientActions);

    const callbacks: StateCallback[] = [];

    // Process actions in order
    for (const action of clientActions) {
      let callback: StateCallback | undefined = undefined;

      switch (action.type) {
        case "SetViewingKey":
          callback = this.register(sender, action.input.privateKey);
          break;

        case "OpenChannel":
          callback = this.setChannel(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey
          );
          break;

        case "OpenSubchannel":
          callback = this.setToken(
            sender,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.channelKey,
            action.input.token,
            action.input.index
          );
          break;

        case "Deposit":
          callback = this.deposit(sender, action.input.token, action.input.amount);
          if (action.input.noteId !== undefined) {
            const noteId = action.input.noteId;
            const token = action.input.token;
            const amount = action.input.amount;
            callback = () => {
              this.openDeposit(noteId as NoteId, token, amount);
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
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.token,
            action.input.index,
            action.input.amount
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

  // ============ Private Methods ============

  private assertRegistered(address: StarknetAddress): void {
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${address} is not registered`);
    }
  }

  private register(address: StarknetAddress, privateKey: ViewingKey): StateCallback {
    const publicKey = derivePublicKey(privateKey);
    return () => this.publicKeys.set(address, publicKey);
  }

  private setChannel(
    from: StarknetAddress,
    fromPrivateKey: ViewingKey,
    to: StarknetAddress,
    toPublicKey: PublicKey
  ): StateCallback {
    this.assertRegistered(from);
    const channelKey = hashes.channelKey(from, fromPrivateKey, to, toPublicKey);
    const channelInfo = encryptChannelInfo(toPublicKey, channelKey, from);
    return () => {
      this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
      this.channelIds.add(hashes.channelId(channelKey, from, to, toPublicKey));
    };
  }

  private setToken(
    from: StarknetAddress,
    to: StarknetAddress,
    toPublicKey: PublicKey,
    channelKey: Hash,
    token: StarknetAddress,
    index: number
  ): StateCallback {
    this.assertRegistered(from);

    assert(
      this.channelIds.has(hashes.channelId(channelKey, from, to, toPublicKey)),
      `Channel does not exist between ${from} and ${to}`
    );

    assert(
      index == 0 || this.subchannels.has(hashes.subchannelKey(channelKey, index - 1)),
      `Nonce ${index} is not sequential`
    );

    const subchannelKey = hashes.subchannelKey(channelKey, index);
    assert(!this.subchannels.has(subchannelKey), `Token ${token} already exists`);

    return () => {
      this.subchannels.set(subchannelKey, encryptSymmetric(channelKey, token));
      this.subchannelIds.add(hashes.subchannelId(channelKey, to, toPublicKey, token));
    };
  }

  private useNote(
    owner: StarknetAddress,
    ownerPrivateKey: ViewingKey,
    token: StarknetAddress,
    channelKey: Hash,
    noteIndex: number
  ): StateCallback {
    const ownerPublicKey = this.getPublicKey(owner);
    assert(
      this.subchannelIds.has(hashes.subchannelId(channelKey, owner, ownerPublicKey, token)),
      `Token ${token} does not exist`
    );

    const noteId = hashes.noteId(channelKey, token, noteIndex);
    assert(this.notes.has(noteId), `Note ${noteId} does not exist`);

    const nullifier = hashes.nullifier(channelKey, token, noteIndex, ownerPrivateKey);
    assert(!this.nullifiers.has(nullifier), `Nullifier ${nullifier} already exists`);

    return () => {
      this.nullifiers.add(nullifier);
    };
  }

  private createNote(
    senderPrivateKey: ViewingKey,
    to: StarknetAddress,
    toPublicKey: PublicKey,
    token: StarknetAddress,
    index: number,
    amount: Amount | Open
  ): StateCallback {
    // Derive sender address from private key (not needed for note creation, but for validation)
    const senderPublicKey = derivePublicKey(senderPrivateKey);

    // Compute channel key using sender's private key and recipient's public key
    // Note: We need the sender address, which we can derive from the registration
    // For now, we compute channelKey directly from the provided keys
    // In a real contract, this would be verified

    // Find the sender address from the public key
    let senderAddr: StarknetAddress | undefined;
    for (const [addr, pubKey] of this.publicKeys.entries()) {
      if (pubKey === senderPublicKey) {
        senderAddr = addr;
        break;
      }
    }
    assert(senderAddr !== undefined, "Sender not registered");

    const channelKey = hashes.channelKey(senderAddr!, senderPrivateKey, to, toPublicKey);
    const subchannelId = hashes.subchannelId(channelKey, to, toPublicKey, token);
    assert(this.subchannelIds.has(subchannelId), `Token ${token} does not exist`);

    assert(
      index == 0 || this.notes.has(hashes.noteId(channelKey, token, index - 1)),
      `Nonce ${index} is not sequential`
    );

    const noteId = hashes.noteId(channelKey, token, index);

    assert(!this.notes.has(noteId), `Note ${noteId} already exists`);

    const noteData = isOpen(amount)
      ? { r: 1n, amount: 0n, token: toBigInt(token) }
      : encryptSymmetric(channelKey, amount);

    return () => {
      this.notes.set(noteId, noteData);
    };
  }

  private deposit(from: StarknetAddress, token: StarknetAddress, amount: Amount): StateCallback {
    return () => this.contracts.get(token).transfer(from, this.address, amount);
  }

  private withdraw(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount
  ): StateCallback {
    return () => this.contracts.get(token).transfer(this.address, recipient, amount);
  }

  /**
   * Fill an open note with an amount (for deposits to open notes).
   */
  fillOpenNote(noteId: NoteId, token: StarknetAddress, amount: Amount): void {
    const note = this.notes.get(toBigInt(noteId))! as OpenNote;
    assert(note, `Note ${noteId} does not exist`);
    assert(note.r == 1n, `Note ${noteId} is not open`);
    assert(note.token == toBigInt(token), `Note ${noteId} is not for token ${token}`);
    assert(note.amount == 0n, `Note ${noteId} has already been filled`);
    note.amount = amount;
  }

  private validateTokenTotals(sender: StarknetAddress, clientActions: ClientAction[]): void {
    const runningTotals = new Map<string, bigint>();

    const updateTotal = (token: StarknetAddress, delta: bigint) => {
      const tokenKey = String(toBigInt(token));
      const current = runningTotals.get(tokenKey) ?? 0n;
      const updated = current + delta;
      assert(updated >= 0n, `Running total for token ${tokenKey} went negative: ${updated}`);
      runningTotals.set(tokenKey, updated);
    };

    for (const action of clientActions) {
      switch (action.type) {
        case "Deposit":
          // Validate amount is non-negative
          assert(
            action.input.amount >= 0n,
            `Deposit amount must be non-negative: ${action.input.amount}`
          );
          // If depositing to a specific noteId (open note), it doesn't affect running total
          // as it's a direct fill, not unallocated funds.
          if (!("noteId" in action.input) || action.input.noteId === undefined) {
            updateTotal(action.input.token, action.input.amount);
          }
          break;

        case "UseNote": {
          // Using a note increases available balance
          const nonce = new NoteNonce(action.input.noteIndex);
          const witness = new Witness(action.input.channelKey, nonce);
          const noteData = this.getNote(witness, action.input.token);
          assert(noteData, `Note not found`);
          assert(!noteData.open, `Cannot use open note as input`);
          updateTotal(action.input.token, noteData.amount);
          break;
        }

        case "CreateNote": {
          // Creating a note decreases available balance (0 for open notes)
          const amount = action.input.amount;
          if (!isOpen(amount)) {
            assert(amount >= 0n, `CreateNote amount must be non-negative: ${amount}`);
            updateTotal(action.input.token, -amount);
          }
          break;
        }

        case "Withdraw":
          // Validate amount is non-negative
          assert(
            action.input.amount >= 0n,
            `Withdraw amount must be non-negative: ${action.input.amount}`
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
    for (const [tokenKey, total] of runningTotals.entries()) {
      assert(total === 0n, `Final total for token ${tokenKey} is ${total}, expected 0`);
    }
  }
}
