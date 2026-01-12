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
 * - Pool looks up context from registry
 *
 * Note: After pool execution, use applyOptimisticUpdate() from registry-updater.ts
 * to update the registry with the results.
 */

import type {
  Actions,
  DiscoveryProviderInterface,
  ExecuteOptions,
  Note,
  PrivateRegistry,
  StarknetAddress,
  UseNoteAction,
  ViewingKey,
} from "../interfaces.js";
import { Channel, createEmptyRegistry } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";

export type CompileResult = {
  actions: Actions;
  registry: PrivateRegistry;
};

export class ActionCompiler {
  constructor(
    private userAddress: StarknetAddress,
    private userViewingKey: ViewingKey,
    private discoveryProvider: DiscoveryProviderInterface
  ) {}

  /**
   * Compile actions by resolving contexts and updating the registry.
   */
  compile(actions: Actions, options?: ExecuteOptions): CompileResult {
    // Get or create registry
    const inputRegistry = options?.registry ?? createEmptyRegistry();
    const registry = options?.registryConst ? this.cloneRegistry(inputRegistry) : inputRegistry;

    // Phase 1: Resolve recipient channels
    this.resolveRecipientChannels(actions, options, registry);

    // Phase 2: Resolve notes (discover and/or auto-select)
    this.resolveNotes(actions, options, registry);

    return { actions, registry };
  }

  /**
   * Resolve recipient channels by discovering or using registry.
   */
  private resolveRecipientChannels(
    actions: Actions,
    options: ExecuteOptions | undefined,
    registry: PrivateRegistry
  ): void {
    // Collect ALL recipients that need a channel (from any action type)
    const recipientsNeeded = new AddressMap<boolean>();

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

    if (actions.deposits) {
      for (const action of actions.deposits) {
        if ("recipient" in action) {
          recipientsNeeded.set(action.recipient, true);
        }
      }
    }

    if (actions.createNotes) {
      for (const action of actions.createNotes) {
        recipientsNeeded.set(action.recipient, true);
      }
    }

    const recipientDiscoveryLevel = options?.autoDiscover?.recipient ?? "none";

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
      return;
    }

    // Check which recipients have explicit OpenChannelActions
    const openChannelRecipients = new AddressMap<boolean>();
    for (const action of actions.openChannels ?? []) {
      openChannelRecipients.set(action.recipient, true);
    }

    // Recipients that need context but don't have an explicit OpenChannelAction
    const recipientsWithoutOpenChannel = recipientsToDiscover.filter(
      (r) => !openChannelRecipients.has(r) && !registry.channels.has(r)
    );

    // Handle recipients without explicit OpenChannelAction
    if (recipientsWithoutOpenChannel.length > 0) {
      if (recipientDiscoveryLevel === "none" && !options?.autoSetup) {
        // No way to resolve - error
        const missing = recipientsWithoutOpenChannel.join(", ");
        throw new Error(
          `Missing channel context for recipients: ${missing}. ` +
            `Provide registry, add OpenChannelAction, enable autoSetup, or enable autoDiscover.`
        );
      }

      if (options?.autoSetup) {
        // AutoSetup: implicitly add OpenChannelActions for missing recipients
        actions.openChannels = actions.openChannels ?? [];
        for (const recipient of recipientsWithoutOpenChannel) {
          actions.openChannels.push({ recipient });
        }
      }
    }

    // Discover channels for all recipients that need discovery in a single call
    // discoverChannels computes channel keys and returns current nonce state
    const { channels } = this.discoveryProvider.discoverChannels(
      this.userAddress,
      this.userViewingKey,
      ...recipientsToDiscover
    );
    for (const [addr, channel] of channels.entries()) {
      registry.channels.set(addr, channel);
    }
  }

  /**
   * Resolve notes by discovering and/or auto-selecting from registry.
   */
  private resolveNotes(
    actions: Actions,
    options: ExecuteOptions | undefined,
    registry: PrivateRegistry
  ): void {
    const notesDiscoveryLevel = options?.autoDiscover?.notes ?? "none";

    // Discover notes if requested
    if (notesDiscoveryLevel !== "none") {
      const shouldDiscover = notesDiscoveryLevel === "refresh" || registry.notes.size === 0;

      if (shouldDiscover) {
        const { notes } = this.discoveryProvider.discoverNotes(
          this.userAddress,
          this.userViewingKey,
          { known: registry.notes }
        );

        // Replace registry notes (don't merge - some may have been spent)
        registry.notes = notes;
      }
    }

    // Auto-select notes if enabled and no useNotes provided
    if (options?.autoSelectNotes && (!actions.useNotes || actions.useNotes.length === 0)) {
      // Collect tokens that need notes (from createNotes, withdraws)
      const tokensNeeded = new AddressMap<boolean>();

      if (actions.createNotes) {
        for (const action of actions.createNotes) {
          tokensNeeded.set(action.token, true);
        }
      }

      if (actions.withdraws) {
        for (const action of actions.withdraws) {
          tokensNeeded.set(action.token, true);
        }
      }

      // Select all available notes for needed tokens
      const useNotes: UseNoteAction[] = [];
      for (const token of tokensNeeded.keys()) {
        const tokenNotes = registry.notes.get(token);
        if (tokenNotes) {
          for (const note of tokenNotes) {
            useNotes.push({ token, note });
          }
        }
      }

      if (useNotes.length > 0) {
        actions.useNotes = useNotes;
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
