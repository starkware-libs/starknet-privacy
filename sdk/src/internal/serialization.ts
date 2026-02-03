/**
 * Serialization utilities for converting ClientActions to Cairo calldata format.
 */

import { CairoCustomEnum } from "starknet";
import type { ClientAction } from "./client-actions.js";
import { CLIENT_ACTION_TYPES } from "./client-actions.js";

/**
 * Convert a ClientAction to a CairoCustomEnum for serialization.
 * Since ClientAction types now match the Cairo ABI exactly (snake_case),
 * no field name conversion is needed.
 */
function toCairoEnum(action: ClientAction): CairoCustomEnum {
  const variants: Record<string, unknown> = {};
  for (const variant of CLIENT_ACTION_TYPES) {
    variants[variant] = variant === action.type ? action.input : undefined;
  }
  return new CairoCustomEnum(variants);
}

/**
 * Check if an action is a Cairo ABI action (not client-side only).
 */
function isCairoAction(action: ClientAction): action is ClientAction {
  return action.type !== "FollowupCall";
}

/**
 * Convert an array of ClientActions to CairoCustomEnums for Cairo calldata serialization.
 * Filters out client-side-only actions like FollowupCall.
 */
export function serializeClientActions(actions: ClientAction[]): CairoCustomEnum[] {
  return actions.filter(isCairoAction).map(toCairoEnum);
}
