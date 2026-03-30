import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = process.env.ENV_FILE ?? ".vercel/.env.preview.local";
const OUT_FILE = process.env.OUT_FILE ?? ".env";

// Pull env from Vercel
const vercelArgs = ["pull", "--yes", "--environment=preview"];
if (process.env.VERCEL_TOKEN) {
  vercelArgs.push(`--token=${process.env.VERCEL_TOKEN}`);
}
execSync(`npx vercel ${vercelArgs.join(" ")}`, { stdio: "inherit" });

// Read the pulled env file
const envContent = readFileSync(ENV_FILE, "utf-8");
const lines = envContent.split("\n");

// Parse all env vars into a map
const envVars = new Map<string, string>();
for (const line of lines) {
  const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (match) {
    // Strip surrounding quotes from value
    const value = match[2].replace(/^"(.*)"$/, "$1");
    envVars.set(match[1], value);
  }
}

// Collect output lines: VITE_* and WS_URL
const outputLines: string[] = [];
for (const [key, value] of envVars) {
  if (key.startsWith("VITE_") || key === "WS_URL") {
    outputLines.push(`${key}=${value}`);
  }
}

// Rewrite backend URLs
const backendIndexerUrl = envVars.get("BACKEND_INDEXER_URL");
if (backendIndexerUrl) {
  const index = outputLines.findIndex((line) =>
    line.startsWith("VITE_INDEXER_URL="),
  );
  if (index !== -1) {
    outputLines[index] = `VITE_INDEXER_URL=${backendIndexerUrl}`;
  }
}

const backendProverUrl = envVars.get("BACKEND_PROVER_URL");
if (backendProverUrl) {
  const index = outputLines.findIndex((line) =>
    line.startsWith("VITE_PROVING_SERVICE_URL="),
  );
  if (index !== -1) {
    outputLines[index] = `VITE_PROVING_SERVICE_URL=${backendProverUrl}`;
  }
}

const backendRpcUrl = envVars.get("BACKEND_RPC_URL");
if (backendRpcUrl) {
  const index = outputLines.findIndex((line) =>
    line.startsWith("VITE_RPC_URL="),
  );
  if (index !== -1) {
    // Strip /api prefix from the original path, prepend backend host
    const originalValue = envVars.get("VITE_RPC_URL") ?? "";
    const rpcPath = originalValue.replace(/^\/api/, "");
    outputLines[index] = `VITE_RPC_URL=${backendRpcUrl}${rpcPath}`;
  }
}

writeFileSync(OUT_FILE, outputLines.join("\n") + "\n");
console.log(`Wrote ${OUT_FILE}`);
