import { num } from "starknet";
import type { SignerInterface, STRK20_CALL_AND_PROOF, STRK20_CALLDATA_ITEM } from "starknet";
import { createPrivateTransfers, Open } from "@starkware-libs/starknet-privacy-sdk";
import type {
  CallAndProof,
  DiscoveryProviderInterface,
  InvokeCalldataBuilderArgs,
  PrivateTransfersBuilder,
  PrivateTransfersInterface,
  ProofProviderInterface,
  StarknetAddress,
} from "@starkware-libs/starknet-privacy-sdk";
import { toStrk20Call } from "./calls.js";
import { passphraseViewingKeyProvider } from "./viewing-key.js";
import type { PrivacyStorage, Strk20Action, Strk20Prover } from "./interfaces.js";

/**
 * The node provider `simulate` needs, taken from the builder's own signature so it matches the core
 * SDK's `starknet` version (which can differ from the client's, making a bare `ProviderInterface`
 * import incompatible).
 */
type NodeProvider = Parameters<PrivateTransfersBuilder["simulate"]>[0]["provider"];

/**
 * Dependencies for a {@link CorePrivateTransfersProver}. The `passphrase` is the viewing-key source
 * the prover owns — it is derived (salted + iterated) into the viewing key internally, never surfaced
 * to the caller. The rest is what the core `PrivateTransfers` needs; `provider` is the node provider
 * simulate uses for fee estimation, and `storage` persists the note registry across transactions.
 */
export interface CorePrivateTransfersProverConfig {
  signer: SignerInterface;
  address: StarknetAddress;
  passphrase: string;
  provider: NodeProvider;
  discovery: DiscoveryProviderInterface;
  prover: ProofProviderInterface;
  poolContractAddress: StarknetAddress;
  subAccountAnonymizerAddress: StarknetAddress;
  storage: PrivacyStorage;
}

/**
 * The default {@link Strk20Prover}: it proves through a core `PrivateTransfers`, translating each
 * {@link Strk20Action} into the core builder's operations. The viewing key is derived from the
 * passphrase inside this class, so no caller ever handles it. Before proving, the stored note
 * registry is loaded (so spends see prior notes); after a real (non-simulate) proof it is saved back.
 */
export class CorePrivateTransfersProver implements Strk20Prover {
  private readonly transfers: PrivateTransfersInterface;
  private readonly provider: NodeProvider;
  private readonly storage: PrivacyStorage;

  constructor(config: CorePrivateTransfersProverConfig) {
    this.provider = config.provider;
    this.storage = config.storage;
    this.transfers = createPrivateTransfers({
      account: { address: config.address, signer: config.signer },
      viewingKeyProvider: passphraseViewingKeyProvider(config.passphrase, config.address),
      provingProvider: config.prover,
      discoveryProvider: config.discovery,
      poolContractAddress: config.poolContractAddress,
      subAccountAnonymizerAddress: config.subAccountAnonymizerAddress,
    });
  }

  partialCommitment(dappName: string): Promise<bigint> {
    return this.transfers.build().subaccounts(dappName).partialCommitment();
  }

  async prove(actions: Strk20Action[], simulate = false): Promise<STRK20_CALL_AND_PROOF> {
    const registry = await this.storage.loadRegistry();
    // register / channel setup / note selection are automatic for the SDK path; explicit builder
    // operations could be added later for finer information-hiding (e.g. which notes are spent).
    const builder = this.transfers.build({
      autoRegister: true,
      autoSetup: true,
      autoSelectNotes: "naive",
      autoDiscover: { channels: "refresh", notes: "refresh" },
      registry,
    });
    translate(builder, actions);
    if (simulate) {
      const simulated = await builder.simulate({ provider: this.provider });
      return toStrk20CallAndProof(simulated.callAndProof);
    }
    const result = await builder.execute();
    await this.storage.saveRegistry(result.registry);
    return toStrk20CallAndProof(result.callAndProof);
  }
}

/** Replay the strk20 actions onto a core builder as its native operations. */
function translate(builder: PrivateTransfersBuilder, actions: Strk20Action[]): void {
  for (const action of actions) {
    switch (action.type) {
      case "deposit":
        // strk20 deposit is always to self, so no recipient.
        builder.with(action.token).deposit({ amount: num.toBigInt(action.amount) });
        break;
      case "withdraw":
        builder
          .with(action.token)
          .withdraw({ recipient: action.recipient, amount: num.toBigInt(action.amount) });
        break;
      case "transfer":
        builder.with(action.token).transfer({
          recipient: action.recipient,
          amount: action.amount === "OPEN" ? Open : num.toBigInt(action.amount),
        });
        break;
      case "invoke":
        builder.invoke((args) => ({
          contractAddress: action.contract,
          calldata: action.calldata.map((item) => substitute(item, args)),
        }));
        break;
      case "compute_and_invoke":
        builder.computeAndInvoke((args) => ({
          contractAddress: action.contract,
          computeAdditionalData: action.compute_calldata.map((item) => substitute(item, args)),
          invokeAdditionalData: action.invoke_calldata.map((item) => substitute(item, args)),
        }));
        break;
    }
  }
}

const OPEN_NOTE_PLACEHOLDER = /^\$\{openNoteIds\[(\d+)\]\}$/;

/**
 * Resolve a strk20 calldata item to a concrete felt. Placeholders reference values only known once
 * the transaction is compiled: `${openNoteIds[N]}` is the id of the Nth open note created in this
 * transaction, `${poolAddress}` is the privacy pool address. Any other item is a literal felt.
 */
function substitute(item: STRK20_CALLDATA_ITEM, args: InvokeCalldataBuilderArgs): string {
  const openNote = OPEN_NOTE_PLACEHOLDER.exec(item);
  if (openNote) return num.toHex(args.openNotes[Number(openNote[1])].noteId);
  if (item === "${poolAddress}") return num.toHex(args.poolAddress);
  return num.toHex(num.toBigInt(item));
}

/** Map a core `CallAndProof` to the strk20 RPC shape (snake_case call fields, `proof_facts`). */
function toStrk20CallAndProof(result: CallAndProof): STRK20_CALL_AND_PROOF {
  return {
    call: toStrk20Call(result.call),
    proof: {
      data: result.proof.data,
      output: result.proof.output,
      proof_facts: result.proof.proofFacts,
    },
  };
}
