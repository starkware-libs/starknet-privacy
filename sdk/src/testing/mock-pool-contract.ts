/**
 * MockPoolContract - Mock implementation of the privacy pool contract.
 *
 * This class provides:
 * 1. Async view methods matching PrivacyPoolContract signatures (for ContractDiscoveryProvider)
 * 2. Sync methods matching old PrivacyPool API (for MockDiscoveryProvider - to be removed in Branch 3)
 * 3. execute_view() returns MockServerAction[] for state mutations
 * 4. execute_actions() applies the mutations
 * 5. snapshot()/restore() for validation pattern
 */

import type { Amount, Note, Open, StarknetAddressBigint } from "../interfaces.js";
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
import {
  encryptions,
  type EncChannelInfo,
  type EncSubchannelInfo,
  type EncOutgoingChannelInfo,
} from "../utils/encryptions.js";
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
  compute_outgoing_channel_key,
} from "../utils/hashes.js";
import { ClientAction } from "../internal/client-actions.js";
import { debugLog, hex } from "../utils/logging.js";
import type { MockServerAction } from "./mock-server-action.js";

type OpenNote = {
  r: bigint;
  amount: Amount;
  token: StarknetAddressBigint;
};

type TrackingState = {
  channels: AddressMap<Channel>;
  notes: AddressMap<Map<bigint, Note>>;
};

type EncryptedNote = { packed: bigint; token: bigint; index: number };

