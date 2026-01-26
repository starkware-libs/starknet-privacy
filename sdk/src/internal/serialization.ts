/**
 * Serialization utilities for converting ClientActions to Cairo calldata format.
 */

import { CairoCustomEnum } from "starknet";
import type { ClientAction } from "./client-actions.js";

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Field name mappings from TypeScript to Cairo.
 * Some fields have different names in Cairo than in TypeScript.
 */
const FIELD_NAME_MAPPINGS: Record<string, string> = {
  random: "salt", // OpenSubchannel and CreateNote use 'salt' in Cairo
};

/**
 * Convert object keys from camelCase to snake_case (for Cairo serialization)
 * Also applies field name mappings for fields that differ between TS and Cairo.
 */
function toSnakeCaseKeys(
  obj: Record<string, unknown>,
  actionType: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip undefined values (optional fields not provided)
    if (value === undefined) continue;

    // Apply field name mapping if applicable, then convert to snake_case
    const mappedKey =
      actionType === "OpenSubchannel" || actionType === "CreateNote"
        ? (FIELD_NAME_MAPPINGS[key] ?? key)
        : key;
    result[toSnakeCase(mappedKey)] = value;
  }
  return result;
}

/**
 * All variant names in the ClientAction enum (order matters for proper serialization)
 */
const CLIENT_ACTION_VARIANTS = [
  "SetViewingKey",
  "OpenChannel",
  "OpenSubchannel",
  "CreateNote",
  "Deposit",
  "UseNote",
  "Withdraw",
] as const;

/**
 * Convert a ClientAction to a CairoCustomEnum for serialization
 */
function toCairoEnum(action: ClientAction): CairoCustomEnum {
  const variants: Record<string, unknown> = {};
  for (const variant of CLIENT_ACTION_VARIANTS) {
    variants[variant] =
      variant === action.type
        ? toSnakeCaseKeys(action.input as Record<string, unknown>, action.type)
        : undefined;
  }
  return new CairoCustomEnum(variants);
}

/**
 * Convert an array of ClientActions to CairoCustomEnums for Cairo calldata serialization.
 *
 * This function handles:
 * 1. Converting TypeScript camelCase field names to Cairo snake_case
 * 2. Wrapping actions in CairoCustomEnum for proper enum serialization
 */
export function serializeClientActions(actions: ClientAction[]): CairoCustomEnum[] {
  return actions.map(toCairoEnum);
}
