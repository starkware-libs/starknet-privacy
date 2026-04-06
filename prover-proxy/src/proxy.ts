// src/proxy.ts
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB, matching apollo_http_server

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

export function createProxyHandler(
  upstreamUrl: string,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES
) {
  const upstream = upstreamUrl.replace(/\/+$/, "");

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

    const targetUrl = upstream + (req.url ?? "/");

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_HEADERS.has(key)) continue;
      if (typeof value === "string") {
        forwardHeaders[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        forwardHeaders[key] = value.join(", ");
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
