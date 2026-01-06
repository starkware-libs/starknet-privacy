import { num } from "starknet";
import type { PrivateRecipient, StarknetAddress, ViewingKey } from "../interfaces.js";
import { MAX_VIEWING_KEY } from "../interfaces.js";

// ============ Validation Utilities ============

/**
 * Asserts that a viewing key is valid (in range [1, MAX_VIEWING_KEY]).
 * @throws Error if the viewing key is out of range
 */
export function assertViewingKey(viewingKey: ViewingKey): void {
  num.assertInRange(viewingKey, 1n, MAX_VIEWING_KEY, "viewingKey");
}

/**
 * Asserts that a recipient is valid (not undefined or null) and extracts the address.
 * @returns The StarknetAddress from the recipient
 * @throws Error if the recipient is undefined or null
 */
export function assertRecipientAddress(
  recipient: StarknetAddress | PrivateRecipient
): StarknetAddress {
  if (recipient === undefined) {
    throw new Error("recipient must not be undefined");
  }
  if (typeof recipient === "object" && recipient === null) {
    throw new Error("recipient must not be null");
  }
  return typeof recipient === "object" && "address" in recipient ? recipient.address : recipient;
}
