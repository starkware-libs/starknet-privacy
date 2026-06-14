/**
 * Minimal OHTTP relay for E2E testing.
 *
 * Mirrors the Cloudflare privacy-gateway-relay Worker pattern:
 * validates POST + message/ohttp-req content type, then proxies
 * the opaque body to the gateway URL. The relay performs zero
 * cryptographic work — all OHTTP envelope processing happens at
 * the client and gateway.
 *
 * @see https://github.com/cloudflare/privacy-gateway-relay
 */

import http from "node:http";

export interface OhttpRelay {
  url: string;
  close: () => Promise<void>;
}

export async function startOhttpRelay(gatewayUrl: string): Promise<OhttpRelay> {
  const target = new URL(gatewayUrl);
  const server = http.createServer((clientRequest, clientResponse) => {
    if (clientRequest.method !== "POST") {
      clientResponse.writeHead(400).end("Invalid request");
      return;
    }
    const contentType = clientRequest.headers["content-type"] ?? "";
    if (!contentType.includes("message/ohttp-req")) {
      clientResponse.writeHead(400).end("Invalid request");
      return;
    }

    const proxyRequest = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "POST",
        headers: { "content-type": "message/ohttp-req" },
      },
      (proxyResponse) => {
        clientResponse.writeHead(
          proxyResponse.statusCode!,
          proxyResponse.headers,
        );
        proxyResponse.pipe(clientResponse);
      },
    );
    proxyRequest.on("error", () => clientResponse.writeHead(502).end());
    clientRequest.pipe(proxyRequest);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
