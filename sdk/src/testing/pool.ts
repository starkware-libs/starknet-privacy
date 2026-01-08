/**
 * Mock PrivacyPool implementation for testing.
 */

import type {
  Amount,
  Note,
  NoteId,
  Open,
  StarknetAddress,
  StarknetAddressBigint,
} from "../interfaces.js";
import { Witness } from "../interfaces.js";
import { BigNumberish } from "starknet";
import { NoteNonce } from "../internal/index.js";
import {
  hash,
  encryptChannelInfo,
  encryptSymmetric,
  decryptSymmetric,
  toBigInt,
  type ChannelKey,
  type EncChannelInfo,
  type Hash,
  type PrivateKey,
  type PublicKey,
  type SymmetricEncryption,
  derivePublicKey,
} from "../utils/crypto.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert } from "console";
import type { ERC20s } from "./erc20.js";
import { Withdrawal } from "./helpers.js";
import { hashes } from "../utils/hashes.js";
import { isOpen } from "../utils/validation.js";

/** Input type for composite operation: a token and either a Witness (to spend) or an Amount (deposit) */
export type CompositeInput = {
  token: StarknetAddress;
  witnessOrAmount: Witness | Amount;
};

/** Output type for composite operation */
export type CompositeOutput = {
  token: StarknetAddress;
  recipient: StarknetAddress;
  context: NoteNonce | typeof Withdrawal | NoteId;
  amount: Amount | Open;
};

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
  private channelExists = new Set<Hash>();
  private tokens = new Map<Hash, SymmetricEncryption>();
  private tokenExists = new Set<Hash>();
  private notes = new Map<Hash, SymmetricEncryption | OpenNote>();
  private nullifiers = new Set<Hash>();

  constructor(
    private poolAddress: StarknetAddress,
    private erc20s: ERC20s
  ) {}

  private assertRegistered(address: StarknetAddress): void {
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${address} is not registered`);
    }
  }

  isRegistered(address: StarknetAddress): boolean {
    return this.publicKeys.has(address);
  }

  getPublicKey(address: StarknetAddress): PublicKey {
    this.assertRegistered(address);
    return this.publicKeys.get(address)!;
  }

  // TODO: use 'register' with private key to simulate how it'll actually be.
  register(address: StarknetAddress, privateKey: PrivateKey): void {
    this.publicKeys.set(address, derivePublicKey(privateKey));
  }

  setChannel(from: StarknetAddress, fromPrivateKey: PrivateKey, to: StarknetAddress): ChannelKey {
    this.assertRegistered(from);
    const toPublicKey = this.getPublicKey(to);
    const channelKey = hash(from, fromPrivateKey, to, toPublicKey);
    const channelInfo = encryptChannelInfo(toPublicKey, channelKey, from);
    this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
    this.channelExists.add(hashes.channelExists(channelKey, from, to, toPublicKey));
    return channelKey;
  }

  getChannels(address: StarknetAddress): EncChannelInfo[] {
    return this.channels.get({ address: address, publicKey: this.getPublicKey(address) })!;
  }

  doesChannelExist(channelKey: BigNumberish, from: StarknetAddress, to: StarknetAddress): boolean {
    return this.channelExists.has(
      hashes.channelExists(toBigInt(channelKey), from, to, this.getPublicKey(to))
    );
  }

  setToken(
    from: StarknetAddress,
    to: StarknetAddress,
    channelKey: Hash,
    token: StarknetAddress,
    nonce: NoteNonce
  ): void {
    this.assertRegistered(from);

    assert(
      this.channelExists.has(hash(channelKey, from, to, this.getPublicKey(to))),
      `Channel does not exist between ${from} and ${to}`
    );
    assert(
      nonce.sequence == 0 || this.tokens.has(hash(channelKey, nonce.slot, nonce.sequence - 1)),
      `Nonce ${nonce} is not sequential`
    );
    const toPublicKey = this.getPublicKey(to);

    const tokenKey = hashes.tokenKey(channelKey, nonce);
    assert(!this.tokens.has(tokenKey), `Token ${token} already exists`);

    this.tokens.set(tokenKey, encryptSymmetric(channelKey, token));
    this.tokenExists.add(hashes.tokenExists(channelKey, to, toPublicKey, token));
  }

  getToken(channelKey: Hash, nonce: NoteNonce): StarknetAddressBigint | false {
    const tokenKey = hashes.tokenKey(channelKey, nonce);
    const encrypted = this.tokens.get(tokenKey);
    if (!encrypted) return false;
    return decryptSymmetric(encrypted, channelKey);
  }

  doesTokenExists(
    channelKey: BigNumberish,
    address: StarknetAddress,
    token: StarknetAddress
  ): boolean {
    return this.tokenExists.has(
      hashes.tokenExists(toBigInt(channelKey), address, this.getPublicKey(address), token)
    );
  }

  useNote(
    owner: StarknetAddress,
    ownerPrivateKey: PrivateKey,
    token: StarknetAddress,
    witness: Witness
  ): bigint {
    const ownerPublicKey = this.getPublicKey(owner);
    assert(
      this.tokenExists.has(hash(witness.channelKey, owner, ownerPublicKey, token)),
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

  createNote(
    from: StarknetAddress,
    fromPrivateKey: PrivateKey,
    to: StarknetAddress,
    token: StarknetAddress,
    nonce: NoteNonce,
    amount: Amount | Open
  ): Note {
    const channelKey = hashes.channelKey(from, fromPrivateKey, to, this.getPublicKey(to));
    const tokenKey = hashes.tokenExists(channelKey, to, this.getPublicKey(to), token);
    assert(this.tokenExists.has(tokenKey), `Token ${token} does not exist`);
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

  composite(
    from: StarknetAddress,
    fromPrivateKey: PrivateKey,
    inputs: CompositeInput[],
    outputs: CompositeOutput[]
  ) {
    const total = new AddressMap<Amount>(() => 0n);

    for (const input of inputs) {
      let amount = 0n;
      if (input.witnessOrAmount instanceof Witness) {
        amount = this.useNote(from, fromPrivateKey, input.token, input.witnessOrAmount);
      } else {
        this.erc20s.get(input.token).transfer(from, this.poolAddress, input.witnessOrAmount);
        amount = input.witnessOrAmount;
      }
      total.set(input.token, total.get(input.token)! + amount);
    }

    for (const output of outputs) {
      assert(
        !isOpen(output.amount) || output.context !== Withdrawal,
        `Can't create an open note and a withdrawal at the same time`
      );
      const amountNum = isOpen(output.amount) ? 0n : output.amount;
      total.set(output.token, total.get(output.token)! - amountNum);
      if (output.context instanceof NoteNonce) {
        this.createNote(
          from,
          fromPrivateKey,
          output.recipient,
          output.token,
          output.context,
          output.amount
        );
      } else if (output.context === Withdrawal) {
        this.erc20s
          .get(output.token)
          .transfer(this.poolAddress, output.recipient, output.amount as Amount);
      } else {
        assert(
          !isOpen(output.amount),
          `Can't create an open note and a deposit to one note at the same time`
        );
        const note = this.notes.get(toBigInt(output.context))! as OpenNote;
        assert(note, `Note ${output.context} does not exist`);
        assert(note.r == 1n, `Note ${output.context} is not open`);
        assert(
          note.token == toBigInt(output.token),
          `Note ${output.context} is not for token ${output.token}`
        );
        assert(note.amount == 0n, `Note ${output.context} has already been filled`);
        note.amount = output.amount as Amount;
      }
    }

    for (const [token, amount] of total.entries()) {
      assert(amount == 0n, `Total amount for token ${token} is not 0`);
    }
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

  getNullifier(witness: Witness, token: StarknetAddress, ownerPrivateKey: PrivateKey): boolean {
    return this.nullifiers.has(hashes.nullifier(witness, token, ownerPrivateKey));
  }
}
