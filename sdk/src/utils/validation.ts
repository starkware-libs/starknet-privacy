import { num } from "starknet";
import type { Amount, Open, PrivateRecipient, StarknetAddress, ViewingKey } from "../interfaces.js";
import { MAX_VIEWING_KEY } from "../interfaces.js";

// ============ Validation Utilities ============

/**
 * Asserts a condition is truthy, throwing an error with the given message if not.
 * Browser-compatible alternative to Node's assert.
 * @param condition - The condition to check
 * @param message - Error message if condition is falsy
 * @throws Error if condition is falsy
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

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

/**
 * Type guard to check if a value is an Open marker (for open notes).
 * @param value - The value to check (Amount or Open)
 * @returns true if the value is an Open marker, false if it's an Amount
 */
export function isOpen(value: Amount | Open): value is Open {
  return typeof value !== "bigint";
}

/**
 * Calculates the surplus for a token given inputs and outputs.
 * Surplus = (deposits + useNotes) - (createNotes + withdraws)
 * Open amounts in createNotes are treated as 0.
 *
 * @param deposits - Array of deposit amounts
 * @param useNotes - Array of input note amounts
 * @param createNotes - Array of output note amounts (can include Open markers)
 * @param withdraws - Array of withdrawal amounts
 * @returns The surplus amount (must be non-negative)
 * @throws Error if the total is negative (outputs exceed inputs)
 */
export function calculateSurplus(
  deposits: Amount[],
  useNotes: Amount[],
  createNotes: (Amount | Open)[],
  withdraws: Amount[]
): bigint {
  const sumDeposits = deposits.reduce((sum, a) => sum + a, 0n);
  const sumUseNotes = useNotes.reduce((sum, a) => sum + a, 0n);
  const sumCreateNotes = createNotes.reduce<bigint>((sum, a) => sum + (isOpen(a) ? 0n : a), 0n);
  const sumWithdraws = withdraws.reduce((sum, a) => sum + a, 0n);

  const total = sumDeposits + sumUseNotes - sumCreateNotes - sumWithdraws;
  assert(total >= 0n, `Outputs exceed inputs: deficit of ${-total}`);
  return total;
}
