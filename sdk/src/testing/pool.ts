/**
 * Mock PrivacyPool implementation for testing.
 */

import type { Amount, Note, StarknetAddress, StarknetAddressBigint } from "../interfaces.js";
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
} from "../utils/crypto.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert } from "console";
import type { ERC20s } from "./erc20.js";
import { hashes } from "./helpers.js";

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
  private notes = new Map<Hash, SymmetricEncryption>();
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
  setPublicKey(address: StarknetAddress, publicKey: PublicKey): void {
    this.publicKeys.set(address, publicKey);
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
    const amount = decryptSymmetric(this.notes.get(noteId)!, witness.channelKey);
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
    amount: Amount
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
    this.notes.set(noteId, encryptSymmetric(channelKey, amount));

    return {
      id: noteId,
      amount: amount,
      witness,
      sender: from,
    };
  }

  // Symbol used as a type marker for withdrawal operations
  static readonly Withdrawal = Symbol("Withdrawal");

  composite(
    from: StarknetAddress,
    fromPrivateKey: PrivateKey,
    inputs: { token: StarknetAddress; witnessOrAmount: Witness | Amount }[],
    outputs: {
      token: StarknetAddress;
      recipient: StarknetAddress;
      nonceOrWithdrawal: NoteNonce | symbol;
      amount: Amount;
    }[]
  ) {
    const total = new Map<StarknetAddress, Amount>();

    for (const input of inputs) {
      let amount = 0n;
      if (input.witnessOrAmount instanceof Witness) {
        amount = this.useNote(from, fromPrivateKey, input.token, input.witnessOrAmount);
      } else {
        this.erc20s.get(input.token).transfer(from, this.poolAddress, input.witnessOrAmount);
        amount = input.witnessOrAmount;
      }
      total.set(input.token, (total.get(input.token) ?? 0n) + amount);
    }

    for (const output of outputs) {
      total.set(output.token, (total.get(output.token) ?? 0n) - output.amount);
      if (output.nonceOrWithdrawal instanceof NoteNonce) {
        this.createNote(
          from,
          fromPrivateKey,
          output.recipient,
          output.token,
          output.nonceOrWithdrawal,
          output.amount
        );
      } else {
        this.erc20s.get(output.token).transfer(this.poolAddress, output.recipient, output.amount);
      }
    }

    for (const [token, amount] of total.entries()) {
      assert(amount == 0n, `Total amount for token ${token} is not 0`);
    }
  }

  getNote(witness: Witness, token: StarknetAddress): Amount | false {
    const noteId = hashes.noteId(new Witness(witness.channelKey, witness.nonce), token);
    const encrypted = this.notes.get(noteId);
    return encrypted ? decryptSymmetric(encrypted, witness.channelKey) : false;
  }

  getNullifier(witness: Witness, token: StarknetAddress, ownerPrivateKey: PrivateKey): boolean {
    return this.nullifiers.has(hashes.nullifier(witness, token, ownerPrivateKey));
  }
}
