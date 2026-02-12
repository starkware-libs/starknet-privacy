import type {
  Account,
  AccountInvocationsFactoryDetails,
  AllowArray,
  BigNumberish,
  BlockIdentifier,
  BlockNumber,
  Call,
  constants,
  Invocation,
  Signature,
  SignerInterface,
} from "starknet";
import { ec } from "starknet";
import { AddressMap } from "./utils/index.js";

export type Amount = bigint;

/**
 * Maximum valid viewing key value (half the STARK curve order).
 * Private keys must be in range [1, MAX_VIEWING_KEY].
 */
export const MAX_VIEWING_KEY = ec.starkCurve.CURVE.n / 2n;

/** Marker for creating an open note (a note whose amount is open and can be deposited into later) */
export const Open = Symbol("Open");
export type Open = typeof Open;

export const All = Symbol("All");
export type All = typeof All;

/**
 * Union that allows both the concrete Account class as well as the lighter AccountInterface.
 */
export type ViewingKey = BigNumberish;

export type StarknetAddress = BigNumberish;

/**
 * Result of setupRequirement - indicates what setup is needed before a transfer.
 * Values are ordered by priority (higher value = more setup needed).
 */
export enum SetupRequirement {
  /** Recipient is not registered */
  Register = 0,
  /** Need to setup initial channel*/
  SetupChannel = 1,
  /** Need to setup the token subchannel */
  SetupToken = 2,
  /** Ready to transfer - no setup needed */
  Ready = 3,
}

/** A Starknet address normalized to bigint (for use as Map keys, etc.) */
export type StarknetAddressBigint = bigint;

// Import and re-export from internal channel
import { Witness, Channel } from "./internal/channel.js";
import type { NotesCursor } from "./internal/channel.js";
export { Witness, Channel };
export type { NotesCursor as DiscoveryCursor };

export type Note = {
  readonly id: NoteId;
  readonly amount: Amount;
  readonly created?: BlockNumber; // required to know maturity (10 blocks)
  readonly witness: Witness;
  readonly viewingKey?: ViewingKey; // in case the viewing key is different than the privacy pool's.
  readonly sender: StarknetAddress;
  readonly open?: boolean;
  readonly depositor?: StarknetAddress;
};

/** Unique identifier for a note, used for semi-transparent (preprepared) notes */
export type NoteId = BigNumberish;

export type Proof = {
  readonly data: Uint8Array;
  readonly output: string[]; // array of felts
  /** Proof facts from the proving service; must be included in the tx when submitting to the chain. */
  readonly proof_facts: string[];
};

/**
 * Payload to be wrapped in a transaction to send to Starknet
 */
export type CallAndProof = {
  readonly call: Call;
  readonly proof: Proof;
};

export type PrivateInvocationResult = {
  readonly invocationData: CallAndProof;
  readonly remainder?: Note;
};

export interface ViewingKeyProvider {
  getViewingKey(): Promise<ViewingKey> | ViewingKey;
}

export type ProofProviderConfig = {
  url: string;
};

export type DiscoveryProviderConfig = {
  url: string;
};

export interface PrivateRecipient {
  address: StarknetAddress;
  context: Channel;
}

/**
 * it is expected that the implementing object will receive an account signer instance to sign the invocation
 */
export interface ProveInterface {
  /**
   * Analogous to AccountInterface.execute. A default implementation will use the account signer and build an invocation with the privacy pool account address
   *
   * Customizations can add data to the call (e.g. fee withdrawal to the paymaster) before the user's signature.
   */
  prove(calls: AllowArray<Call>): Promise<Proof>;
}

// ============ Raw Actions (builder output, no context) ============

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type SetViewingKeyAction = {};

export type OpenChannelAction = {
  recipient: StarknetAddressBigint;
};

export type OpenTokenChannelAction = {
  recipient: StarknetAddressBigint;
  token: StarknetAddressBigint;
};

export type DepositAction = {
  token: StarknetAddressBigint;
  amount: Amount;
  noteId?: NoteId;
};

