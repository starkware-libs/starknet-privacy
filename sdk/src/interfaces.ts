import type {
  AccountInterface,
  AllowArray,
  BigNumberish,
  BlockIdentifier,
  BlockNumber,
  Call,
  Invocation,
} from "starknet";

export type Amount = bigint;

/** Marker for creating an open note (a note whose amount is open and can be filled later with a deposit) */
export type Open = { readonly __marker: 'open' };
export const open: Open = { __marker: 'open' };

/** Marker for "transfer to self" */
export type Self = { readonly __marker: 'self' };
export const self: Self = { __marker: 'self' };

type BlobT = string | Uint8Array;

export type Blob<B extends BlobT> = B & { readonly __blob: unique symbol };

export type Serde<T, B extends BlobT> = {
  encode(from: T): Blob<B>;
  decode(from: Blob<B>): T;
};

/**
 * Union that allows both the concrete Account class as well as the lighter AccountInterface.
 */
export type ViewingKey = BigNumberish;

export type StarknetAddress = BigNumberish;

export const witnessBrand: unique symbol = Symbol("witness");

export type Witness = {
  readonly [witnessBrand]: true;
};

export type WitnessSerde<B extends BlobT = string> = Serde<Witness, B>;

export type Note = {
  readonly id: Note.Id;
  readonly amount: Amount;
  readonly created?: BlockNumber; // required to know maturity (10 blocks)
  readonly witness: Witness;
  readonly viewingKey?: ViewingKey; // in case the viewing key is different than the privacy pool's.
  readonly sender: StarknetAddress;
};

export namespace Note {
  /** Unique identifier for a note, used for semi-transparent (preprepared) notes */
  export type Id = BigNumberish;
}

