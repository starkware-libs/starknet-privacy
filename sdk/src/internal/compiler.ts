/**
 * ActionCompiler - Resolves contexts and prepares actions for execution.
 *
 * Context resolution order:
 * 1. Registry (provided via options)
 * 2. OpenChannelActions in the same batch (compute channel with nonce=0)
 * 3. AutoSetup (implicitly create OpenChannelAction)
 * 4. Discovery (call discovery service)
 *
 * After compilation:
 * - Registry is updated with resolved channels and notes
 * - Actions may have UseNoteActions added (if autoSelectNotes)
 * - ClientAction[] is produced with all context "unwrapped"
 *
 * Note: After pool execution, use applyOptimisticUpdate() from registry-updater.ts
 * to update the registry with the results.
 */

import type {
  Actions,
  Amount,
  DiscoveryProviderInterface,
  ExecuteOptions,
  Note,
  OpenChannelAction,
  PrivateRegistry,
  StarknetAddress,
  ViewingKey,
} from "../interfaces.js";
import { Channel, createEmptyRegistry } from "../interfaces.js";
import { AddressMap, AdvancedMap } from "../utils/maps.js";
import type { ClientAction } from "./client-actions.js";
import { PrivacyPool } from "../testing/pool.js";
import { MockContracts } from "../testing/contracts.js";
import { assert, isOpen } from "../utils/validation.js";
import { BigNumberish } from "starknet";
import { generateRandom, toBigInt } from "../utils/crypto.js";
import { consoleLogCallback, withLogging, debugLog } from "../utils/logging.js";

export type CompileResult = {
  clientActions: ClientAction[];
  registry: PrivateRegistry;
};

type ClientActions = {
  setViewingKey?: Extract<ClientAction, { type: "SetViewingKey" }>;
  openChannels: Extract<ClientAction, { type: "OpenChannel" }>[];
  openTokenChannels: Extract<ClientAction, { type: "OpenSubchannel" }>[];
  deposits: Extract<ClientAction, { type: "Deposit" }>[];
  useNotes: Extract<ClientAction, { type: "UseNote" }>[];
  createNotes: Extract<ClientAction, { type: "CreateNote" }>[];
  withdraws: Extract<ClientAction, { type: "Withdraw" }>[];
  followupCall?: Extract<ClientAction, { type: "FollowupCall" }>;
};

