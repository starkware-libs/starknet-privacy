/**
 * Mock PrivacyPool implementation for testing.
 * Consumes ClientAction[] (the unwrapped action inputs from the compiler).
 */

import type {
  Amount,
  Note,
  NoteId,
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
  type ChannelKey,
  type EncChannelInfo,
  type Hash,
  type PrivateKey as ViewingKey,
  type PublicKey,
  type SymmetricEncryption,
  derivePublicKey,
} from "../utils/crypto.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert } from "../utils/validation.js";
import type { ERC20s } from "./erc20.js";
import { hashes } from "../utils/hashes.js";
import type { ClientAction } from "../client-actions.js";

type OpenNote = {
  r: bigint;
  amount: Amount;
  token: StarknetAddressBigint;
};

export class PrivacyPool {
  private publicKeys = new AddressMap<PublicKey>();
  private channels = new AdvancedMap<
    { address: StarknetAddress; publicKey: PublicKey },
    EncChannelInfo[],
    string
  >({
    keyConverter: (key) => `${key.address}:${key.publicKey}`,
    defaultFactory: () => [],
  });
  private channelIds = new Set<Hash>();
  private subchannels = new Map<Hash, SymmetricEncryption>();
  private subchannelIds = new Set<Hash>();
  private notes = new Map<Hash, SymmetricEncryption | OpenNote>();
  private nullifiers = new Set<Hash>();

  constructor(
    private poolAddress: StarknetAddress,
    private erc20s: ERC20s
  ) {}

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
    const subchannelKey = hashes.subchannelKey(channelKey, nonce);
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

  getNote(witness: Witness, token: StarknetAddress): { amount: Amount; open: boolean } | false {
    const noteId = hashes.noteId(new Witness(witness.channelKey, witness.nonce), token);
    const note = this.notes.get(noteId);
    if (note === undefined) return false;
    if (note.r == 1n) {
      return { amount: (note as OpenNote).amount, open: true };
    }
    return {
      amount: decryptSymmetric(note as SymmetricEncryption, witness.channelKey),
      open: false,
    };
  }

