// src/server.ts
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { Config } from "./config.js";

export function startServer(
  config: Config,
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Server> {
  const server = config.tls
    ? createHttpsServer(
        {
          cert: readFileSync(config.tls.certPath),
          key: readFileSync(config.tls.keyPath),
        },
        handler
      )
    : createHttpServer(handler);

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const protocol = config.tls ? "https" : "http";
      console.log(`Listening on ${protocol}://${config.host}:${config.port}`);
      resolve(server);
    });
  });
}