/** Generate a 120-bit random value for note encryption */
function generateRandom120(): bigint {
  const bytes = new Uint8Array(15); // 15 bytes = 120 bits
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

export class ActionCompiler {
  constructor(
    private userAddress: StarknetAddress,
    private userViewingKey: ViewingKey,
    private discoveryProvider: DiscoveryProviderInterface
  ) {}

  /**
   * Compile actions by resolving contexts, updating the registry, and producing ClientAction[].
   */
  compile(actions: Actions, options?: ExecuteOptions): CompileResult {
    const registry_ = options?.registry ?? createEmptyRegistry();
    const registry = options?.registryConst ? this.cloneRegistry(registry_) : registry_;

    // Phase 1: Resolve recipient channels
    const channels = this.resolveRecipientChannels(actions, options, registry);

    // Phase 2: Resolve notes (discover and/or auto-select)
    this.resolveNotes(actions, registry, options);

    // debugLog("compiler", "registry notes after resolve", registry?.notes?.size);

    // create a pool to simulate the execution of the actions
    const pool = this.createPool(actions, registry, channels, options);

    // Phase 3: Transform Actions to ClientAction[]
    const clientActions = this.transformToClientActions(actions, pool, options);

    return { clientActions, registry: pool.updateRegistry(this.userAddress, registry) };
  }

  private createPool(
    actions: Actions,
    registry?: PrivateRegistry,
    channels?: AddressMap<Channel>,
    options?: ExecuteOptions
  ) {
    const contracts = new MockContracts();

    const pool = withLogging(
      new PrivacyPool(this.userAddress, contracts, false /* don't validate execution balances */),
      "CompilerPool",
      consoleLogCallback
    );
    contracts.register(pool);

    // go over deposit actions and instantiate balances
    if (actions.deposits) {
      for (const deposit of actions.deposits) {
        contracts.get(deposit.token).increaseBalance(this.userAddress, deposit.amount);
      }
    }

    if (actions.withdraws) {
      for (const withdraw of actions.withdraws) {
        contracts.get(withdraw.token).increaseBalance(pool.address, withdraw.amount);
      }
    }

    if (!options?.autoRegister) {
      // won't add an action but the internal pool requires it
      pool.execute(this.userAddress, {
        type: "SetViewingKey",
        input: { privateKey: this.userViewingKey, random: generateRandom() },
      });
    }

    debugLog("compiler", "setup discovered channels", channels);

    for (const [addr, channel] of channels?.entries() ?? []) {
      pool.setupChannel(this.userAddress, this.userViewingKey, addr, channel);
    }

    debugLog("compiler", "setup registry channels", registry?.channels);

    for (const [addr, channel] of registry?.channels?.entries() ?? []) {
      if (channels?.has(addr)) continue; // skip channels that were already set up in the previous step
      pool.setupChannel(this.userAddress, this.userViewingKey, addr, channel);
    }

    debugLog("compiler", "setup notes", registry?.notes);

    if (registry?.notes) {
      for (const [token, notes] of registry.notes.entries()) {
        for (const note of notes) {
          pool.setupNote(this.userAddress, note, token);
        }
      }
    }

    return pool;
  }

  /**
   * Transform high-level Actions to low-level ClientAction[] using registry context.
   */
  private transformToClientActions(
    actions: Actions,
    pool: PrivacyPool,
    options?: ExecuteOptions
  ): ClientAction[] {
    const clientActions: ClientActions = {
      setViewingKey: undefined,
      openChannels: [],
      openTokenChannels: [],
      deposits: [],
      useNotes: [],
      createNotes: [],
      withdraws: [],
      followupCall: undefined,
    };

    if (options?.autoRegister && !options?.registry?.channels?.has(this.userAddress)) {
      actions.setViewingKey = {
        type: "SetViewingKey",
        input: { privateKey: this.userViewingKey, random: generateRandom() },
      };
    }

    const execute = <T extends ClientAction>(input: T, arr: T[] = []): T => {
      pool.execute(this.userAddress, input); // no need to run the callbacks since there's no state restore
      arr.push(input);
      return input;
    };

    // 1. SetViewingKey
    if (actions.setViewingKey) {
      const input = {
        type: "SetViewingKey",
        input: {
          privateKey: this.userViewingKey,
          random: generateRandom(),
        },
      } as const; // typescipt magic
      clientActions.setViewingKey = execute(input);
    }

    // 2. OpenChannel
    const transformOpenChannel = (channel: Channel, action: OpenChannelAction) => {
      const input = {
        type: "OpenChannel",
        input: {
          senderPrivateKey: this.userViewingKey,
          recipientAddr: action.recipient,
          recipientPublicKey: channel.publicKey as bigint,
          random: generateRandom(),
        },
      } as const; // typescipt magic
      execute(input, clientActions.openChannels);
    };

    if (actions.openChannels) {
      for (const action of actions.openChannels) {
        const channel = pool.getUsersChannel(action.recipient);
        assert(channel, () => `Missing channel context for recipient ${action.recipient}`);
        transformOpenChannel(channel, action);
      }
    }

    // 3. OpenSubchannel (OpenTokenChannel)
    const transformOpenSubchannel = (action: {
      recipient: StarknetAddress;
      token: StarknetAddress;
    }) => {
      const channel = pool.getUsersChannel(action.recipient);
      assert(channel, () => `Channel not found for recipient ${action.recipient}`);
      if (!channel.key && options?.autoSetup) {
        transformOpenChannel(channel, { recipient: action.recipient });
      }

      // console.log(`[compiler] checking token ${action.token} in channel ${action.recipient}: ${channel.tokens.has(action.token)}`);

      if (channel.tokens.has(action.token)) {
        return channel;
      }

      const input = {
        type: "OpenSubchannel",
        input: {
          recipientAddr: action.recipient,
          recipientPublicKey: channel.publicKey as bigint,
          channelKey: channel.key as bigint,
          index: channel.tokens.size,
          token: action.token,
          random: generateRandom(),
        },
      } as const; // typescipt magic
      execute(input, clientActions.openTokenChannels);

      return pool.getUsersChannel(action.recipient)!; // on the safe side, the pool is not supposed to create a new Channel object
    };

    if (actions.openTokenChannels) {
      for (const action of actions.openTokenChannels) {
        transformOpenSubchannel(action);
      }
    }

    // 4. Deposit (token transfer + optional note creation)
    if (actions.deposits) {
      for (const action of actions.deposits) {
        const input = {
          type: "Deposit",
          input: {
            token: action.token,
            amount: action.amount,
            noteId: action.noteId,
          },
        } as const; // typescipt magic
        if (action.noteId && !pool.hasNoteById(action.noteId)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (pool as any).notes.set(toBigInt(action.noteId), {
            r: 1n,
            amount: 0n,
            token: toBigInt(action.token),
          });
        }
        execute(input, clientActions.deposits);
      }
    }

    // 5. UseNote
    if (actions.useNotes) {
      for (const action of actions.useNotes) {
        const input = {
          type: "UseNote",
          input: {
            ownerPrivateKey: this.userViewingKey,
            channelKey: action.note.witness.channelKey,
            token: action.token,
            noteIndex: action.note.witness.nonce,
          },
        } as const; // typescipt magic
        if (!pool.hasNoteById(action.note.id)) {
          // this means the note is not in the registry, trust the user knows it exists
          pool.setupNote(this.userAddress, action.note, action.token); // add it to the registry
        }
        execute(input, clientActions.useNotes);
      }
    }

    // 6. CreateNote (non-deposit notes)
    if (actions.createNotes) {
      for (const action of actions.createNotes) {
        const channel = transformOpenSubchannel({
          recipient: action.recipient,
          token: action.token,
        });

        const input = {
          type: "CreateNote",
          input: {
            senderPrivateKey: this.userViewingKey,
            recipientAddr: action.recipient,
            recipientPublicKey: channel.publicKey as bigint,
            token: action.token,
            amount: action.amount,
            index: channel.tokens.get(action.token)!.noteNonce,
            random: generateRandom120(),
          },
        } as const; // typescipt magic
        execute(input, clientActions.createNotes);
      }
    }

    // 7. Withdraw
    if (actions.withdraws) {
      for (const action of actions.withdraws) {
        const input = {
          type: "Withdraw",
          input: {
            withdrawalTarget: action.recipient,
            token: action.token,
            amount: action.amount,
          },
        } as const; // typescipt magic
        execute(input, clientActions.withdraws);
      }
    }

    // surpluses were handled in resolveNotes

    // 8. FollowupCall
    if (actions.followupCall) {
      const input = {
        type: "FollowupCall",
        input: {
          call: actions.followupCall.call,
        },
      } as const; // typescipt magic
      clientActions.followupCall = execute(input);
    }

    return Object.values(clientActions)
      .filter((action) => action !== undefined)
      .flat();
  }

  /**
   * Resolve recipient channels by discovering or using registry.
   */
  private resolveRecipientChannels(
    actions: Actions,
    options: ExecuteOptions | undefined,
    registry: PrivateRegistry
  ): AddressMap<Channel> | undefined {
    const recipientDiscoveryLevel = options?.autoDiscover?.channels;

    if (!recipientDiscoveryLevel) {
      // Allow discovery for OpenChannel actions as they require fetching the recipient's public key
      const hasOpenChannels = actions.openChannels && actions.openChannels.length > 0;
      if (!hasOpenChannels) {
        return undefined;
      }
    }

    // Collect ALL recipients that need a channel (from any action type)
    const recipientsNeeded = new AddressMap<boolean>([[this.userAddress, true]]);

    // If a channel is to be opened, need to discover the recipient's public key
    // to calculate the channel key for further actions.
    if (actions.openChannels) {
      for (const action of actions.openChannels) {
        recipientsNeeded.set(action.recipient, true);
      }
    }

    if (actions.openTokenChannels) {
      for (const action of actions.openTokenChannels) {
        recipientsNeeded.set(action.recipient, true);
      }
    }

    if (actions.openTokenChannels) {
      for (const action of actions.openTokenChannels) {
        recipientsNeeded.set(action.recipient, true);
      }
    }

    if (actions.createNotes) {
      for (const action of actions.createNotes) {
        recipientsNeeded.set(action.recipient, true);
      }
    }

    if (actions.surpluses) {
      for (const surplus of actions.surpluses) {
        recipientsNeeded.set(surplus.recipient, true);
      }
    }

    // Determine which recipients to discover based on discovery level
    let recipientsToDiscover: StarknetAddress[];

    if (recipientDiscoveryLevel === "refresh") {
      // Refresh: discover ALL recipients to get latest nonces
      recipientsToDiscover = [...recipientsNeeded.keys()];
    } else {
      // None or explicit: only discover missing recipients
      recipientsToDiscover = [...recipientsNeeded.keys()].filter((r) => !registry.channels.has(r));
    }

    if (recipientsToDiscover.length === 0) {
      return undefined;
    }

    // Discover channels for all recipients that need discovery in a single call
    // discoverChannels computes channel keys and returns current nonce state
    const { channels } = this.discoveryProvider.discoverChannels(
      this.userAddress,
      this.userViewingKey,
      ...recipientsToDiscover
    );

    return channels;
  }

  /**
   * Resolve notes by discovering and/or auto-selecting from registry.
   */
  private resolveNotes(
    actions: Actions,
    registry: PrivateRegistry,
    options?: ExecuteOptions
  ): void {
    if (!actions.surpluses && !options?.autoSelectNotes) return;

    // Calculate token balances (inputs - outputs)
    // Positive balance = surplus (needs change note)
    // Negative balance = deficit (needs input notes)
    const balances = new AddressMap(() => 0n);

    const update = (token: StarknetAddress, amount: Amount) => {
      const current = balances.get(token)!;
      balances.set(token, current + amount);
    };

    // Inputs: Deposits (without noteId)
    if (actions.deposits) {
      for (const d of actions.deposits) {
        assert(d.amount > 0n, () => `Deposit amount must be positive`);
        if (d.noteId === undefined) {
          // a deposit to an open note immediately cancels the balance
          update(d.token, d.amount);
        }
      }
    }

    // Inputs: Existing UseNotes
    const usedNoteIds = new AdvancedMap<BigNumberish, boolean, string>({
      keyConverter: (key: BigNumberish) => String(key),
    });

    if (actions.useNotes) {
      for (const u of actions.useNotes) {
        assert(u.note.amount > 0n, () => `Note ${u.note.id}: amount must be positive`);
        update(u.token, u.note.amount);
        usedNoteIds.set(u.note.id, true);
      }
    }

    // Outputs: Withdraws
    if (actions.withdraws) {
      for (const w of actions.withdraws) {
        assert(w.amount > 0n, () => `Withdraw amount must be positive`);
        update(w.token, -w.amount);
      }
    }

    // Outputs: CreateNotes (ignore Open amounts)
    if (actions.createNotes) {
      for (const c of actions.createNotes) {
        assert(
          isOpen(c.amount) || c.amount > 0n,
          () => `Created note amount must be positive (token: ${c.token})`
        );
        if (!isOpen(c.amount)) {
          update(c.token, -c.amount);
        }
      }
    }

    const notesDiscoveryLevel = options?.autoDiscover?.notes;
    // discover notes if requested
    if (notesDiscoveryLevel !== undefined) {
      const tokensToDiscover = (() => {
        if (notesDiscoveryLevel === "all") return undefined;
        return [...balances.entries()]
          .filter(([token, balance]) => {
            // Case 1: We have a deficit (negative balance), so we need inputs.
            const hasDeficit = balance < 0n;

            // Case 2: We want to sweep all funds (autoSelectNotes="all") into a surplus recipient.
            // Even if balance is 0, we check if we should fetch notes to dump them.
            const isSweeping =
              options?.autoSelectNotes === "all" && // assume 'all' means the user wants to always "compress" their notes even if balance is 0
              actions.surpluses?.some((s) => s.token === token);

            if (!hasDeficit && !isSweeping) return false;

            // Finally, check if discovery is actually needed (forced refresh or missing from registry)
            return notesDiscoveryLevel === "refresh" || !registry.notes.has(token);
          })
          .map(([token]) => token);
      })();

      debugLog("compiler", "discovering notes", tokensToDiscover);

      if (!tokensToDiscover || tokensToDiscover.length > 0) {
        const { notes } = this.discoveryProvider.discoverNotes(
          this.userAddress,
          this.userViewingKey,
          { known: registry.notes, tokens: tokensToDiscover }
        );

        // Replace registry notes (don't merge - some may have been spent)
        for (const [token, discoveredNotes] of notes.entries()) {
          registry.notes.set(token, discoveredNotes);
        }
      }
    }

    // Resolve deficits and surpluses
    for (const token of balances.keys()) {
      let balance = balances.get(token)!;

      // If deficit, try to cover with notes from registry
      if ((balance < 0n && options?.autoSelectNotes) || options?.autoSelectNotes === "all") {
        const availableNotes = registry.notes.get(token) ?? [];
        actions.useNotes ??= [];

        // naively select unused notes from registry (may create surplus)
        // TODO: Implement an 'exact' strategy that selects notes exactly to cover the deficit
        for (const note of availableNotes) {
          if (usedNoteIds.has(note.id)) continue; // Skip used notes

          actions.useNotes.push({ token, note });
          balance += note.amount;
          if (balance >= 0n && options?.autoSelectNotes !== "all") break; // Deficit covered
        }
      }

      // If surplus (after adding notes or initially), create change note
      if (balance > 0n) {
        const surplusAction = actions.surpluses?.find((s) => s.token === token);
        if (!surplusAction)
          throw new Error(
            `Surplus of ${balance} found for token ${token} but no surplus action found`
          );
        if (surplusAction.withdraw) {
          actions.withdraws ??= [];
          actions.withdraws.push({
            recipient: surplusAction.recipient,
            token,
            amount: balance,
          });
        } else {
          actions.createNotes ??= [];
          actions.createNotes.push({
            recipient: surplusAction.recipient,
            token,
            amount: balance,
          });
        }
      }
    }
  }

  private cloneRegistry(registry: PrivateRegistry): PrivateRegistry {
    // Clone channels
    const clonedChannels = new AddressMap<Channel>();
    for (const [addr, channel] of registry.channels.entries()) {
      clonedChannels.set(addr, channel);
    }

    // Clone notes
    const clonedNotes = new AddressMap<Note[]>(() => []);
    for (const [addr, notes] of registry.notes.entries()) {
      clonedNotes.set(addr, [...notes]);
    }

    return { channels: clonedChannels, notes: clonedNotes };
  }
}
