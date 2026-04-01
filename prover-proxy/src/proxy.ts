// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RpcAction,
  validateRpcRequest,
  type RpcHandlerOptions,
} from "./rpc.js";
import { runInterceptors, type TransactionInterceptor } from "./interceptor.js";
import { jsonRpcError } from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./config.js";

const TRANSACTION_REJECTED = -32001;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface ProxyOptions extends RpcHandlerOptions {
  interceptors?: TransactionInterceptor[];
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

interface UpstreamResponse {
  status: number;
  body: string;
  error?: unknown;
}

export function createProxyHandler(
  upstreamUrl: string,
  options: ProxyOptions = { forwardUnknownMethods: false }
) {
  const upstreamBaseUrl = upstreamUrl.replace(/\/+$/, "");
  const interceptors = options.interceptors ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const upstreamTimeoutMs =
    options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBodyBytes) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.destroy();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }

    // JSON-RPC POST: validate before forwarding
    if (req.method === "POST" && isJsonContent(req)) {
      const verdict = validateRpcRequest(body.toString(), options);

      if (verdict.action === RpcAction.Error) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(verdict.response));
        return;
      }

      if (verdict.action === RpcAction.ForwardWithInterceptors) {
        // Fire upstream request in parallel with interceptors for latency.
        // If the interceptor rejects, we abort the in-flight upstream request.
        const abortController = new AbortController();
        const upstreamPromise = forwardToUpstream(
          upstreamBaseUrl,
          body,
          abortController.signal,
          upstreamTimeoutMs
        ).catch((error) => {
          if (error instanceof Error && error.name === "AbortError")
            return null;
          return { status: 502, body: "", error } as UpstreamResponse;
        });
        const interceptorVerdict = await runInterceptors(
          interceptors,
          verdict.transaction
        );

        if (interceptorVerdict.action === "stop") {
          console.error(
            JSON.stringify({ error: "transaction_rejected" })
          );
          abortController.abort();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              jsonRpcError(
                verdict.requestId,
                TRANSACTION_REJECTED,
                "Transaction rejected",
                interceptorVerdict.reason
              )
            )
          );
          return;
        }

        // Interceptors passed — return upstream result.
        // upstreamResponse is never null here: abort only fires on the
        // "stop" branch above, and .catch converts non-abort errors to
        // an UpstreamResponse with an error field.
        const upstreamResponse = (await upstreamPromise)!;
        if (upstreamResponse.error) {
          const message =
            upstreamResponse.error instanceof Error
              ? upstreamResponse.error.message
              : String(upstreamResponse.error);
          console.error(
            JSON.stringify({ error: "upstream_unreachable", message })
          );
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad gateway" }));
        } else {
          res.writeHead(upstreamResponse.status, {
            "content-type": "application/json",
          });
          res.end(upstreamResponse.body);
        }
        return;
      }

      // forward (specVersion, unknown methods when allowed)
      try {
        const upstreamResponse = await forwardToUpstream(
          upstreamBaseUrl,
          body,
          AbortSignal.timeout(upstreamTimeoutMs)
        );
        res.writeHead(upstreamResponse.status, {
          "content-type": "application/json",
        });
        res.end(upstreamResponse.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({ error: "upstream_unreachable", message })
        );
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad gateway" }));
      }
      return;
    }

    // Non-JSON-RPC: forward as-is
    const targetUrl = upstreamBaseUrl + (req.url ?? "/");
    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) continue;
      if (Array.isArray(value)) {
        for (const entry of value) forwardHeaders.append(key, entry);
      } else {
        forwardHeaders.set(key, value);
      }
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: req.method ?? "GET",
        headers: forwardHeaders,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ error: "upstream_unreachable", message }));
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad gateway" }));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key)) {
        responseHeaders[key] = value;
      }
    });

    res.writeHead(upstreamResponse.status, responseHeaders);
    const responseBody = await upstreamResponse.arrayBuffer();
    res.end(Buffer.from(responseBody));
  };
}

async function forwardToUpstream(
  upstream: string,
  body: Buffer,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<UpstreamResponse> {
  const signals = [
    signal,
    timeoutMs ? AbortSignal.timeout(timeoutMs) : null,
  ].filter(Boolean) as AbortSignal[];
  const combinedSignal =
    signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const response = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(body),
    signal: combinedSignal,
  });
  return { status: response.status, body: await response.text() };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    function resolveOnce(value: Buffer) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    function rejectOnce(error: Error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        rejectOnce(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveOnce(Buffer.concat(chunks)));
    req.on("error", (error) => rejectOnce(error));
    req.on("close", () => {
      if (!req.complete) {
        rejectOnce(new Error("request closed before body was fully received"));
      }
    });
  });
}

function isJsonContent(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.includes("application/json");
}
