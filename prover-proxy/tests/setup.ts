// Ensure globalThis.crypto is available for hpke/ohttp-ts in Node 18.
// Node 18.19+ exposes crypto globally, but vitest's VM context may not
// inherit it. This polyfill bridges the gap.
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}
