// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RpcAction,
  validateRpcRequest,
  type RpcHandlerOptions,
} from "./rpc.js";
import {
  runInterceptors,
  notifyInterceptorError,
  notifyInterceptorComplete,
  type TransactionInterceptor,
} from "./interceptor.js";
import { jsonRpcError } from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./config.js";
import {
  registry,
  rpcRequestsTotal,
  requestDuration,
  upstreamResponses,
  upstreamDuration,
  errorsTotal,
  inFlightRequests,
} from "./metrics.js";
import { OhttpGateway, type OhttpServerContext } from "./ohttp.js";
import { isOHTTPError } from "ohttp-ts";

const TRANSACTION_REJECTED = 10000;
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

/** The result of processing a request body through the proxy logic. */
interface ProcessedResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  rpcAction: string;
  logFields: Record<string, unknown>;
}

export async function createProxyHandler(
  upstreamUrl: string,
  options: ProxyOptions
) {
  const upstreamBaseUrl = upstreamUrl.replace(/\/+$/, "");
  const interceptors = options.interceptors ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const upstreamTimeoutMs =
    options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const ohttpGateway = await OhttpGateway.generate();

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/metrics" && req.method === "GET") {
      const metricsBody = await registry.metrics();
      res.writeHead(200, { "content-type": registry.contentType });
      res.end(metricsBody);
      return;
    }

    if (req.url === "/ohttp-keys" && req.method === "GET") {
      const keyConfigBytes = ohttpGateway.keyConfigBytes();
      res.writeHead(200, {
        "content-type": "application/ohttp-keys",
        "cache-control": "public, max-age=3600",
        "content-length": String(keyConfigBytes.byteLength),
      });
      res.end(Buffer.from(keyConfigBytes));
      return;
    }

    inFlightRequests.inc();
    const startTime = Date.now();
    function finishRequest(rpcAction: string, fields: object) {
      const durationSeconds = (Date.now() - startTime) / 1000;
      inFlightRequests.dec();
      requestDuration.observe({ action: rpcAction }, durationSeconds);
      console.log(
        JSON.stringify({
          method: req.method,
          url: req.url,
          ...fields,
          latencyMs: Date.now() - startTime,
        })
      );
    }

    const declaredLength = parseInt(req.headers["content-length"] ?? "", 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBodyBytes) {
      errorsTotal.inc({ type: "payload_too_large" });
      finishRequest("error", { error: "payload_too_large" });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      req.destroy();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      errorsTotal.inc({ type: "payload_too_large" });
      finishRequest("error", { error: "payload_too_large" });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }

    // OHTTP-encapsulated request
    if (isOhttpContent(req)) {
      let innerRequest: Request;
      let ohttpContext: OhttpServerContext;
      try {
        const result = await ohttpGateway.decapsulateRequest(
          new Uint8Array(body)
        );
        innerRequest = result.request;
        ohttpContext = result.context;
      } catch (error) {
        const isOhttp = isOHTTPError(error);
        console.error(
          JSON.stringify({
            error: "ohttp_decapsulation_failed",
            code: isOhttp ? error.code : undefined,
          })
        );
        errorsTotal.inc({ type: "ohttp_decapsulation_failed" });
        finishRequest("error", { error: "ohttp_decapsulation_failed" });
        res.writeHead(422, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "failed to decapsulate OHTTP request" })
        );
        return;
      }

      const innerBody = Buffer.from(await innerRequest.arrayBuffer());
      const innerContentType = innerRequest.headers.get("content-type") ?? "";
      const innerUrl = new URL(innerRequest.url).pathname;
      const innerMethod = innerRequest.method;
      const innerHeaders: Record<string, string> = {};
      innerRequest.headers.forEach((value, key) => {
        innerHeaders[key] = value;
      });

      const result = await processBody(
        innerBody,
        innerContentType,
        innerUrl,
        innerMethod,
        innerHeaders,
        "ohttp"
      );

      // Encapsulate the response back into OHTTP
      const responseBody =
        typeof result.body === "string"
          ? result.body
          : new Uint8Array(result.body);
      const innerResponse = new Response(responseBody, {
        status: result.status,
        headers: result.headers,
      });
      const encapsulatedResponse =
        await ohttpContext.encapsulateResponse(innerResponse);
      const encapsulatedBody = Buffer.from(
        await encapsulatedResponse.arrayBuffer()
      );

      finishRequest(result.rpcAction, { ...result.logFields, ohttp: true });
      res.writeHead(200, {
        "content-type": "message/ohttp-res",
        "content-length": String(encapsulatedBody.byteLength),
      });
      res.end(encapsulatedBody);
      return;
    }

    // Plain (non-OHTTP) request — flatten multi-value headers for processBody.
    const flatHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        flatHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    const result = await processBody(
      body,
      req.headers["content-type"] ?? "",
      req.url ?? "/",
      req.method ?? "GET",
      flatHeaders,
      "plaintext"
    );

    finishRequest(result.rpcAction, result.logFields);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  };

  /**
   * Core request processing shared by both plain and OHTTP paths.
   * Handles JSON-RPC validation/forwarding and non-JSON passthrough.
   * Hoisted — defined after the return but callable from the handler.
   */
  async function processBody(
    body: Buffer,
    contentType: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    transport: "ohttp" | "plaintext"
  ): Promise<ProcessedResponse> {
    // JSON-RPC POST: validate before forwarding
    if (method === "POST" && contentType.includes("application/json")) {
      const verdict = validateRpcRequest(body.toString(), options);

      if (verdict.action === RpcAction.Error) {
        rpcRequestsTotal.inc({ action: "error", method: "", transport });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(verdict.response),
          rpcAction: "error",
          logFields: { rpcAction: "error" },
        };
      }

      if (verdict.action === RpcAction.ForwardWithInterceptors) {
        rpcRequestsTotal.inc({
          action: "forward_with_interceptors",
          method: "starknet_proveTransaction",
          transport,
        });

        // Fire upstream request in parallel with interceptors for latency.
        // If the interceptor rejects, we abort the in-flight upstream request.
        const abortController = new AbortController();
        const upstreamStart = Date.now();
        const upstreamPromise = forwardToUpstream(
          upstreamBaseUrl,
          body,
          abortController.signal,
          upstreamTimeoutMs
        ).catch((error) => {
          if (
            error instanceof Error &&
            error.name === "AbortError" &&
            abortController.signal.aborted
          ) {
            return null;
          }
          return { status: 502, body: "", error } as UpstreamResponse;
        });
        const interceptorVerdict = await runInterceptors(
          interceptors,
          verdict.transaction
        );

        if (interceptorVerdict.action === "stop") {
          await notifyInterceptorError(
            interceptors,
            TRANSACTION_REJECTED,
            verdict.transaction
          );
          console.error(JSON.stringify({ error: "transaction_rejected" }));
          abortController.abort();
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              jsonRpcError(
                verdict.requestId,
                TRANSACTION_REJECTED,
                "Transaction rejected",
                interceptorVerdict.reason
              )
            ),
            rpcAction: "forward_with_interceptors",
            logFields: {
              rpcAction: "forward_with_interceptors",
              interceptorVerdict: "stop",
            },
          };
        }

        // Interceptors passed — return upstream result.
        // upstreamResponse is never null here: abort only fires on the
        // "stop" branch above, and .catch converts non-abort errors to
        // an UpstreamResponse with an error field.
        const upstreamResponse = (await upstreamPromise)!;
        const upstreamMs = (Date.now() - upstreamStart) / 1000;
        if (upstreamResponse.error) {
          await notifyInterceptorError(
            interceptors,
            upstreamResponse.status,
            verdict.transaction
          );
          const message =
            upstreamResponse.error instanceof Error
              ? upstreamResponse.error.message
              : String(upstreamResponse.error);
          console.error(
            JSON.stringify({ error: "upstream_unreachable", message })
          );
          errorsTotal.inc({ type: "upstream_unreachable" });
          upstreamDuration.observe(upstreamMs);
          return {
            status: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "bad gateway" }),
            rpcAction: "forward_with_interceptors",
            logFields: {
              rpcAction: "forward_with_interceptors",
              interceptorVerdict: "continue",
              upstreamStatus: 502,
            },
          };
        }

        notifyInterceptorComplete(interceptors, verdict.transaction);
        upstreamResponses.inc({
          status_code: String(upstreamResponse.status),
        });
        upstreamDuration.observe(upstreamMs);
        return {
          status: upstreamResponse.status,
          headers: { "content-type": "application/json" },
          body: upstreamResponse.body,
          rpcAction: "forward_with_interceptors",
          logFields: {
            rpcAction: "forward_with_interceptors",
            interceptorVerdict: "continue",
            upstreamStatus: upstreamResponse.status,
          },
        };
      }

      // forward (specVersion, unknown methods when allowed)
      rpcRequestsTotal.inc({ action: "forward_as_is", method: "", transport });
      const forwardStart = Date.now();
      try {
        const upstreamResponse = await forwardToUpstream(
          upstreamBaseUrl,
          body,
          AbortSignal.timeout(upstreamTimeoutMs)
        );
        upstreamResponses.inc({
          status_code: String(upstreamResponse.status),
        });
        upstreamDuration.observe((Date.now() - forwardStart) / 1000);
        return {
          status: upstreamResponse.status,
          headers: { "content-type": "application/json" },
          body: upstreamResponse.body,
          rpcAction: "forward_as_is",
          logFields: {
            rpcAction: "forward_as_is",
            upstreamStatus: upstreamResponse.status,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({ error: "upstream_unreachable", message })
        );
        errorsTotal.inc({ type: "upstream_unreachable" });
        upstreamDuration.observe((Date.now() - forwardStart) / 1000);
        return {
          status: 502,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "bad gateway" }),
          rpcAction: "forward_as_is",
          logFields: { rpcAction: "forward_as_is", upstreamStatus: 502 },
        };
      }
    }

    // Non-JSON-RPC: forward as-is
    rpcRequestsTotal.inc({ action: "passthrough", method: "", transport });
    const targetUrl = upstreamBaseUrl + url;
    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key)) forwardHeaders.set(key, value);
    }

    const passthroughStart = Date.now();
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ error: "upstream_unreachable", message }));
      errorsTotal.inc({ type: "upstream_unreachable" });
      upstreamDuration.observe((Date.now() - passthroughStart) / 1000);
      return {
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "bad gateway" }),
        rpcAction: "passthrough",
        logFields: { rpcAction: "passthrough", upstreamStatus: 502 },
      };
    }

    upstreamResponses.inc({ status_code: String(upstreamResponse.status) });
    upstreamDuration.observe((Date.now() - passthroughStart) / 1000);

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key)) {
        responseHeaders[key] = value;
      }
    });

    const responseBody = await upstreamResponse.arrayBuffer();
    return {
      status: upstreamResponse.status,
      headers: responseHeaders,
      body: Buffer.from(responseBody),
      rpcAction: "passthrough",
      logFields: {
        rpcAction: "passthrough",
        upstreamStatus: upstreamResponse.status,
      },
    };
  }
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

function isOhttpContent(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.includes("message/ohttp-req");
}
