// src/mock-elliptic.ts
//
// In-process mock Elliptic upstream for test deployments, selected by a
// "mock:" elliptic.url. Only the upstream is faked: the proxy pipeline (auth,
// scoring, caching, verdicts) runs unchanged and the handler never knows
// whether screening is mock. Deny-listed addresses score as sanctioned;
// everything else returns Elliptic's 404 "not in blockchain", which the
// handler allows.
import { isMockEllipticUrl } from "./config.js";
import type { ForwardResponse } from "./elliptic.js";
import type { ConfigSource, Forwarder } from "./handler.js";

// A response scoreResponse() blocks: the sanctions rule with a matched
// element over every threshold, mirroring the shape of a real Elliptic
// wallet-exposure response.
const SANCTIONED_RESPONSE_BODY = JSON.stringify({
  process_status: "complete",
  evaluation_detail: {
    source: [
      {
        rule_id: "1f86dce1-166a-4749-a5df-3972fae7635a",
        matched_elements: [
          {
            contribution_percentage: 5,
            contribution_value: { usd: 100 },
            counterparty_percentage: 10,
            counterparty_value: { usd: 50 },
          },
        ],
      },
    ],
  },
});

export function mockForward(
  denyListAddresses: string[] | undefined,
  address: string
): ForwardResponse {
  // Match on the canonical felt (BigInt) so a zero-padded deny entry matches
  // the leading-zero-stripped address callers send. Entries are validated as
  // hex felts at config load, so BigInt() cannot throw.
  const addressFelt = BigInt(address);
  const isSanctioned =
    denyListAddresses?.some((entry) => BigInt(entry) === addressFelt) ?? false;
  return isSanctioned
    ? { status: 200, durationMs: 0, body: SANCTIONED_RESPONSE_BODY }
    : { status: 404, durationMs: 0, body: "{}" };
}

// Composition-root forwarder: dispatches to the mock upstream when the
// configured elliptic.url selects it, to the live forwarder otherwise.
export function mockableForwarder(
  configSource: ConfigSource,
  liveForward: Forwarder
): Forwarder {
  return async (request) => {
    if (!isMockEllipticUrl(request.ellipticUrl)) return liveForward(request);
    const config = await configSource.get();
    return mockForward(config.additionalBlockedAddresses, request.address);
  };
}
