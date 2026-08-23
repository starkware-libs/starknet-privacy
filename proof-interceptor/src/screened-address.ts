// src/screened-address.ts
import { CairoCustomEnum, num } from "starknet";
import { decodeClientActions, normalizeFelt } from "./pool-transaction.js";
import type { PoolCallActions } from "./pool-transaction.js";
import type { ProveTxnV3 } from "./types.js";
import { getShadowAccountAddress } from "./shadow-account.js";
import type { OpenNoteScreeningPolicyClient } from "./screening-policy.js";

type PolicyReader = Pick<OpenNoteScreeningPolicyClient, "getPolicy">;

export interface ScreenedAddressConfig {
  poolAddress: string;
  anonymizerAddress: string;
}

type InvokeAction = "InvokeExternal" | "ComputeAndInvoke";

/**
 * The contract whose invoke funds a transaction's open notes, which the pool holds the open-note
 * screening policy for, and the action it is driven through.
 */
interface OpenNoteDepositor {
  address: string;
  action: InvokeAction;
}

/** The pool takes one attestation per transaction, so anything past one address it would reject. */
type DelegatedAddress = Extract<
  ScreenedAddress,
  {
    kind:
      | "one"
      | "none"
      | "unimplementedDelegate"
      | "undeterminedShadowAccount";
  }
>;

export type ScreenedAddress =
  | { kind: "none" }
  | { kind: "one"; address: string }
  | { kind: "conflict" }
  | { kind: "unreadablePolicy" }
  | { kind: "unimplementedDelegate" }
  | { kind: "undeterminedShadowAccount" };

/**
 * The address a prove request must be screened for.
 *
 * Screening an address the pool did not ask for is not a harmless extra: it rejects an attestation
 * it has no subject for with `UNEXPECTED_SCREENING`.
 */
export async function getScreenedAddress(
  transaction: ProveTxnV3,
  config: ScreenedAddressConfig,
  policies: PolicyReader
): Promise<ScreenedAddress> {
  // Calldata the pool cannot parse reverts on its own, so nothing in it needs screening.
  const poolCall = decodeClientActions(transaction, config.poolAddress);
  if (poolCall === null) return { kind: "none" };

  const addresses = new Set<string>();

  // A deposit is screened on its own depositor. The screening policy list does not apply to a
  // `TransferFrom` the user signs for themselves.
  if (poolCall.actions.some((action) => action.activeVariant() === "Deposit")) {
    addresses.add(poolCall.userAddress);
  }

  const openNoteDepositor = getOpenNoteDepositor(poolCall.actions);
  if (openNoteDepositor !== null) {
    const policy = await policies.getPolicy(openNoteDepositor.address);
    switch (policy) {
      case "Exempt":
        break;

      case "Required":
        addresses.add(openNoteDepositor.address);
        break;

      case "Delegated": {
        const delegated = getDelegatedAddress(
          poolCall,
          openNoteDepositor,
          config
        );
        if (delegated.kind === "one") addresses.add(delegated.address);
        else if (delegated.kind !== "none") return delegated;
        break;
      }

      case null:
        return { kind: "unreadablePolicy" };

      default:
        return unscreenableUnderUnhandledPolicy(policy);
    }
  }

  if (addresses.size > 1) return { kind: "conflict" };
  const [address] = addresses;
  return address === undefined ? { kind: "none" } : { kind: "one", address };
}

/** The address a delegated open-note depositor puts up for the deposits its invoke funds. */
function getDelegatedAddress(
  poolCall: PoolCallActions,
  openNoteDepositor: OpenNoteDepositor,
  { anonymizerAddress }: ScreenedAddressConfig
): DelegatedAddress {
  // Delegated screening applies to a compute-invoke only. A plain invoke is exempt under the
  // `Delegated` policy.
  if (openNoteDepositor.action !== "ComputeAndInvoke") return { kind: "none" };

  if (openNoteDepositor.address !== normalizeFelt(anonymizerAddress)) {
    console.error(
      JSON.stringify({ error: "delegated_screening_unimplemented" })
    );
    return { kind: "unimplementedDelegate" };
  }

  const shadowAccount = getShadowAccountAddress(poolCall, anonymizerAddress);
  if (shadowAccount === null) {
    console.error(JSON.stringify({ error: "shadow_account_undetermined" }));
    return { kind: "undeterminedShadowAccount" };
  }
  return { kind: "one", address: shadowAccount };
}

/**
 * Under the invariant that an open note must be funded within the transaction that creates it, any
 * transaction carrying a `CreateOpenNote` action has an open-note depositor.
 */
function getOpenNoteDepositor(
  actions: CairoCustomEnum[]
): OpenNoteDepositor | null {
  if (!actions.some((action) => action.activeVariant() === "CreateOpenNote")) {
    return null;
  }
  for (const action of actions) {
    const variant = action.activeVariant();
    if (variant !== "InvokeExternal" && variant !== "ComputeAndInvoke")
      continue;
    const { contract_address } = action.unwrap() as {
      contract_address: bigint;
    };
    return {
      address: normalizeFelt(num.toHex(contract_address)),
      action: variant,
    };
  }
  return null;
}

/**
 * Refuses a policy the switch above does not handle. The `never` parameter is the point: the switch
 * cases every variant of {@link OpenNoteScreeningPolicy}, and `scripts/check_screening_policies.py`
 * keeps that union tracking the Cairo enum, so a new Cairo variant fails to compile here instead of
 * falling through and screening nobody. Should one reach here at runtime, it fails closed.
 */
function unscreenableUnderUnhandledPolicy(policy: never): ScreenedAddress {
  console.error(
    JSON.stringify({ error: "screening_policy_unavailable", policy })
  );
  return { kind: "unreadablePolicy" };
}
