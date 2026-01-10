/**
 * Mock PrivacyPool implementation for testing.
 */

import type {
  Amount,
  CreateNoteAction,
  DepositAction,
  Note,
  NoteId,
  Open,
  OpenChannelAction,
  OpenTokenChannelAction,
  SetViewingKeyAction,
  StarknetAddress,
  StarknetAddressBigint,
  UseNoteAction,
  WithdrawAction,
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
import { assert, isOpen } from "../utils/validation.js";
import type { ERC20s } from "./erc20.js";
import { hashes } from "../utils/hashes.js";

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

  execute(
    sender: StarknetAddress,
    senderViewingKey: ViewingKey,
    actions: {
      setViewingKey?: SetViewingKeyAction;
      openChannels?: OpenChannelAction[];
      openTokenChannels?: OpenTokenChannelAction[];
      deposits?: DepositAction[];
      useNotes?: UseNoteAction[];
      createNotes?: CreateNoteAction[];
      withdraws?: WithdrawAction[];
    }
  ) {
    // Validate before mutating any state
    this.validateTokenTotals(actions);

    // 1. Register user if setViewingKey is requested
    if (actions.setViewingKey) {
      this.register(sender, senderViewingKey);
    }

    // 2. Open channels for recipients
    if (actions.openChannels) {
      for (const action of actions.openChannels) {
        this.setChannel(sender, senderViewingKey, action.recipient);
      }
    }

    // 3. Open token channels
    if (actions.openTokenChannels) {
      for (const action of actions.openTokenChannels) {
        const channel = action.context;
        const nonce = channel.incrementTokenNonce();
        this.setToken(sender, action.recipient, channel.key, action.token, nonce);
      }
    }

    // 4. Execute operations directly

    // Process deposits: transfer to pool, then create note or fill open note
    if (actions.deposits) {
      for (const action of actions.deposits) {
        this.deposit(sender, action.token, action.amount);

        if (action.context) {
          // Normal deposit: create a new note
          const nonce = action.context.incrementNoteNonce(action.token);
          this.createNote(
            sender,
            senderViewingKey,
            action.recipient,
            action.token,
            nonce,
            action.amount
          );
        } else {
          // Deposit to existing open note
          this.fillOpenNote(action.recipient as NoteId, action.token, action.amount);
        }
      }
    }

    // Process useNotes: spend notes (marks nullifier)
    if (actions.useNotes) {
      for (const action of actions.useNotes) {
        this.useNote(sender, senderViewingKey, action.token, action.note.witness);
      }
    }

    // Process createNotes: create new notes for recipients
    if (actions.createNotes) {
      for (const action of actions.createNotes) {
        const nonce = action.context.incrementNoteNonce(action.token);
        this.createNote(
          sender,
          senderViewingKey,
          action.recipient,
          action.token,
          nonce,
          action.amount
        );
      }
    }

    // Process withdraws: transfer from pool to recipient
    if (actions.withdraws) {
      for (const action of actions.withdraws) {
        this.withdraw(action.token, action.recipient, action.amount);
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
    to: StarknetAddress
  ): ChannelKey {
    this.assertRegistered(from);
    const toPublicKey = this.getPublicKey(to);
    const channelKey = hashes.channelKey(from, fromPrivateKey, to, toPublicKey);
    const channelInfo = encryptChannelInfo(toPublicKey, channelKey, from);
    this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
    this.channelIds.add(hashes.channelId(channelKey, from, to, toPublicKey));
    return channelKey;
  }

  private setToken(
    from: StarknetAddress,
    to: StarknetAddress,
    channelKey: Hash,
    token: StarknetAddress,
    nonce: TokenNonce
  ): void {
    this.assertRegistered(from);

    assert(
      this.channelIds.has(hashes.channelId(channelKey, from, to, this.getPublicKey(to))),
      `Channel does not exist between ${from} and ${to}`
    );
    assert(
      nonce.sequence == 0 ||
        this.subchannels.has(hashes.subchannelKey(channelKey, nonce.decrement())),
      `Nonce ${nonce} is not sequential`
    );
    const toPublicKey = this.getPublicKey(to);

    const subchannelKey = hashes.subchannelKey(channelKey, nonce);
    assert(!this.subchannels.has(subchannelKey), `Token ${token} already exists`);

    this.subchannels.set(subchannelKey, encryptSymmetric(channelKey, token));
    this.subchannelIds.add(hashes.subchannelId(channelKey, to, toPublicKey, token));
  }

  private useNote(
    owner: StarknetAddress,
    ownerPrivateKey: ViewingKey,
    token: StarknetAddress,
    witness: Witness
  ): bigint {
    const ownerPublicKey = this.getPublicKey(owner);
    assert(
      this.subchannelIds.has(hashes.subchannelId(witness.channelKey, owner, ownerPublicKey, token)),
      `Token ${token} does not exist`
    );
    const noteId = hashes.noteId(witness, token);
    const note = this.notes.get(noteId)!;
    if (note.r == 1n) {
      // note is open, get amount as is
      return (note as OpenNote).amount;
    }
    const amount = decryptSymmetric(note as SymmetricEncryption, witness.channelKey);
    assert(amount == amount, `Note amount does not match`);

    const nullifier = hashes.nullifier(witness, token, ownerPrivateKey);

    assert(!this.nullifiers.has(nullifier), `Nullifier ${nullifier} already exists`);
    this.nullifiers.add(nullifier);

    return amount;
  }

  private createNote(
    from: StarknetAddress,
    fromPrivateKey: ViewingKey,
    to: StarknetAddress,
    token: StarknetAddress,
    nonce: NoteNonce,
    amount: Amount | Open
  ): Note {
    const channelKey = hashes.channelKey(from, fromPrivateKey, to, this.getPublicKey(to));
    const subchannelId = hashes.subchannelId(channelKey, to, this.getPublicKey(to), token);
    assert(this.subchannelIds.has(subchannelId), `Token ${token} does not exist`);
    assert(
      nonce.sequence == 0 ||
        this.notes.has(hashes.noteId(new Witness(channelKey, nonce.decrement()), token)),
      `Nonce ${nonce} is not sequential`
    );

    const witness = new Witness(channelKey, nonce);
    const noteId = hashes.noteId(witness, token);

    assert(!this.notes.has(noteId), `Note ${noteId} already exists`);
    const note = isOpen(amount)
      ? { r: 1n, amount: 0n, token: toBigInt(token) }
      : encryptSymmetric(channelKey, amount);

    this.notes.set(noteId, note);

    return {
      id: noteId,
      amount: isOpen(amount) ? 0n : amount,
      witness,
      sender: from,
      open: isOpen(amount),
    };
  }

  private deposit(from: StarknetAddress, token: StarknetAddress, amount: Amount): void {
    this.erc20s.get(token).transfer(from, this.poolAddress, amount);
  }

  private withdraw(token: StarknetAddress, recipient: StarknetAddress, amount: Amount): void {
    this.erc20s.get(token).transfer(this.poolAddress, recipient, amount);
  }

  private fillOpenNote(noteId: NoteId, token: StarknetAddress, amount: Amount): void {
    const note = this.notes.get(toBigInt(noteId))! as OpenNote;
    assert(note, `Note ${noteId} does not exist`);
    assert(note.r == 1n, `Note ${noteId} is not open`);
    assert(note.token == toBigInt(token), `Note ${noteId} is not for token ${token}`);
    assert(note.amount == 0n, `Note ${noteId} has already been filled`);
    note.amount = amount;
  }

  private validateTokenTotals(actions: {
    deposits?: DepositAction[];
    useNotes?: UseNoteAction[];
    createNotes?: CreateNoteAction[];
    withdraws?: WithdrawAction[];
  }): void {
    const runningTotals = new Map<string, bigint>();

    const updateTotal = (token: StarknetAddress, delta: bigint) => {
      const tokenKey = String(toBigInt(token));
      const current = runningTotals.get(tokenKey) ?? 0n;
      const updated = current + delta;
      assert(updated >= 0n, `Running total for token ${tokenKey} went negative: ${updated}`);
      runningTotals.set(tokenKey, updated);
    };

    // Deposits are balanced: money in, then note created (net 0)
    // No validation needed for deposits - they're self-balancing

    // Using notes increases total
    if (actions.useNotes) {
      for (const use of actions.useNotes) {
        const noteData = this.getNote(use.note.witness, use.token);
        assert(noteData, `Note not found`);
        assert(!noteData.open, `Cannot use open note as input`);
        updateTotal(use.token, noteData.amount);
      }
    }

    // Creating notes decreases total (open notes count as 0)
    if (actions.createNotes) {
      for (const create of actions.createNotes) {
        const amount = isOpen(create.amount) ? 0n : create.amount;
        updateTotal(create.token, -amount);
      }
    }

    // Withdrawals decrease total
    if (actions.withdraws) {
      for (const withdraw of actions.withdraws) {
        updateTotal(withdraw.token, -withdraw.amount);
      }
    }

    // Validate all totals end at 0
    for (const [tokenKey, total] of runningTotals.entries()) {
      assert(total === 0n, `Final total for token ${tokenKey} is ${total}, expected 0`);
    }
  }
}
