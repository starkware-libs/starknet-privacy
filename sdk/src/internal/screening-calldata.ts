/**
 * Packing of the screening attestation into `apply_actions` calldata.
 *
 * The attestation travels as a Serde-encoded `Option<ScreeningAttestation>`
 * appended after the action span: `[0x1]` when absent, `[0x0, issued_at,
 * sig_r, sig_s]` when present. It is a separately-deserialized parameter, not
 * part of the proof-committed action span, so it can be swapped (e.g. a
 * timestamp refresh) without re-proving.
 *
 * Tag values follow Cairo's corelib `Serde` for `Option`: `Some` is `0`,
 * `None` is `1` — the reverse of the usual intuition.
 */

import type { AdditionalData } from "./proving-service.js";
import { toHex } from "../utils/convert.js";

const OPTION_SOME_TAG = "0x0";
const OPTION_NONE_TAG = "0x1";

/**
 * Serde-encode the screening attestation from a prove response's
 * `additional_data` as the trailing `Option<ScreeningAttestation>`
 * calldata felts. `sig_r`/`sig_s` are relayed verbatim (already 0x-hex);
 * `issued_at` (unix seconds) is hex-encoded.
 */
export function screeningCalldataSuffix(additionalData?: AdditionalData): string[] {
  const signature = additionalData?.signature;
  if (signature === undefined) {
    return [OPTION_NONE_TAG];
  }
  return [OPTION_SOME_TAG, toHex(BigInt(signature.issued_at)), signature.sig_r, signature.sig_s];
}