export type UseNoteAction = {
  token: StarknetAddressBigint;
  note: Note;
};

export type CreateNoteAction = {
  recipient: StarknetAddressBigint;
  token: StarknetAddressBigint;
} & ({ amount: Amount } | { amount: Open; depositor: StarknetAddressBigint });

export type WithdrawAction = {
  recipient: StarknetAddressBigint;
  token: StarknetAddressBigint;
  amount: Amount;
};

export type SurplusAction = {
  recipient: StarknetAddressBigint;
  token: StarknetAddressBigint;
  withdraw?: boolean;
};

export type FollowupCallAction = {
  call: Call;
};

/** Actions - context comes from registry */
export type Actions = {
  setViewingKey?: SetViewingKeyAction;
  openChannels?: OpenChannelAction[];
  openTokenChannels?: OpenTokenChannelAction[];
  deposits?: DepositAction[];
  useNotes?: UseNoteAction[];
  createNotes?: CreateNoteAction[];
  withdraws?: WithdrawAction[];
  surpluses?: SurplusAction[];
  followupCall?: FollowupCallAction;
};

// ============ Auto-Discovery & Registry Types ============

/**
 * Discovery level controls when/whether to call the discovery service.
 * - 'none': Never call discovery. Missing data → error.
 * - 'missing': Only discover when data is missing from registry. Trust existing registry contents.
 * - 'refresh': Always discover. Use registry as optimization hint.
 */
export type DiscoveryLevel = "missing" | "refresh";

/**
 * Options for automatic discovery during execute.
 */
export type AutoDiscoveryOptions = {
  /** Discovery level for notes. 'all' means discover all tokens regardless if used in the actions */
  notes?: DiscoveryLevel | "all";
  /** Discovery level for recipient channels (includes self) */
  channels?: DiscoveryLevel;
};

/**
 * Auto-selection strategy for notes.
 * - 'all': Select all notes (requires surplus handling)
 * - 'naive': Select first notes until balance is non negative (may create surplus)
 */
export type AutoSelectionStrategy = "all" | "naive" /*| "exact"*/; //

/**
 * Registry holding the user's private state: channels and notes.
 * Passed to execute() for context resolution and updated with new state.
 */
export type PrivateRegistry = {
  /** Channels by recipient address */
  channels: AddressMap<Channel>;
  /** Notes by token address */
  notes: AddressMap<Note[]>;
  /** Cursor for discovery */
  cursor?: NotesCursor;
};

/** Create an empty private registry */
export function createEmptyRegistry(): PrivateRegistry {
  return {
    channels: new AddressMap<Channel>(),
    notes: new AddressMap<Note[]>(() => []),
  };
}

/**
 * Options for building and executing private transfers.
 */
export type ExecuteOptions = {
  /** adds a set viewing key action if the user is not in the registry */
  autoRegister?: boolean;
  /** Auto-discovery options */
  autoDiscover?: AutoDiscoveryOptions;
  /** If true, add OpenChannel/OpenTokenChannel actions implicitly when missing */
  autoSetup?: boolean;
  /** If defined, auto select notes from registry. **/
  autoSelectNotes?: AutoSelectionStrategy;
  /** Registry for context/notes lookup. Updated during execute unless registryConst is true. */
  registry?: PrivateRegistry;
  /** If true, registry is not mutated; a new one is returned instead */
  registryConst?: boolean;
};

export type Warning = {
  code: WarningCode;
  message: string;
};

export enum WarningCode {
  USER_LINKAGE = "USER_LINKAGE",
}
/**
 * Result of execute, including the call/proof and updated registry.
 */
export type ExecuteResult = {
  callAndProof: CallAndProof;
  /** Updated registry (new object if registryConst was true, same object otherwise) */
  registry: PrivateRegistry;

  warnings: Warning[];
};

/**
 * Simple interface for simple private transfer scenarios
 */
export interface SimplePrivateTransfersInterface {
  readonly user: StarknetAddress;
  readonly registry: PrivateRegistry;

