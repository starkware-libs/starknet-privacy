// src/index.ts
import * as ff from "@google-cloud/functions-framework";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { ConfigLoader } from "./config.js";
import { forwardToElliptic } from "./elliptic.js";
import { createHandler } from "./handler.js";
import { mockableForwarder } from "./mock-elliptic.js";

function createSecretFetcher(): () => Promise<string> {
  const client = new SecretManagerServiceClient();
  const secretName = process.env.PROXY_CONFIG;
  return async () => {
    if (!secretName) throw new Error("PROXY_CONFIG env var not set");
    const [version] = await client.accessSecretVersion({
      name: secretName,
    });
    return version.payload?.data?.toString() ?? "";
  };
}

const configLoader = new ConfigLoader(createSecretFetcher());

ff.http(
  "ellipticProxy",
  createHandler(configLoader, mockableForwarder(forwardToElliptic))
);