  getNullifier(witness: Witness, token: StarknetAddress, ownerPrivateKey: ViewingKey): boolean {
    return this.nullifiers.has(hashes.nullifier(witness, token, ownerPrivateKey));
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
   * @param sender The sender's address
   * @param clientActions The array of client action inputs from the compiler
   */
  execute(sender: StarknetAddress, clientActions: ClientAction[]): void {
    // Validate token totals before mutating state
    this.validateTokenTotals(sender, clientActions);

    // Process actions in order
    for (const action of clientActions) {
      switch (action.type) {
        case "SetViewingKey":
          this.register(sender, action.input.privateKey);
          break;

        case "OpenChannel":
          this.setChannel(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey
          );
          break;

        case "OpenSubchannel":
          this.setToken(
            sender,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.channelKey,
            action.input.token,
            action.input.index
          );
          break;

        case "Deposit":
          this.deposit(sender, action.input.token, action.input.amount);
          // If depositing to an open note, fill it
          if (action.input.noteId) {
            this.fillOpenNote(action.input.noteId, action.input.token, action.input.amount);
          }
          break;

        case "UseNote":
          this.useNote(
            sender,
            action.input.ownerPrivateKey,
            action.input.token,
            action.input.channelKey,
            action.input.noteIndex
          );
          break;

        case "CreateNote":
          this.createNote(
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.token,
            action.input.index,
            action.input.amount
          );
          break;

        case "Withdraw":
          this.withdraw(action.input.token, action.input.withdrawalTarget, action.input.amount);
          break;
      }
    }
  }

  // ============ Private Methods ============

  private assertRegistered(address: StarknetAddress): void {
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${address} is not registered`);
    }
  }

  private register(address: StarknetAddress, privateKey: ViewingKey): void {
    this.publicKeys.set(address, derivePublicKey(privateKey));
  }

  private setChannel(
    from: StarknetAddress,
    fromPrivateKey: ViewingKey,
    to: StarknetAddress,
    toPublicKey: PublicKey
  ): ChannelKey {
    this.assertRegistered(from);
    const channelKey = hashes.channelKey(from, fromPrivateKey, to, toPublicKey);
    const channelInfo = encryptChannelInfo(toPublicKey, channelKey, from);
    this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
    this.channelIds.add(hashes.channelId(channelKey, from, to, toPublicKey));
    return channelKey;
  }

  private setToken(
    from: StarknetAddress,
    to: StarknetAddress,
    toPublicKey: PublicKey,
    channelKey: Hash,
    token: StarknetAddress,
    index: number
  ): void {
    this.assertRegistered(from);

    assert(
      this.channelIds.has(hashes.channelId(channelKey, from, to, toPublicKey)),
      `Channel does not exist between ${from} and ${to}`
    );

    const nonce = new TokenNonce(index);
    assert(
      nonce.sequence == 0 ||
        this.subchannels.has(hashes.subchannelKey(channelKey, nonce.decrement())),
      `Nonce ${nonce.sequence} is not sequential`
    );

    const subchannelKey = hashes.subchannelKey(channelKey, nonce);
    assert(!this.subchannels.has(subchannelKey), `Token ${token} already exists`);

    this.subchannels.set(subchannelKey, encryptSymmetric(channelKey, token));
    this.subchannelIds.add(hashes.subchannelId(channelKey, to, toPublicKey, token));
  }

  private useNote(
    owner: StarknetAddress,
    ownerPrivateKey: ViewingKey,
    token: StarknetAddress,
    channelKey: Hash,
    noteIndex: number
  ): bigint {
    const ownerPublicKey = this.getPublicKey(owner);
    assert(
      this.subchannelIds.has(hashes.subchannelId(channelKey, owner, ownerPublicKey, token)),
      `Token ${token} does not exist`
    );

    const nonce = new NoteNonce(noteIndex);
    const witness = new Witness(channelKey, nonce);
    const noteId = hashes.noteId(witness, token);
    const note = this.notes.get(noteId)!;
    if (note.r == 1n) {
      // note is open, get amount as is
      return (note as OpenNote).amount;
    }
    const amount = decryptSymmetric(note as SymmetricEncryption, channelKey);
    assert(amount == amount, `Note amount does not match`);

    const nullifier = hashes.nullifier(witness, token, ownerPrivateKey);

    assert(!this.nullifiers.has(nullifier), `Nullifier ${nullifier} already exists`);
    this.nullifiers.add(nullifier);

    return amount;
  }

  private createNote(
    senderPrivateKey: ViewingKey,
    to: StarknetAddress,
    toPublicKey: PublicKey,
    token: StarknetAddress,
    index: number,
    amount: Amount
  ): Note {
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

    const nonce = new NoteNonce(index);
    assert(
      nonce.sequence == 0 ||
        this.notes.has(hashes.noteId(new Witness(channelKey, nonce.decrement()), token)),
      `Nonce ${nonce.sequence} is not sequential`
    );

    const witness = new Witness(channelKey, nonce);
    const noteId = hashes.noteId(witness, token);

    assert(!this.notes.has(noteId), `Note ${noteId} already exists`);

    // Amount of 0 indicates an open note
    const isOpenNote = amount === 0n;
    const noteData = isOpenNote
      ? { r: 1n, amount: 0n, token: toBigInt(token) }
      : encryptSymmetric(channelKey, amount);

    this.notes.set(noteId, noteData);

    return {
      id: noteId,
      amount: amount,
      witness,
      sender: senderAddr!,
      open: isOpenNote,
    };
  }

  private deposit(from: StarknetAddress, token: StarknetAddress, amount: Amount): void {
    this.erc20s.get(token).transfer(from, this.poolAddress, amount);
  }

  private withdraw(token: StarknetAddress, recipient: StarknetAddress, amount: Amount): void {
    this.erc20s.get(token).transfer(this.poolAddress, recipient, amount);
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
          // Regular deposits add to available balance (consumed by CreateNote)
          // Deposits to open notes (with noteId) fill an existing note - balanced internally
          if (!action.input.noteId) {
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
          if (amount > 0n) {
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