export type Proof = {
  readonly data: Uint8Array;
  readonly outputHash: BigNumberish;
  readonly output: BigNumberish[]; // array of felts
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

export type PrivateTransfersConfig = {
  account: AccountInterface;
  viewingSigner: ViewingKey;
  provingProvider: ProofProviderInterface;
  discoveryProvider: DiscoveryProviderInterface;
  pool: StarknetAddress;
};

export const channelBrand: unique symbol = Symbol("channel");

export type Channel = {
  readonly [channelBrand]: true;
};

export type ChannelSerde<B extends BlobT = string> = Serde<Channel, B>;

export type PrivacyState = {
  timestamp: BlockIdentifier;

  // token -> notes
  notes: Map<StarknetAddress, Note[]>;

  // recipient -> channel
  recipients: Map<StarknetAddress, Channel>;
};

export interface PrivateRecipient {
  address: StarknetAddress;
  context: Channel | Note.Id; // note id is for semi-transparent (preprepared) notes.
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
export interface PrivateTransfers {
  /** 
   * expected properties to be set by the implementing object
  readonly prover: ProveInterface;
  readonly viewingSigner: ViewingKey;
  readonly discoveryProvider: DiscoveryProviderInterface;
  readonly pool: StarknetAddress;
  readonly user: StarknetAddress;
  */


  isRegistered(): Promise<boolean>;

  /**
   * register the account in the privacy pool
   */
  register(): Promise<CallAndProof>;

  /**
   * given a recipient and token, check if the recipient has a Channel associated with it and if the token is in the channel.
   * @returns {initial: boolean, token: boolean}
   * initial: true if the recipient doesn't have a Channel associated with it
   * token: true if the token is in the channel
   * @throws if the account or recipient is not registered
   */
  setupRequirement(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<{ register: boolean; initial: boolean; token: boolean }>;

  /**
   * if an intended recipient doesn't have a Channel associated with it
   */
  setupInitial(
    recipient: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }>;

  /**
   * if an intended recipient doesn't have the token in its channel. TBD: expose tokens in the channel.
   */
  setupToken(
    recipient: PrivateRecipient,
    token: StarknetAddress
  ): Promise<{ invocationData: CallAndProof; channel: Channel }>;

  /**
   * deposit tokens into the privacy pool
   *
   * v1: the recipient is the same as the account address or has setup a semi transparent note for the deposit.
   */
  deposit(params: {
    token: StarknetAddress;
    amount: Amount;
    recipient?: PrivateRecipient;
  }): Promise<PrivateInvocationResult>;

  /**
   * Withdraw tokens from the privacy pool
   *
   * @param amount if not provided, the total amount of the notes is used. if provided and is lower than the total amount of notes, the remainder note is returned. In that case, the channel must be provided
   *
   * v1: the inputs size is 1 and the amount must match the output amount.
   */
  withdraw(params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient?: StarknetAddress;
    amount?: Amount;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult>;

  /**
   * transfer tokens from the privacy pool to a single recipient. 
   * @param amount if not provided, the total amount of the notes is used. if provided and is lower than the total amount of notes, the remainder note is returned
   *
   * Note: one can send notes with total that exceeds the amount ot transfer, that way a single note is returned as remainder that replaces them.
   */
  transfer(params: {
    token: StarknetAddress;
    inputs: Note[];
    recipient: PrivateRecipient | Self;
    amount?: Amount | Open;
    selfChannel?: Channel;
  }): Promise<PrivateInvocationResult>;

 

  /**
   * Create a builder to batch multiple operations into a single execution.
   * See {@link PrivateTransfersBuilder} for detailed examples.
   */
  build(): PrivateTransfersBuilder;
  
  /**
   * Discover unspent notes per token and recipient states
   *
   * @recipient discover a specific recipient's state
   */
  discover({
    since,
    known,
    recipient,
  }: {
    since?: BlockIdentifier;
    known?: PrivacyState;
    recipient?: StarknetAddress;
  }): Promise<PrivacyState>;
}

// ============ Builder Types ============

/**
 * Output specification for transfer/withdraw operations
 */
export type TransferOutput = { recipient: PrivateRecipient | Self; amount: Amount | Open };
export type WithdrawOutput = { recipient: StarknetAddress | Self; amount: Amount };

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
  setup(recipient: PrivateRecipient): this;
  
  /** Specify input notes for this token */
  inputs(...notes: Note[]): this;
  
  /** Deposit this token (to self by default, or to a recipient with an open note already prepared) */
  deposit(amount: Amount, recipient?: PrivateRecipient | Self): this;
  
  /** Withdraw this token to one or more public addresses */
  withdraw(...outputs: WithdrawOutput[]): this;
  
  /** Transfer this token privately to one or more recipients */
  transfer(...outputs: TransferOutput[]): this;
  
  /** Switch to another token */
  with(token: StarknetAddress): TokenOperationsBuilder;
  
  /** Return to main builder (for non-token operations like register) */
  done(): PrivateTransfersBuilder;
  
  /** Execute all queued operations */
  execute(): Promise<CallAndProof[]>;
}

/**
 * Builder for batching multiple private transfer operations.
 * 
 * Use `.with(token)` to start token-specific operations.
 * 
 * @example Simple deposit
 * ```ts
 * await transfers.build()
 *   .with(STRK)
 *     .deposit(100n)
 *   .execute();
 * ```
 * 
 * @example Register and setup a new recipient
 * ```ts
 * await transfers.build()
 *   .register()
 *   .setup(alice)
 *   .with(STRK)
 *     .setup(alice)
 *     .deposit(100n)
 *   .execute();
 * ```
 * 
 * @example Transfer to multiple recipients (adapted from composite)
 * ```ts
 * // Transfer 10 STRK to Alice and 20 ETH to Bob using 3 notes
 * await transfers.build()
 *   .with(STRK)
 *     .inputs(strkNote)
 *     .transfer({ recipient: alice, amount: 10n })
 *   .with(ETH)
 *     .inputs(ethNote1, ethNote2)
 *     .transfer({ recipient: bob, amount: 20n })
 *   .execute();
 * ```
 * 
 * @example Partial withdrawal with remainder
 * ```ts
 * await transfers.build()
 *   .with(STRK)
 *     .inputs(note100Strk)
 *     .withdraw({ recipient: self, amount: 50n })
 *     .transfer({ recipient: self, amount: 25n })
 *     .transfer({ recipient: self, amount: 25n })
 *   .execute();
 * ```
 * 
 * @example Swap 
 * ```ts
 * // Prepare for swap: withdraw STRK to swap helper, deposit result back
 * await transfers.build()
 *   .with(STRK)
 *     .inputs(strkNote)
 *     .withdraw({ recipient: swapHelper, amount: 10n }) // helper does the swap and deposits the result
 *   .with(BTC)
 *     .deposit(open) // semi-transparent note for swap result
 *   .call({ contractAddress: swapHelper, entrypoint: "swap", calldata: [...] })
 *   .execute();
 * ```
 */
export interface PrivateTransfersBuilder {
  /** Register the account in the privacy pool */
  register(): this;
  
  /** Setup initial channel for a new recipient */
  setup(recipient: StarknetAddress): this;
  
  /** Add an arbitrary Starknet call that will run on starknet after the private operations are executed */
  call(call: Call): this;
  
  /** Start token-specific operations */
  with(token: StarknetAddress): TokenOperationsBuilder;
  
  /** Execute all queued operations and return the results */
  execute(): Promise<CallAndProof[]>;
}

////// The following are more likely to change /////////
/**
 * Configuration used to bootstrap the proving provider REST client.
 */

/**
 * Operator API contract — the proving service must implement this surface.
 */
export interface ProofProviderInterface {
  prove(invocation: Invocation): Promise<Proof>;
}

export interface DiscoveryProviderInterface {
  /**
   * Discover currently owned notes and state of past recipients.
   */
  discover(
    address: StarknetAddress,
    viewingKey: ViewingKey,
    {
      since,
      known,
      recipient,
    }: {
      since?: BlockIdentifier;
      known?: PrivacyState;
      recipient?: StarknetAddress;
    }
  ): Promise<PrivacyState>;

  globalViewingKey(): ViewingKey;
}