  /**
   * deposit tokens into the privacy pool
   *
   * v1: the recipient is the same as the account address or has setup a semi transparent note for the deposit.
   */
  deposit(token: StarknetAddress, amount: Amount): Promise<ExecuteResult>;

  /**
   * Withdraw tokens from the privacy pool
   */
  withdraw(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult>;

  /**
   * transfer tokens from the privacy pool to a single recipient.
   */
  transfer(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult>;

  /**
   * will withdraw to the contract in `helperCall` and then deposit to the privacy pool in `toToken`
   * Note: a noteid will be added to the helper calldata
   */
  swap(
    fromToken: StarknetAddress,
    fromAmount: Amount,
    toToken: StarknetAddress,
    helperCall: Call
  ): Promise<ExecuteResult>;
}

/**
 * Main interface for clients to use. It is stateless.
 * The methods call the proof provider to generate a proof and prepare a public call to send to Starknet.
 *
 * The wallet is in charge of:
 *   - storing state (channels, notes)
 *   - executing public transactions
 *   - selecting notes to spend
 *   - mark notes as spent
 *   -
 *
 * Matching private contract calls:
 *   fn deposit(addruser, kuser, i, token, amount)
 *   fn withdraw(addrowner, addrrecipient, kowner, note: (j: channel index, i: note index))
 *   fn transfer(addrowner, kowner, notes_to_use: Span<(j, i)>, notes_to_create: Span<(addrrecipient, token, i, amount)>)
 */
export interface PrivateTransfersInterface {
  /** 
   * expected properties to be set by the implementing object
  readonly prover: ProveInterface;
  readonly viewingSigner: ViewingKey;
  readonly discoveryProvider: DiscoveryProviderInterface;
  readonly pool: StarknetAddress;
  */
  readonly user: StarknetAddress;

  /**
   * given a recipient and token, check if there needs to be a setup for the recipient and token.
   * @returns SetupRequirement
   * @throws if the user is not registered
   */
  discoverRequirement(
    recipient: StarknetAddress,
    token: StarknetAddress
  ): Promise<SetupRequirement>;

  /**
   * Discover unspent notes per token
   *
   */
  discoverNotes(params?: { cursor?: NotesCursor; tokens?: StarknetAddressBigint[] }): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  }>;

  /**
   * Discover channels for one or more recipients
   */
  discoverChannels(
    recipients: StarknetAddress[],
    params?: { cursor?: AddressMap<Channel> }
  ): Promise<{
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  }>;

  /**
   * Execute raw actions. The implementation:
   * 1. Compiles actions (resolves contexts from registry, openChannels, autoSetup, or discovery)
   * 2. Validates the compiled actions
   * 3. Executes on the pool
   * 4. Returns result with updated registry
   */
  execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult>;

  /** Create a builder for batching multiple operations */
  build(options?: ExecuteOptions): PrivateTransfersBuilder;
}

// ============ Builder Types ============

/**
 * Output specification for transfer/withdraw operations
 */
export type TransferOutput = { recipient: StarknetAddress } & (
  | { amount: Amount }
  | { amount: Open; depositor: StarknetAddress }
);
export type WithdrawOutput = { recipient?: StarknetAddress; amount: Amount };
export type DepositInput = { recipient?: StarknetAddress } & {
  amount: Amount;
};

/**
 * Token-specific sub-builder for operations on a single token.
 * All methods return the builder for chaining.
 *
 * @example
 * // Transfer 10 STRK to Alice and 20 STRK to Bob using 2 notes
 * .with(STRK)
 *   .inputs(note1, note2)
 *   .transfer({ recipient: alice, amount: 10n }, { recipient: bob, amount: 20n })
 */
export interface TokenOperationsBuilder {
  /** Setup this token in recipient's channel */
  setup(recipient: StarknetAddress): this;

  /** Specify input notes for this token. If not called and autoSelectNotes is enabled, notes are auto-selected. */
  inputs(...notes: Note[]): this;

