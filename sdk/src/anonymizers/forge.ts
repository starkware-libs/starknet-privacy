/**
 * TypeScript helpers for invoking the ForgeYieldsAnonymizer from the privacy SDK.
 *
 * Three operations are exposed:
 *  - {@link buildForgeDepositInvoke} — private deposit (underlying → shares note)
 *  - {@link buildForgeRequestRedeemInvoke} — burn shares + queue a redemption.
 *      The wallet captures a generated `redemptionId` from the tx receipt
 *      (gateway emits `RedeemRequested`; anonymizer emits `RedemptionRequested`)
 *      and persists `(id, secret)` locally until claim time.
 *  - {@link buildForgeClaimRedeemInvoke} — settle a queued redemption into a
 *      fresh private note of the underlying asset. Requires the matching
 *      `secret` (pre-image of the commitment supplied at request time).
 *
 * Privacy model: the redemption id is observable on-chain (it must be — the
 * gateway publishes a `RedeemRequested` event with it), so we layer a
 * commitment/secret pair on top so that only the wallet that filed the request
 * can later claim. The `secret` never leaves the wallet until claim time and
 * is not correlated with the wallet's address.
 */
import { CairoCustomEnum, CallData, hash, type Abi, type BigNumberish, type Call } from "starknet";

const FORGE_OPERATION_TYPE = "forge_yields_anonymizer::forge_yields_anonymizer::ForgeOperation";

