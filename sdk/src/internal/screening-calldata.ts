/**
 * Packing of the screening attestation into `apply_actions` calldata.
 *
 * The attestation travels as a Serde-encoded `Option<ScreeningAttestation>`
 * appended after the action span: `[0x1]` when absent, `[0x0, issued_at,
 * sig_r, sig_s]` when present. It is a separately-deserialized parameter, not
 * part of the proof-committed action span, so it can be swapped (e.g. a
 * timestamp refresh) without re-proving.
 *
 * Cairo's `Option` Serde encodes the active variant index first: `Some` is 0,
 * `None` is 1 (corelib declaration order) — hence the tags below.
 */

import type { AdditionalData } from "../interfaces.js";
import { toHex } from "../utils/convert.js";

const OPTION_SOME_TAG = "0x0";
const OPTION_NONE_TAG = "0x1";

/**
 * Serde-encode the screening attestation from a proof's `additionalData` as the
 * trailing `Option<ScreeningAttestation>` calldata felts. `sig_r`/`sig_s` are
 * relayed verbatim (already 0x-hex); `issued_at` (unix seconds) is hex-encoded.
 */
export function screeningCalldataSuffix(additionalData?: AdditionalData): string[] {
  const signature = additionalData?.signature;
  if (signature === undefined) {
    return [OPTION_NONE_TAG];
  }
  return [OPTION_SOME_TAG, toHex(BigInt(signature.issued_at)), signature.sig_r, signature.sig_s];
}
