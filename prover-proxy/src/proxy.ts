// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { RpcAction, validateRpcRequest, type RpcHandlerOptions } from "./rpc.js";

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB, matching apollo_http_server

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface ProxyOptions extends RpcHandlerOptions {
  maxBodyBytes?: number;
}

export function createProxyHandler(
  upstreamUrl: string,
  options: ProxyOptions = { forwardUnknownMethods: false }
) {
  const upstream = upstreamUrl.replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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

      // Forward the raw JSON-RPC body to upstream
      try {
        const upstreamResponse = await forwardToUpstream(upstream, body);
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
    const targetUrl = upstream + (req.url ?? "/");
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !HOP_BY_HOP_HEADERS.has(key)) {
        forwardHeaders[key] = value;
      }
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: req.method ?? "GET",
        headers: forwardHeaders,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
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

interface UpstreamResponse {
  status: number;
  body: string;
}

async function forwardToUpstream(
  upstream: string,
  body: Buffer
): Promise<UpstreamResponse> {
  const response = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(body),
  });
  return { status: response.status, body: await response.text() };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!exceeded) reject(error);
    });
  });
}

function isJsonContent(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"] ?? "";
  return contentType.includes("application/json");
}
