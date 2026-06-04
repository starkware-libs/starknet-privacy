// src/mock-elliptic.ts
//
// In-process mock Elliptic upstream for test deployments, selected by a
// "mock:" elliptic.url. Only the upstream is faked: the proxy pipeline (auth,
// operator lists, scoring, caching, verdicts) runs unchanged and the handler
// never knows whether screening is mock. The mock answers every address with
// Elliptic's 404 "not in blockchain", which the handler allows — deterministic
// blocks in mock deployments come from the operator deny list, which applies
// in every mode.
import { isMockEllipticUrl } from "./config.js";
import type { ForwardResponse } from "./elliptic.js";
import type { Forwarder } from "./handler.js";

export function mockForward(): ForwardResponse {
  return { status: 404, durationMs: 0, body: "{}" };
}

// Composition-root forwarder: dispatches to the mock upstream when the
// configured elliptic.url selects it, to the live forwarder otherwise.
export function mockableForwarder(liveForward: Forwarder): Forwarder {
  return async (request) =>
    isMockEllipticUrl(request.ellipticUrl)
      ? mockForward()
      : liveForward(request);
}