/** Minimal ABI for `ForgeYieldsAnonymizer::privacy_invoke`. */
export const FORGE_ANONYMIZER_ABI: Abi = [
  {
    type: "struct",
    name: "core::integer::u256",
    members: [
      { name: "low", type: "core::integer::u128" },
      { name: "high", type: "core::integer::u128" },
    ],
  },
  {
    type: "struct",
    name: "forge_yields_anonymizer::forge_yields_anonymizer::DepositParams",
    members: [
      { name: "gateway", type: "core::starknet::contract_address::ContractAddress" },
      { name: "underlying", type: "core::starknet::contract_address::ContractAddress" },
      { name: "assets", type: "core::integer::u256" },
      { name: "note_id", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "forge_yields_anonymizer::forge_yields_anonymizer::RequestRedeemParams",
    members: [
      { name: "gateway", type: "core::starknet::contract_address::ContractAddress" },
      { name: "shares", type: "core::integer::u256" },
      { name: "commitment", type: "core::felt252" },
    ],
  },
  {
    type: "struct",
    name: "forge_yields_anonymizer::forge_yields_anonymizer::ClaimRedeemParams",
    members: [
      { name: "gateway", type: "core::starknet::contract_address::ContractAddress" },
      { name: "redemption_id", type: "core::integer::u256" },
      { name: "secret", type: "core::felt252" },
      { name: "underlying", type: "core::starknet::contract_address::ContractAddress" },
      { name: "note_id", type: "core::felt252" },
    ],
  },
  {
    type: "enum",
    name: FORGE_OPERATION_TYPE,
    variants: [
      {
        name: "Deposit",
        type: "forge_yields_anonymizer::forge_yields_anonymizer::DepositParams",
      },
      {
        name: "RequestRedeem",
        type: "forge_yields_anonymizer::forge_yields_anonymizer::RequestRedeemParams",
      },
      {
        name: "ClaimRedeem",
        type: "forge_yields_anonymizer::forge_yields_anonymizer::ClaimRedeemParams",
      },
    ],
  },
  {
    type: "interface",
    name: "forge_yields_anonymizer::forge_yields_anonymizer::IForgeYieldsAnonymizer",
    items: [
      {
        type: "function",
        name: "privacy_invoke",
        inputs: [{ name: "operation", type: FORGE_OPERATION_TYPE }],
        outputs: [{ type: "core::array::Span::<privacy::objects::OpenNoteDeposit>" }],
        state_mutability: "external",
      },
    ],
  },
];

let cachedEncoder: CallData | undefined;
function encoder(): CallData {
  if (!cachedEncoder) cachedEncoder = new CallData(FORGE_ANONYMIZER_ABI);
  return cachedEncoder;
}

function toHexAddress(value: BigNumberish): string {
  return typeof value === "string" ? value : `0x${BigInt(value).toString(16)}`;
}

/**
 * Compute the commitment that pairs with a wallet-only secret. Matches the
 * Cairo side's `poseidon_hash_span([secret])`.
 */
export function forgeRedemptionCommitment(secret: BigNumberish): string {
  return hash.computePoseidonHashOnElements([secret]);
}

// ────────────────────────────── Deposit ──────────────────────────────

export interface ForgeDepositParams {
  /** Address of the deployed `ForgeYieldsAnonymizer` contract. */
  anonymizer: BigNumberish;
  /** Underlying ERC-20 (e.g. USDC). */
  underlying: BigNumberish;
  /** ForgeYields `TokenGateway` for the chosen strategy (also the share ERC-20). */
  gateway: BigNumberish;
  /** Amount of underlying to deposit. */
  assets: bigint;
  /** Open note (on `gateway`) that the resulting shares will fill. */
  noteId: BigNumberish;
}

export function buildForgeDepositInvoke(params: ForgeDepositParams): Call {
  const calldata = encoder().compile("privacy_invoke", {
    operation: new CairoCustomEnum({
      Deposit: {
        gateway: params.gateway,
        underlying: params.underlying,
        assets: params.assets,
        note_id: params.noteId,
      },
    }),
  });
  return {
    contractAddress: toHexAddress(params.anonymizer),
    entrypoint: "privacy_invoke",
    calldata,
  };
}

// ──────────────────────────── RequestRedeem ──────────────────────────

export interface ForgeRequestRedeemParams {
  /** Address of the deployed `ForgeYieldsAnonymizer` contract. */
  anonymizer: BigNumberish;
  /** ForgeYields gateway / share token address — shares are burned here. */
  gateway: BigNumberish;
  /** Amount of shares to redeem. */
  shares: bigint;
  /** `forgeRedemptionCommitment(secret)`. Wallet must persist `secret` locally. */
  commitment: BigNumberish;
}

export function buildForgeRequestRedeemInvoke(params: ForgeRequestRedeemParams): Call {
  const calldata = encoder().compile("privacy_invoke", {
    operation: new CairoCustomEnum({
      RequestRedeem: {
        gateway: params.gateway,
        shares: params.shares,
        commitment: params.commitment,
      },
    }),
  });
  return {
    contractAddress: toHexAddress(params.anonymizer),
    entrypoint: "privacy_invoke",
    calldata,
  };
}

// ──────────────────────────── ClaimRedeem ────────────────────────────

export interface ForgeClaimRedeemParams {
  /** Address of the deployed `ForgeYieldsAnonymizer` contract. */
  anonymizer: BigNumberish;
  /** ForgeYields gateway / share token address. */
  gateway: BigNumberish;
  /** Underlying ERC-20 the redemption will settle into. */
  underlying: BigNumberish;
  /** Redemption id captured from the request-redeem tx receipt. */
  redemptionId: bigint;
  /** Wallet-only pre-image of the commitment supplied at request time. */
  secret: BigNumberish;
  /** Open note (on `underlying`) to deposit the redeemed assets into. */
  noteId: BigNumberish;
}

export function buildForgeClaimRedeemInvoke(params: ForgeClaimRedeemParams): Call {
  const calldata = encoder().compile("privacy_invoke", {
    operation: new CairoCustomEnum({
      ClaimRedeem: {
        gateway: params.gateway,
        redemption_id: params.redemptionId,
        secret: params.secret,
        underlying: params.underlying,
        note_id: params.noteId,
      },
    }),
  });
  return {
    contractAddress: toHexAddress(params.anonymizer),
    entrypoint: "privacy_invoke",
    calldata,
  };
}

// ─────────────────────────────── Events ──────────────────────────────

/**
 * Selector for the anonymizer's `RedemptionRequested` event. Use this to filter
 * receipts and extract the freshly assigned redemption id.
 */
export const REDEMPTION_REQUESTED_EVENT_SELECTOR = hash.getSelectorFromName("RedemptionRequested");

/**
 * Decode the `redemption_id` from a `RedemptionRequested` event's data array.
 * Event payload layout: `(redemption_id_low, redemption_id_high, commitment)`.
 * Keys (the `#[key]` fields) are not in `data`; here the only key is `gateway`,
 * which the caller is expected to already know.
 */
export function decodeRedemptionId(eventData: readonly BigNumberish[]): bigint {
  if (eventData.length < 2) {
    throw new Error("RedemptionRequested event data shorter than expected");
  }
  const low = BigInt(eventData[0]);
  const high = BigInt(eventData[1]);
  return low + (high << 128n);
}
