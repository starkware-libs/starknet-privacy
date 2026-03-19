/**
 * MockPoolContract - Mock implementation of the privacy pool contract.
 *
 * This class provides:
 * 1. View methods with bigint params (matching Cairo contract felts)
 * 2. compile_actions() returns MockServerAction[] for state mutations
 * 3. apply_actions() applies the mutations
 * 4. snapshot()/restore() for validation pattern
 */

import type { Amount, Note, StarknetAddressBigint } from "../interfaces.js";
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
import { encryptions } from "../utils/encryptions.js";
import type {
  PoolContractInterface,
  EncChannelInfo,
  EncSubchannelInfo,
  EncOutgoingChannelInfo,
  EncPrivateKey,
} from "../internal/pool-contract-interface.js";
import { AdvancedMap, AddressMap } from "../utils/maps.js";
import { assert, isOpen } from "../utils/validation.js";
import type { MockContracts, MockContract } from "./contracts.js";
import {
  compute_channel_key,
  compute_channel_marker,
  compute_subchannel_id,
  compute_subchannel_marker,
  compute_note_id,
  compute_nullifier,
  compute_outgoing_channel_id,
} from "../utils/hashes.js";

import { toHex } from "../utils/convert.js";
import { ClientAction } from "../internal/client-actions.js";

type OpenNote = {
  r: bigint;
  amount: Amount;
  token: StarknetAddressBigint;
};

type MockServerAction = {
  /** Action type for debugging/logging (e.g., "WriteIfZero", "AppendToVec") */
  type: string;
  /** Closure that performs the state mutation */
  apply: () => void;
  /** actions that shouldn't be applied in the private side */
  deferred?: boolean;
};

type EncryptedNote = { packed: bigint; token: StarknetAddressBigint; index: number };

export type MockPoolContractSnapshot = {
  publicKeys: Map<StarknetAddressBigint, PublicKey>;
  channels: Map<string, EncChannelInfo[]>;
  channelMarkers: Set<Hash>;
  subchannels: Map<Hash, EncSubchannelInfo>;
  subchannelMarkers: Set<Hash>;
  notes: Map<Hash, EncryptedNote | OpenNote>;
  nullifiers: Set<Hash>;
  outgoingChannels: Map<bigint, EncOutgoingChannelInfo>;
};

class ChannelsMap extends AdvancedMap<
  { address: StarknetAddressBigint; publicKey: PublicKey },
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