  /**
   * Deposit this token.
   * @param inputs Array of inputs to deposit. Each input can be a recipient address or a note id.
   */
  deposit(...inputs: DepositInput[]): this;

  /** Withdraw this token to one or more public addresses */
  withdraw(...outputs: WithdrawOutput[]): this;

  /**
   * Transfer this token privately to one or more recipients.
   * Context for each recipient is resolved from registry or discovery.
   */
  transfer(...outputs: TransferOutput[]): this;

  /**
   * Set the recipient for any surplus for this token.
   * Overrides the top-level surplusTo for this specific token.
   * If inputs exceed outputs, a CreateNoteAction is automatically added for the difference.
   */
  surplusTo(recipient: StarknetAddress, withdraw?: boolean): this;

  /** Switch to another token (fluent style) */
  with(token: StarknetAddress): TokenOperationsBuilder;
  /** Switch to another token with callback (block style, prettier-friendly) */
  with(token: StarknetAddress, ops: (t: TokenOperationsBuilder) => void): this;

  /** End the token-specific operations and return the builder */
  done(): PrivateTransfersBuilder;

  /** Execute all queued operations */
  execute(options?: ExecuteOptions): Promise<ExecuteResult>;
}

/**
 * Builder for batching multiple private transfer operations.
 *
 * Use `.with(token)` to start token-specific operations.
 *
 * @example Simple deposit (fluent style - good for one-liners)
 * ```ts
 * await transfers.build().with(STRK).deposit(100n).execute();
 * ```
 *
 * @example Simple deposit (block style - prettier-friendly)
 * ```ts
 * await transfers.build()
 *   .with(STRK, t => t
 *     .deposit(100n))
 *   .execute();
 * ```
 *
 * @example Register and setup a new recipient
 * ```ts
 * await transfers.build({ autoSetup: true })
 *   .register()
 *   .setup(BOB_ADDRESS)
 *   .with(STRK, t => t
 *     .setup(BOB_ADDRESS)
 *     .deposit(100n, BOB_ADDRESS))
 *   .execute();
 * ```
 *
 * @example Transfer to multiple recipients
 * ```ts
 * // Transfer 10 STRK to Alice and 20 ETH to Bob using 3 notes
 * await transfers.build()
 *   .with(STRK, t => t
 *     .inputs(strkNote)
 *     .transfer({ recipient: alice, amount: 10n }))
 *   .with(ETH, t => t
 *     .inputs(ethNote1, ethNote2)
 *     .transfer({ recipient: bob, amount: 20n }))
 *   .execute();
 * ```
 *
 * @example Partial withdrawal with remainder
 * ```ts
 * await transfers.build()
 *   .with(STRK, t => t
 *     .inputs(note100Strk)
 *     .withdraw({ recipient: self, amount: 50n })
 *     .transfer({ recipient: self, amount: 25n })
 *     .transfer({ recipient: self, amount: 25n }))
 *   .execute();
 * ```
 *
 * @example Swap
 * ```ts
 * // Prepare for swap: withdraw STRK to swap helper, deposit result back
 * await transfers.build()
 *   .with(STRK, t => t
 *     .inputs(strkNote)
 *     .withdraw({ recipient: swapHelper, amount: 10n }))
 *   .with(BTC, t => t
 *     .deposit(open)) // semi-transparent note for swap result
 *   .call({ contractAddress: swapHelper, entrypoint: "swap", calldata: [...] })
 *   .execute();
 * ```
 */
export interface PrivateTransfersBuilder {
  /** Register the account in the privacy pool */
  register(): this;

  /** Setup initial channel for a new recipient. */
  setup(recipient: StarknetAddress): this;

  /** Add an arbitrary Starknet call that will run on starknet after the private operations are executed */
  call(call: Call): this;

  /**
   * Set the default recipient for any surplus across all tokens.
   * If inputs exceed outputs for a token, a CreateNoteAction is automatically added for the difference.
   * Can be overridden per-token using TokenOperationsBuilder.surplusTo().
   */
  surplusTo(recipient: StarknetAddress, withdraw?: boolean): this;

