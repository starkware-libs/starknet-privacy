// src/elliptic.ts
import { computeHmacSignature } from "./auth.js";

interface ForwardRequest {
  ellipticUrl: string;
  ellipticKey: string;
  ellipticSecret: string;
  ellipticTimeoutMs: number;
  address: string;
}

export interface ForwardResponse {
  status: number;
  body: string;
  durationMs: number;
}

const ELLIPTIC_PATH = "/v2/wallet/synchronous";

export async function forwardToElliptic(
  request: ForwardRequest
): Promise<ForwardResponse> {
  const body = JSON.stringify({
    subject: {
      asset: "holistic",
      blockchain: "holistic",
      type: "address",
      hash: request.address,
    },
    type: "wallet_exposure",
  });

  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    request.ellipticSecret,
    timestamp,
    "POST",
    ELLIPTIC_PATH,
    body
  );

  const startTime = Date.now();
  const response = await fetch(request.ellipticUrl + ELLIPTIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-key": request.ellipticKey,
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    body,
    signal: AbortSignal.timeout(request.ellipticTimeoutMs),
  });
  const responseBody = await response.text();

  return {
    status: response.status,
    body: responseBody,
    durationMs: Date.now() - startTime,
  };
}
