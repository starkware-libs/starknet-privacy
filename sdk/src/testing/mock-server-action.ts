/**
 * MockServerAction - Simple callback wrapper for mock pool state mutations.
 *
 * This type wraps state mutations in a way that mimics the real contract's
 * ServerAction pattern. The `type` field is for debugging/logging only;
 * the actual mutation is performed by calling `apply()`.
 */

export type MockServerAction = {
  /** Action type for debugging/logging (e.g., "WriteIfZero", "AppendToVec") */
  type: string;
  /** Closure that performs the state mutation */
  apply: () => void;
  /** actions that shouldn't be applied in the private side */
  deferred?: boolean;
};