  /** Start token-specific operations (fluent style) */
  with(token: StarknetAddress): TokenOperationsBuilder;
  /** Start token-specific operations with callback (block style, prettier-friendly) */
  with(token: StarknetAddress, ops: (t: TokenOperationsBuilder) => void): this;

  /** Execute all queued operations and return the results */
  execute(options?: ExecuteOptions): Promise<ExecuteResult>;
}

export type ProofInvocation = Invocation;

/**
 * Tx payload details attached by the factory to the invocation for the proving service.
 * Optional on ProofInvocation so mocks can ignore; proving provider reads from invocation.
 */
export interface ProofInvocationPayloadDetails {
  nonce: bigint;
  resourceBounds: {
    l1_gas: { max_amount: bigint; max_price_per_unit: bigint };
    l2_gas: { max_amount: bigint; max_price_per_unit: bigint };
    l1_data_gas: { max_amount: bigint; max_price_per_unit: bigint };
  };
  tip: bigint;
  paymasterData: BigNumberish[];
  accountDeploymentData: BigNumberish[];
  nonceDataAvailabilityMode: string;
  feeDataAvailabilityMode: string;
}

export type ProofInvocationWithPayload = ProofInvocation & ProofInvocationPayloadDetails;

/**
 * Factory details for creating proof invocations.
 * Extends AccountInvocationsFactoryDetails with chainId for signing.
 */
export type ProofInvocationFactoryDetails = AccountInvocationsFactoryDetails & {
  chainId: constants.StarknetChainId;
};

/**
 * Signer that can sign a raw message hash (e.g. a precomputed tx hash).
 * Implemented by SignerRaw; use this type when you need signRaw without casting.
 */
export interface SignerRawInterface extends SignerInterface {
  signRaw(msgHash: string): Promise<Signature>;
}

/**
 * Account whose signer implements SignerRawInterface (required for proof invocations).
 * Use an account whose signer is SignerRaw when calling createPrivateTransfers.
 */
export type AccountSignerRaw = Account & { signer: SignerRawInterface };

////// The following are more likely to change /////////

/**
 * Operator API contract — the proving service must implement this surface.
 */
export interface ProofProviderInterface {
  /** Get the default factory details for creating proof invocations (may be async e.g. to fetch nonce) */
  getDefaultDetails(): ProofInvocationFactoryDetails | Promise<ProofInvocationFactoryDetails>;
  prove(invocation: ProofInvocation): Promise<Proof>;
}

export interface DiscoveryProviderInterface {
  /**
   * Discover unspent notes per token
   */
  discoverNotes(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    params?: { cursor?: NotesCursor; tokens?: StarknetAddressBigint[] }
  ): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
    cursor: NotesCursor;
  }>;

  /**
   * Discover channels for one or more recipients.
   * Pass "all" to discover all outgoing channels by iterating through the outgoing channel map.
   */
  discoverChannels(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    recipients: StarknetAddressBigint[] | "all",
    params?: { cursor?: AddressMap<Channel>; lastKnownBlock?: BlockIdentifier }
  ): Promise<{ timestamp: BlockIdentifier; channels: AddressMap<Channel> }>;

  /**
   * Check the setup requirements for a recipient.
   *
   * @param recipient - The recipient to check the setup requirements for. if self, check for 'address'
   */
  discoverRequirement(
    address: StarknetAddressBigint,
    viewingKey: ViewingKey,
    recipient: StarknetAddressBigint,
    token: StarknetAddressBigint
  ): Promise<SetupRequirement>;
}

type BlobT = string | Uint8Array;

export type Blob<B extends BlobT> = B & { readonly __blob: unique symbol };

export type Serde<T, B extends BlobT> = {
  encode(from: T): Blob<B>;
  decode(from: Blob<B>): T;
};
export type WitnessSerde<B extends BlobT = string> = Serde<Witness, B>;
export type ChannelSerde<B extends BlobT = string> = Serde<Channel, B>;
