#!/usr/bin/env npx tsx
/// <reference types="node" />
/**
 * Fetches the proving API OpenRPC spec from starkware-libs/sequencer and writes
 * it to tests/fixtures/proving_api_openrpc.json. Used in CI to test the SDK
 * against the latest spec; the committed fixture allows offline test runs.
 *
 * Usage: npm run fetch:proving-spec
 * Env:   SEQUENCER_SPEC_REF (default: main) — branch, tag, or full commit SHA to fetch from.
 *        Example (pin to a commit): SEQUENCER_SPEC_REF=657f8056197117c4935b1d694c119776911f0c72
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SPEC_PATH_IN_REPO =
  "crates/starknet_os_runner/resources/proving_api_openrpc.json";
const REF = process.env.SEQUENCER_SPEC_REF ?? "main";
const URL = `https://raw.githubusercontent.com/starkware-libs/sequencer/${REF}/${SPEC_PATH_IN_REPO}`;
const OUT_PATH = join(__dirname, "..", "tests", "fixtures", "proving_api_openrpc.json");

async function main(): Promise<void> {
  const res = await fetch(URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText} from ${URL}`);
  }
  const text = await res.text();
  JSON.parse(text); // validate JSON
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, text, "utf-8");
  console.log(`Wrote ${OUT_PATH} (ref=${REF})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