export type MockPoolContractSnapshot = {
  publicKeys: Map<bigint, PublicKey>;
  channels: Map<string, EncChannelInfo[]>;
  channelIds: Set<Hash>;
  subchannels: Map<Hash, EncSubchannelInfo>;
  subchannelIds: Set<Hash>;
  notes: Map<Hash, EncryptedNote | OpenNote>;
  nullifiers: Set<Hash>;
  outgoingChannels: Map<bigint, EncOutgoingChannelInfo>;
  outgoingChannelCounters: Map<bigint, number>;
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

export class MockPoolContract implements MockContract {
  private publicKeys = new AddressMap<PublicKey>();
  private channels = new ChannelsMap();
  private channelIds = new Set<Hash>();
  private subchannels = new Map<Hash, EncSubchannelInfo>();
  private subchannelIds = new Set<Hash>();
  private notes = new Map<Hash, EncryptedNote | OpenNote>();
  private nullifiers = new Set<Hash>();
  private outgoingChannels = new Map<bigint, EncOutgoingChannelInfo>();
  private outgoingChannelCounters = new AddressMap<number>(() => 0);

  // State tracking (not part of contract state, but needed for compiler/testing)
  private tracking = new AddressMap<TrackingState>(() => ({
    channels: new AddressMap<Channel>(),
    notes: new AddressMap<Map<bigint, Note>>(() => new Map<bigint, Note>()),
  }));

  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: bigint,
    private contracts: MockContracts,
    private validateBalances: boolean = true
  ) {}

  // ============ Async View Methods (matching PrivacyPoolContract) ============

  async get_public_key(userAddr: string): Promise<bigint> {
    const addr = BigInt(userAddr);
    return this.publicKeys.has(addr) ? toBigInt(this.publicKeys.get(addr)!) : 0n;
  }

  async get_num_of_channels(recipientAddr: string): Promise<bigint> {
    const addr = BigInt(recipientAddr);
    if (!this.publicKeys.has(addr)) return 0n;
    const pk = this.publicKeys.get(addr)!;
    return BigInt(this.channels.get({ address: addr, publicKey: pk })?.length ?? 0);
  }

  async get_channel_info(recipientAddr: string, index: number): Promise<EncChannelInfo> {
    const addr = BigInt(recipientAddr);
    const pk = this.publicKeys.get(addr)!;
    const channelList = this.channels.get({ address: addr, publicKey: pk }) ?? [];
    return channelList[index] ?? { ephemeral_pubkey: 0n, enc_channel_key: 0n, enc_sender_addr: 0n };
  }

  async get_subchannel_info(subchannelKey: string): Promise<EncSubchannelInfo> {
    const key = BigInt(subchannelKey);
    return this.subchannels.get(key) ?? { salt: 0n, enc_token: 0n };
  }

  async get_outgoing_channel_info(outgoingChannelKey: string): Promise<EncOutgoingChannelInfo> {
    const key = BigInt(outgoingChannelKey);
    return this.outgoingChannels.get(key) ?? { salt: 0n, enc_recipient_addr: 0n };
  }

  async get_note(noteId: string): Promise<bigint> {
    const id = BigInt(noteId);
    const note = this.notes.get(id);
    if (!note) return 0n;
    if ("packed" in note) return note.packed;
    return note.amount as bigint; // For open notes, return amount directly
  }

  async channel_exists(channelId: string): Promise<boolean> {
    return this.channelIds.has(BigInt(channelId));
  }

  async nullifier_exists(nullifier: string): Promise<boolean> {
    return this.nullifiers.has(BigInt(nullifier));
  }

  // ============ Sync Methods (for MockDiscoveryProvider compatibility) ============

  isRegistered(address: bigint): boolean {
    return this.publicKeys.has(address);
  }

  getPublicKey(address: bigint): PublicKey {
    this.assertRegistered(address);
    return this.publicKeys.get(address)!;
  }

  getChannels(address: bigint): EncChannelInfo[] {
    const pk = this.getPublicKey(address);
    return this.channels.get({ address, publicKey: pk })!;
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
    return { id: noteId, amount, r: salt, open: false };
  }

  hasNoteById(noteId: bigint) {
    return this.notes.has(noteId);
  }

  getNullifier(witness: Witness, token: bigint, ownerPrivateKey: ViewingKey): boolean {
    return this.nullifiers.has(
      compute_nullifier(witness.channelKey, token, witness.nonce, toBigInt(ownerPrivateKey))
    );
  }

  getOutgoingChannelInfo(key: bigint): EncOutgoingChannelInfo | undefined {
    return this.outgoingChannels.get(key);
  }

  getUsersChannel(sender: bigint, recipient: bigint): Channel | undefined {
    return this.tracking.get(sender)?.channels.get(recipient);
  }

  // ============ Execute Methods ============

  /**
   * Execute client actions and return MockServerAction[] that can be replayed.
   * Actions are applied immediately (like the original PrivacyPool), except
   * FollowupCall which is only applied during replay.
   * Validates token totals if validateBalances is true.
   */
  execute_view(sender: bigint, clientActions: ClientAction[]): MockServerAction[] {
    if (this.validateBalances) {
      this.validateTokenTotals(sender, clientActions);
    }

    const serverActions: MockServerAction[] = [];

    for (const action of clientActions) {
      const actions = this.compileAction(sender, action);
      // Apply each action immediately (required for assertions in subsequent actions)
      // Exception: FollowupCall is deferred - only applied during replay
      for (const serverAction of actions) {
        if (serverAction.type !== "FollowupCall") {
          serverAction.apply();
        }
        serverActions.push(serverAction);
      }
    }

    return serverActions;
  }

  /**
   * Apply server actions to mutate state.
   */
  execute_actions(actions: MockServerAction[]): void {
    for (const action of actions) {
      action.apply();
    }
  }

  /**
   * Execute client actions immediately (for backward compatibility).
   * Returns MockServerAction[] that have already been applied.
   */
  execute(sender: bigint, ...clientActions: ClientAction[]): MockServerAction[] {
    return this.execute_view(sender, clientActions);
  }

  openDeposit(noteId: bigint, token: bigint, amount: Amount): void {
    this.fillOpenNote(noteId, token, amount);
    // Note: The original PrivacyPool doesn't actually execute the deposit transfer here.
    // The swap helper is expected to have already handled the token transfer.
  }

  // ============ Setup Methods (for compiler) ============

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
    this.setChannel(userAddress, viewingKey, address, channel.publicKey, generateRandom()).apply();

    for (const [token, nonces] of channel.tokens.entries()) {
      this.setToken(
        userAddress,
        address,
        channel.publicKey,
        channel.key,
        token,
        nonces.tokenNonce,
        generateRandom()
      ).apply();

      if (nonces.noteNonce > 0) {
        this.notes.set(compute_note_id(channel.key, token, nonces.noteNonce - 1), {
          r: 1n,
          amount: 0n,
          token,
        });
      }

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

  updateRegistry(
    userAddress: bigint,
    registry: { channels: AddressMap<Channel>; notes: AddressMap<Note[]> }
  ) {
    for (const [address, channel] of this.tracking.get(userAddress)!.channels.entries()) {
      registry.channels.set(address, channel);
    }
    for (const [token, notes] of this.tracking.get(userAddress)!.notes.entries()) {
      registry.notes.set(token, Array.from(notes.values()));
    }
    return registry;
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
      trackingSnapshot.set(user, { channels: channelsCopy, notes: notesCopy });
    }

    return {
      publicKeys: new Map(this.publicKeys.entries()),
      channels: channelsSnapshot,
      channelIds: new Set(this.channelIds),
      subchannels: new Map(this.subchannels),
      subchannelIds: new Set(this.subchannelIds),
      notes: notesSnapshot,
      nullifiers: new Set(this.nullifiers),
      outgoingChannels: new Map(this.outgoingChannels),
      outgoingChannelCounters: new Map(this.outgoingChannelCounters.entries()),
      tracking: trackingSnapshot,
    };
  }

  restore(snapshot: unknown): void {
    const s = snapshot as MockPoolContractSnapshot;

    this.publicKeys.clear();
    for (const [k, v] of s.publicKeys) this.publicKeys.set(k, v);

    this.channels.clear();
    for (const [strKey, value] of s.channels) {
      const [address, publicKey] = strKey.split(":");
      this.channels.set({ address: BigInt(address), publicKey: BigInt(publicKey) }, value);
    }

    this.channelIds = new Set(s.channelIds);
    this.subchannels = new Map(s.subchannels);
    this.subchannelIds = new Set(s.subchannelIds);
    this.notes = new Map(s.notes);
    this.nullifiers = new Set(s.nullifiers);
    this.outgoingChannels = new Map(s.outgoingChannels);

    this.outgoingChannelCounters.clear();
    for (const [k, v] of s.outgoingChannelCounters) this.outgoingChannelCounters.set(k, v);

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
      this.tracking.set(user, { channels: channelsMap, notes: notesMap });
    }
  }

  // ============ Private Methods ============

  private assertRegistered(address: bigint): void {
    if (!this.publicKeys.has(address)) {
      throw new Error(`Address ${hex(address)} is not registered`);
    }
  }

  private compileAction(sender: bigint, action: ClientAction): MockServerAction[] {
    switch (action.type) {
      case "SetViewingKey":
        return [this.register(sender, action.input.privateKey, action.input.random)];

      case "OpenChannel":
        return [
          this.setChannel(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.random
          ),
        ];

      case "OpenSubchannel":
        return [
          this.setToken(
            sender,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.channelKey,
            action.input.token,
            action.input.index,
            action.input.random
          ),
        ];

      case "Deposit": {
        if (action.input.noteId !== undefined) {
          const noteId = action.input.noteId;
          const token = action.input.token;
          const amount = action.input.amount;
          return [
            {
              type: "OpenDeposit",
              apply: () => this.openDeposit(noteId, token, amount),
            },
          ];
        }
        return [this.deposit(sender, action.input.token, action.input.amount)];
      }

      case "UseNote":
        return [
          this.useNote(
            sender,
            action.input.ownerPrivateKey,
            action.input.token,
            action.input.channelKey,
            action.input.noteIndex
          ),
        ];

      case "CreateNote":
        return [
          this.createNote(
            sender,
            action.input.senderPrivateKey,
            action.input.recipientAddr,
            action.input.recipientPublicKey,
            action.input.token,
            action.input.index,
            action.input.amount,
            action.input.random
          ),
        ];

      case "Withdraw":
        return [
          this.withdraw(action.input.token, action.input.withdrawalTarget, action.input.amount),
        ];

      case "FollowupCall":
        return [
          {
            type: "FollowupCall",
            apply: () => {
              this.contracts.call(
                action.input.call.contractAddress,
                action.input.call.entrypoint,
                ...(action.input.call.calldata ? (action.input.call.calldata as unknown[]) : [])
              );
            },
          },
        ];
    }
  }

  private register(address: bigint, privateKey: ViewingKey, _random: bigint): MockServerAction {
    const publicKey = derivePublicKey(privateKey);
    return {
      type: "SetViewingKey",
      apply: () => {
        this.publicKeys.set(address, publicKey);
        this.tracking.get(address)!.channels.set(address, new Channel(publicKey));
      },
    };
  }

  private setChannel(
    from: bigint,
    fromPrivateKey: ViewingKey,
    to: bigint,
    toPublicKey: PublicKey,
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

    const s = this.outgoingChannelCounters.get(from)!;
    if (s > 0) {
      const prevOutgoingChannelKey = compute_outgoing_channel_key(
        from,
        toBigInt(fromPrivateKey),
        s - 1
      );
      assert(
        this.outgoingChannels.has(prevOutgoingChannelKey),
        () => `Outgoing channel index ${s} is not sequential for sender ${hex(from)}`
      );
    }
    const outgoingChannelKey = compute_outgoing_channel_key(from, toBigInt(fromPrivateKey), s);
    const outgoingSalt = generateRandom();
    const encOutgoingChannelInfo = encryptions.encryptOutgoingChannelInfo(
      from,
      toBigInt(fromPrivateKey),
      s,
      to,
      outgoingSalt
    );

    return {
      type: "OpenChannel",
      apply: () => {
        this.tracking.get(from)!.channels.get(to, () => new Channel(toPublicKey))!.key = channelKey;
        this.channels.get({ address: to, publicKey: toPublicKey })!.push(channelInfo);
        this.channelIds.add(compute_channel_id(channelKey, from, to, toBigInt(toPublicKey)));
        this.outgoingChannels.set(outgoingChannelKey, encOutgoingChannelInfo);
        this.outgoingChannelCounters.set(from, s + 1);
      },
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
  ): MockServerAction {
    this.assertRegistered(from);

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

    const userChannel = this.tracking.get(from)!.channels.get(to)!;
    assert(
      !userChannel.tokens.has(token),
      () =>
        `Token ${hex(token)} already exists in channel with index ${
          userChannel.tokens.get(token)!.tokenNonce
        }`
    );

    const subchannelId = compute_subchannel_id(channelKey, to, toBigInt(toPublicKey), token);
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
          !this.subchannelIds.has(subchannelId),
          () => `Subchannel ${hex(subchannelId)} already exists`
        );
        this.subchannels.set(subchannelKey, encryptedSubchannelInfo);
        this.subchannelIds.add(subchannelId);

        const userChannel = this.tracking.get(from)!.channels.get(to)!;
        if (!userChannel.tokens.has(token)) {
          userChannel.tokens.set(token, { tokenNonce: index, noteNonce: 0 });
        } else {
          assert(
            userChannel.tokens.get(token)!.tokenNonce == index,
            () => `Token ${token} nonce mismatch`
          );
        }
      },
    };
  }

  private useNote(
    owner: bigint,
    ownerPrivateKey: ViewingKey,
    token: bigint,
    channelKey: Hash,
    noteIndex: number
  ): MockServerAction {
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

    return {
      type: "UseNote",
      apply: () => {
        this.tracking.get(owner)!.notes.get(token)!.delete(noteId);
        this.nullifiers.add(nullifier);
      },
    };
  }

  private createNote(
    sender: bigint,
    senderPrivateKey: ViewingKey,
    to: bigint,
    toPublicKey: PublicKey,
    token: bigint,
    index: number,
    amount: Amount | Open,
    random: bigint
  ): MockServerAction {
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

    return {
      type: "CreateNote",
      apply: () => {
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
      },
    };
  }

  private deposit(from: bigint, token: bigint, amount: Amount): MockServerAction {
    return {
      type: "Deposit",
      apply: () => this.contracts.get(token).transfer(from, this.address, amount),
    };
  }

  private withdraw(token: bigint, recipient: bigint, amount: Amount): MockServerAction {
    return {
      type: "Withdraw",
      apply: () => this.contracts.get(token).transfer(this.address, recipient, amount),
    };
  }

  private fillOpenNote(noteId: bigint, token: bigint, amount: Amount): void {
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
          assert(
            action.input.amount >= 0n,
            () => `Deposit amount must be non-negative: ${action.input.amount}`
          );
          if (!("noteId" in action.input) || action.input.noteId === undefined) {
            updateTotal(action.input.token, action.input.amount);
          }
          break;

        case "UseNote": {
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
          const amount = action.input.amount;
          if (!isOpen(amount)) {
            assert(amount >= 0n, () => `CreateNote amount must be non-negative: ${amount}`);
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
      assert(total === 0n, () => `Final total for token ${hex(token)} is ${total}, expected 0`);
    }
  }
}