export class MockPoolContract implements MockContract, PoolContractInterface {
  private publicKeys = new AddressMap<PublicKey>();
  private channels = new ChannelsMap();
  private channelMarkers = new Set<Hash>();
  private subchannels = new Map<Hash, EncSubchannelInfo>();
  private subchannelMarkers = new Set<Hash>();
  private notes = new Map<Hash, EncryptedNote | OpenNote>();
  private nullifiers = new Set<Hash>();
  private outgoingChannels = new Map<bigint, EncOutgoingChannelInfo>();
  private outgoingChannelCounters = new AddressMap<number>(() => 0);

  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: StarknetAddressBigint,
    private contracts: MockContracts,
    private validateBalances: boolean = true,
    private serverActions: MockServerAction[] = []
  ) {}

  // ============ View Methods (bigint params, matching Cairo contract) ============

  is_registered(address: StarknetAddressBigint): boolean {
    return this.publicKeys.has(address);
  }

  get_public_key(userAddr: StarknetAddressBigint): bigint {
    return this.publicKeys.has(userAddr) ? toBigInt(this.publicKeys.get(userAddr)!) : 0n;
  }

  get_num_of_channels(recipientAddr: StarknetAddressBigint): bigint {
    if (!this.publicKeys.has(recipientAddr)) return 0n;
    const pk = this.publicKeys.get(recipientAddr)!;
    return BigInt(this.channels.get({ address: recipientAddr, publicKey: pk })?.length ?? 0);
  }

  get_channel_info(recipientAddr: StarknetAddressBigint, index: number): EncChannelInfo {
    const pk = this.publicKeys.get(recipientAddr)!;
    const channelList = this.channels.get({ address: recipientAddr, publicKey: pk }) ?? [];
    return channelList[index] ?? { ephemeral_pubkey: 0n, enc_channel_key: 0n, enc_sender_addr: 0n };
  }

  get_subchannel_info(subchannelId: bigint): EncSubchannelInfo {
    return this.subchannels.get(subchannelId) ?? { salt: 0n, enc_token: 0n };
  }

  get_outgoing_channel_info(outgoingChannelId: bigint): EncOutgoingChannelInfo {
    return this.outgoingChannels.get(outgoingChannelId) ?? { salt: 0n, enc_recipient_addr: 0n };
  }

  get_note(noteId: bigint): {
    packed_value: bigint;
    token: StarknetAddressBigint;
  } {
    const note = this.notes.get(noteId);
    if (!note) return { packed_value: 0n, token: 0n };
    if ("packed" in note) {
      // Encrypted note: token is zero in the Note struct (privacy)
      return { packed_value: note.packed, token: 0n };
    }
    // Open note: packed_value = (OPEN_NOTE_SALT << 128) | amount, token is non-zero
    const OPEN_NOTE_SALT = 1n;
    const packedValue = (OPEN_NOTE_SALT << 128n) | (note.amount as bigint);
    return { packed_value: packedValue, token: note.token };
  }

  channel_exists(channelMarker: bigint): boolean {
    return this.channelMarkers.has(channelMarker);
  }

  nullifier_exists(nullifier: bigint): boolean {
    return this.nullifiers.has(nullifier);
  }

  subchannel_exists(subchannelMarker: bigint): boolean {
    return this.subchannelMarkers.has(subchannelMarker);
  }

  get_enc_private_key(_userAddr: StarknetAddressBigint): EncPrivateKey {
    // Mock doesn't store encrypted private keys
    return { auditor_public_key: 0n, ephemeral_pubkey: 0n, enc_private_key: 0n };
  }

  get_auditor_public_key(): bigint {
    // Mock returns dummy auditor key
    return 1n;
  }

  get_fee_amount(): bigint | number {
    return 0n;
  }

  get_fee_collector(): bigint {
    return 0n;
  }

  get_proof_validity_blocks(): bigint | number {
    return 450n;
  }

  // ============ Helper Methods for Discovery ============

  /**
   * Get all encrypted channel info for a recipient.
   */
  get_channels(address: StarknetAddressBigint): EncChannelInfo[] {
    const pk = this.publicKeys.get(address);
    if (!pk) return [];
    return this.channels.get({ address, publicKey: pk }) ?? [];
  }

  /**
   * Check if channel exists between two addresses.
   */
  does_channel_exist(
    channelKey: bigint,
    from: StarknetAddressBigint,
    to: StarknetAddressBigint
  ): boolean {
    const toPublicKey = this.publicKeys.get(to);
    if (!toPublicKey) return false;
    return this.channelMarkers.has(
      compute_channel_marker(channelKey, from, to, toBigInt(toPublicKey))
    );
  }

  /**
   * Get decrypted token from subchannel.
   * Returns false if subchannel doesn't exist.
   */
  get_token(channelKey: Hash, nonce: number): StarknetAddressBigint | false {
    const subchannelId = compute_subchannel_id(channelKey, nonce);
    const encrypted = this.subchannels.get(subchannelId);
    if (!encrypted) return false;
    return encryptions.decryptSubchannelInfo(encrypted, channelKey, nonce).token;
  }

  /**
   * Get decrypted note data.
   * Returns false if note doesn't exist.
   */
  get_decrypted_note(
    channelKey: ChannelKey,
    index: number,
    token: StarknetAddressBigint
  ): { id: bigint; amount: Amount; r: bigint; open: boolean } | false {
    const noteId = compute_note_id(channelKey, token, index);
    const note = this.notes.get(noteId);
    if (note === undefined) return false;
    if ("r" in note && note.r == 1n) {
      return { id: noteId, amount: (note as OpenNote).amount, r: 1n, open: true };
    }
    const packed = note as { packed: bigint; token: StarknetAddressBigint; index: number };
    const { amount, salt } = encryptions.decryptNoteAmount(
      packed.packed,
      channelKey,
      packed.token,
      packed.index
    );
    return { id: noteId, amount, r: salt, open: false };
  }

  /**
   * Check if nullifier exists for a given witness.
   */
  has_nullifier(witness: Witness, token: StarknetAddressBigint, privateKey: ViewingKey): boolean {
    return this.nullifiers.has(
      compute_nullifier(witness.channelKey, token, witness.nonce, toBigInt(privateKey))
    );
  }

  // ============ Execute Methods ============

  /**
   * Execute client actions and return MockServerAction[] that can be replayed.
   * This is a "view" function - pool state changes are rolled back after execution.
   *
   * Pool-state actions are applied temporarily (required for assertions in subsequent
   * actions), then state is restored. Externally-modifying actions (Deposit, Withdraw,
   * InvokeExternal) are deferred and only applied when callbacks are replayed.
   *
   * Validates token totals if validateBalances is true.
   */
  compile_actions(
    sender: StarknetAddressBigint,
    privateKey: bigint,
    clientActions: ClientAction[]
  ): MockServerAction[] {
    if (this.validateBalances) {
      this.validateTokenTotals(sender, clientActions);
    }

    const snapshot = this.snapshot();
    const serverActions: MockServerAction[] = [];

    try {
      for (const action of clientActions) {
        const actions = this.execute_action(sender, privateKey, action);
        // Apply pool-state actions immediately (required for assertions in subsequent actions)
        // Defer ERC20-modifying actions - only applied during replay
        for (const serverAction of actions) {
          if (!serverAction.deferred) {
            serverAction.apply();
          }
          serverActions.push(serverAction);
        }
      }
    } finally {
      // Restore pool state - this is a view function
      this.restore(snapshot);
    }

    return serverActions;
  }

  /**
   * Apply server actions to mutate state.
   */
  apply_actions(actions: string[]): void {
    for (let i = 0; i < actions.length; i++) {
      assert(
        this.serverActions[i].type == actions[i],
        () => `Server action ${actions[i]} does not match expected ${this.serverActions[i].type}`
      );
      this.serverActions[i].apply();
    }
    this.serverActions = [];
  }

  /**
   * Returns MockServerAction[] that have already been applied.
   */
  execute(
    sender: StarknetAddressBigint,
    privateKey: bigint,
    ...clientActions: ClientAction[]
  ): string[] {
    const actions = this.compile_actions(sender, privateKey, clientActions);
    this.serverActions = actions;
    return this.serverActions.map((action) => action.type);
  }

  /**
   *
   * @param from  since there's no support for getting the caller address, need an explicit parameter
   */

  openDeposit(noteId: bigint, token: bigint, amount: Amount, from: StarknetAddressBigint): void {
    this.contracts.get(token).transfer(from, this.address, amount);
    const note = this.notes.get(noteId)! as OpenNote;
    assert(note, () => `Note ${toHex(noteId)} does not exist`);
    assert(note.r == 1n, () => `Note ${toHex(noteId)} is not open`);
    assert(note.token == token, () => `Note ${toHex(noteId)} is not for token ${token}`);
    assert(note.amount == 0n, () => `Note ${toHex(noteId)} has already been filled`);
    note.amount = amount;
  }

  // ============ Setup Methods (for compiler) ============

  setupChannel(
    userAddress: StarknetAddressBigint,
    viewingKey: ViewingKey,
    address: StarknetAddressBigint,
    index: number,
    channel: Channel
  ): void {
    this.publicKeys.set(address, channel.publicKey);

    if (!channel.key) return;

    this.setChannel(
      userAddress,
      viewingKey,
      address,
      channel.publicKey,
      index,
      generateRandom()
    ).apply();

    for (const [token, nonces] of channel.tokens.entries()) {
      this.setToken(
        userAddress,
        address,
        channel.publicKey,
        channel.key,
        token,
        nonces.tokenIndex,
        generateRandom()
      ).apply();

      if (nonces.noteNonce > 0) {
        this.notes.set(compute_note_id(channel.key, token, nonces.noteNonce - 1), {
          r: 1n,
          amount: 0n,
          token,
        });
      }
    }
  }

  setupNote(userAddress: StarknetAddressBigint, note: Note, token: StarknetAddressBigint) {
    this.subchannelMarkers.add(
      compute_subchannel_marker(
        note.witness.channelKey,
        userAddress,
        this.get_public_key(userAddress),
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
  }

  // ============ Snapshot/Restore ============

  snapshot(): MockPoolContractSnapshot {
    const channelsSnapshot = new Map<string, EncChannelInfo[]>();
    for (const [key, arr] of this.channels.entries()) {
      channelsSnapshot.set(key, [...arr]);
    }

    const notesSnapshot = new Map<Hash, EncryptedNote | OpenNote>();
    for (const [key, note] of this.notes) {
      notesSnapshot.set(key, { ...note });
    }

    return {
      publicKeys: new Map(this.publicKeys.entries()),
      channels: channelsSnapshot,
      channelMarkers: new Set(this.channelMarkers),
      subchannels: new Map(this.subchannels),
      subchannelMarkers: new Set(this.subchannelMarkers),
      notes: notesSnapshot,
      nullifiers: new Set(this.nullifiers),
      outgoingChannels: new Map(this.outgoingChannels),
    };
  }

  restore(snapshot: unknown): void {
    const s = snapshot as MockPoolContractSnapshot;

    this.publicKeys.clear();
    for (const [k, v] of s.publicKeys) this.publicKeys.set(k, v);

    this.channels.clear();
    for (const [strKey, value] of s.channels) {
      const [address, publicKey] = strKey.split(":");
      this.channels.set({ address: toBigInt(address), publicKey: toBigInt(publicKey) }, value);
    }

    this.channelMarkers = new Set(s.channelMarkers);
    this.subchannels = new Map(s.subchannels);
    this.subchannelMarkers = new Set(s.subchannelMarkers);
    this.notes = new Map(s.notes);
    this.nullifiers = new Set(s.nullifiers);
    this.outgoingChannels = new Map(s.outgoingChannels);
  }

  // ============ Private Methods ============

  private assertRegistered(address: StarknetAddressBigint): void {
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${toHex(address)} is not registered`);
    }
  }

  private execute_action(
    sender: StarknetAddressBigint,
    privateKey: bigint,
    action: ClientAction
  ): MockServerAction[] {
    switch (action.type) {
      case "SetViewingKey":
        return [this.register(sender, privateKey, action.input.random)];

      case "OpenChannel": {
        const recipientPublicKey = this.publicKeys.get(action.input.recipient_addr);
        assert(
          recipientPublicKey !== undefined,
          () => `Recipient ${toHex(action.input.recipient_addr)} not registered — no public key`
        );
        return [
          this.setChannel(
            sender,
            privateKey,
            action.input.recipient_addr,
            recipientPublicKey,
            action.input.index,
            action.input.random
          ),
        ];
      }

      case "OpenSubchannel":
        return [
          this.setToken(
            sender,
            action.input.recipient_addr,
            action.input.recipient_public_key,
            action.input.channel_key,
            action.input.token,
            action.input.index,
            action.input.salt
          ),
        ];

      case "Deposit": {
        return [this.deposit(sender, action.input.token, action.input.amount)];
      }

      case "UseNote":
        return [
          this.useNote(
            sender,
            privateKey,
            action.input.token,
            action.input.channel_key,
            action.input.index
          ),
        ];

      case "CreateEncNote":
        return [
          this.createEncNote(
            sender,
            privateKey,
            action.input.recipient_addr,
            action.input.recipient_public_key,
            action.input.token,
            action.input.index,
            action.input.amount,
            action.input.salt
          ),
        ];

      case "CreateOpenNote":
        return [
          this.createOpenNote(
            sender,
            privateKey,
            action.input.recipient_addr,
            action.input.recipient_public_key,
            action.input.token,
            action.input.index
          ),
        ];

      case "Withdraw":
        return [this.withdraw(action.input.token, action.input.to_addr, action.input.amount)];

      case "InvokeExternal":
        return [this.invoke(action.input.contract_address, action.input.calldata as bigint[])];

      default:
        throw new Error(`Unsupported action type in mock: ${(action as ClientAction).type}`);
    }
  }

  private register(
    address: StarknetAddressBigint,
    privateKey: ViewingKey,
    _random: bigint
  ): MockServerAction {
    const publicKey = derivePublicKey(privateKey);
    return {
      type: "SetViewingKey",
      apply: () => {
        // Matches Cairo's to_write_once_action - fails if public key already set
        assert(!this.publicKeys.has(address), () => `User ${toHex(address)} already registered`);
        this.publicKeys.set(address, publicKey);
      },
    };
  }

  private setChannel(
    from: StarknetAddressBigint,
    fromPrivateKey: ViewingKey,
    to: StarknetAddressBigint,
    toPublicKey: PublicKey,
    index: number,
    random: bigint
  ): MockServerAction {
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

    assert(index >= 0, () => `Outgoing channel index must be non-negative: ${index}`);
    if (index > 0) {
      const prevOutgoingChannelId = compute_outgoing_channel_id(
        from,
        toBigInt(fromPrivateKey),
        index - 1
      );
      assert(
        this.outgoingChannels.has(prevOutgoingChannelId),
        () => `Outgoing channel index ${index} is not sequential for sender ${toHex(from)}`
      );
    }
    const outgoingChannelId = compute_outgoing_channel_id(from, toBigInt(fromPrivateKey), index);
    const outgoingSalt = generateRandom();
    const encOutgoingChannelInfo = encryptions.encryptOutgoingChannelInfo(
      from,
      toBigInt(fromPrivateKey),
      index,
      to,
      outgoingSalt
    );

    const channelMarker = compute_channel_marker(channelKey, from, to, toBigInt(toPublicKey));

    return {
      type: "OpenChannel",
      apply: () => {
        // Matches Cairo's WriteOnce for channel_exists - fails if channel already exists
        assert(
          !this.channelMarkers.has(channelMarker),
          () => `Channel ${toHex(channelMarker)} already exists`
        );
        this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
        this.channelMarkers.add(channelMarker);
        this.outgoingChannels.set(outgoingChannelId, encOutgoingChannelInfo);
      },
    };
  }

  private setToken(
    from: StarknetAddressBigint,
    to: StarknetAddressBigint,
    toPublicKey: PublicKey,
    channelKey: Hash,
    token: StarknetAddressBigint,
    index: number,
    random: bigint
  ): MockServerAction {
    this.assertRegistered(from);

    assert(
      this.channelMarkers.has(compute_channel_marker(channelKey, from, to, toBigInt(toPublicKey))),
      () => `Channel does not exist between ${from} and ${to}`
    );

    assert(
      index == 0 || this.subchannels.has(compute_subchannel_id(channelKey, index - 1)),
      () => `Nonce ${index} is not sequential`
    );

    const subchannelId = compute_subchannel_id(channelKey, index);
    assert(!this.subchannels.has(subchannelId), () => `Token ${toHex(token)} already exists`);

    const subchannelMarker = compute_subchannel_marker(
      channelKey,
      to,
      toBigInt(toPublicKey),
      token
    );
    const encryptedSubchannelInfo = encryptions.encryptSubchannelInfo(
      channelKey,
      index,
      token,
      random
    );

    return {
      type: "OpenSubchannel",
      apply: () => {
        assert(
          !this.subchannelMarkers.has(subchannelMarker),
          () => `Subchannel ${toHex(subchannelMarker)} already exists`
        );
        this.subchannels.set(subchannelId, encryptedSubchannelInfo);
        this.subchannelMarkers.add(subchannelMarker);
      },
    };
  }

  private useNote(
    owner: StarknetAddressBigint,
    ownerPrivateKey: ViewingKey,
    token: StarknetAddressBigint,
    channelKey: Hash,
    index: number
  ): MockServerAction {
    const ownerPublicKey = this.get_public_key(owner);
    assert(
      this.subchannelMarkers.has(
        compute_subchannel_marker(channelKey, owner, ownerPublicKey, token)
      ),
      () => `Token ${token} does not exist`
    );

    const noteId = compute_note_id(channelKey, token, index);
    assert(this.notes.has(noteId), () => `Note ${noteId} does not exist`);

    const nullifier = compute_nullifier(channelKey, token, index, toBigInt(ownerPrivateKey));

    return {
      type: "UseNote",
      apply: () => {
        // Matches Cairo's WriteOnce for nullifier - fails if nullifier already exists
        assert(!this.nullifiers.has(nullifier), () => `Nullifier ${nullifier} already exists`);
        this.nullifiers.add(nullifier);
      },
    };
  }

  private createEncNote(
    sender: StarknetAddressBigint,
    senderPrivateKey: ViewingKey,
    to: StarknetAddressBigint,
    toPublicKey: PublicKey,
    token: StarknetAddressBigint,
    index: number,
    amount: Amount,
    random: bigint
  ): MockServerAction {
    const channelKey = compute_channel_key(
      sender,
      toBigInt(senderPrivateKey),
      to,
      toBigInt(toPublicKey)
    );
    const subchannelMarker = compute_subchannel_marker(
      channelKey,
      to,
      toBigInt(toPublicKey),
      token
    );
    assert(this.subchannelMarkers.has(subchannelMarker), () => `Token ${token} does not exist`);

    assert(
      index == 0 || this.notes.has(compute_note_id(channelKey, token, index - 1)),
      () => `Nonce ${index} is not sequential`
    );

    const noteId = compute_note_id(channelKey, token, index);

    const noteData: EncryptedNote = {
      packed: encryptions.encryptNoteAmount(channelKey, token, index, random, amount),
      token,
      index,
    };

    return {
      type: "CreateEncNote",
      apply: () => {
        // Matches Cairo's to_write_once_action for note - fails if note already exists
        assert(!this.notes.has(noteId), () => `Note ${noteId} already exists`);
        this.notes.set(noteId, noteData);
      },
    };
  }

  private createOpenNote(
    sender: StarknetAddressBigint,
    senderPrivateKey: ViewingKey,
    to: StarknetAddressBigint,
    toPublicKey: PublicKey,
    token: StarknetAddressBigint,
    index: number
  ): MockServerAction {
    const channelKey = compute_channel_key(
      sender,
      toBigInt(senderPrivateKey),
      to,
      toBigInt(toPublicKey)
    );
    const subchannelMarker = compute_subchannel_marker(
      channelKey,
      to,
      toBigInt(toPublicKey),
      token
    );
    assert(this.subchannelMarkers.has(subchannelMarker), () => `Token ${token} does not exist`);

    assert(
      index == 0 || this.notes.has(compute_note_id(channelKey, token, index - 1)),
      () => `Nonce ${index} is not sequential`
    );

    const noteId = compute_note_id(channelKey, token, index);
    assert(!this.notes.has(noteId), () => `Note ${noteId} already exists`);

    // Open note: r=1n marker, amount=0n (to be filled by depositor), token
    const noteData: OpenNote = { r: 1n, amount: 0n, token };

    return {
      type: "CreateOpenNote",
      apply: () => {
        this.notes.set(noteId, noteData);
      },
    };
  }

  private deposit(
    from: StarknetAddressBigint,
    token: StarknetAddressBigint,
    amount: Amount
  ): MockServerAction {
    return {
      type: "Deposit",
      apply: () => this.contracts.get(token).transfer(from, this.address, amount),
      deferred: true,
    };
  }

  private withdraw(
    token: StarknetAddressBigint,
    recipient: StarknetAddressBigint,
    amount: Amount
  ): MockServerAction {
    return {
      type: "Withdraw",
      apply: () => this.contracts.get(token).transfer(this.address, recipient, amount),
      deferred: true,
    };
  }

  private invoke(contractAddress: StarknetAddressBigint, calldata: bigint[]): MockServerAction {
    return {
      type: "InvokeExternal",
      apply: () => {
        const entrypoint = "privacy_invoke";
        this.contracts.call(contractAddress, entrypoint, calldata);
      },
      deferred: true,
    };
  }

  private validateTokenTotals(sender: StarknetAddressBigint, clientActions: ClientAction[]): void {
    const runningTotals = new Map<bigint, bigint>();

    const updateTotal = (token: StarknetAddressBigint, delta: bigint) => {
      const current = runningTotals.get(token) ?? 0n;
      const updated = current + delta;
      assert(
        updated >= 0n,
        () => `Running total for token ${toHex(token)} went negative: ${updated}`
      );
      runningTotals.set(token, updated);
    };

    for (const action of clientActions) {
      switch (action.type) {
        case "Deposit":
          assert(
            action.input.amount >= 0n,
            () => `Deposit amount must be non-negative: ${action.input.amount}`
          );
          if (!("noteId" in action.input) || action.input.noteId === undefined) {
            updateTotal(action.input.token, action.input.amount);
          }
          break;

        case "UseNote": {
          const noteData = this.get_decrypted_note(
            action.input.channel_key,
            action.input.index,
            action.input.token
          );
          assert(noteData, () => `Note not found`);
          assert(!noteData.open, () => `Cannot use open note as input`);
          updateTotal(action.input.token, noteData.amount);
          break;
        }

        case "CreateEncNote": {
          const amount = action.input.amount;
          if (!isOpen(amount)) {
            assert(amount >= 0n, () => `CreateEncNote amount must be non-negative: ${amount}`);
            updateTotal(action.input.token, -amount);
          }
          break;
        }

        case "Withdraw":
          assert(
            action.input.amount >= 0n,
            () => `Withdraw amount must be non-negative: ${action.input.amount}`
          );
          updateTotal(action.input.token, -action.input.amount);
          break;

        default:
          break;
      }
    }

    for (const [token, total] of runningTotals.entries()) {
      assert(total === 0n, () => `Final total for token ${toHex(token)} is ${total}, expected 0`);
    }
  }
}
