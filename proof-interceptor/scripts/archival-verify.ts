// scripts/archival-verify.ts
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Storage } from "@google-cloud/storage";
import { deriveKeyPair, decryptArchival } from "../src/archival-crypto.js";
import { parseArchivalFile } from "../src/archival-storage.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(pairs.map((b) => parseInt(b, 16)));
}

export type VerifyResult =
  | { status: "ok" }
  | { status: "skipped_sender" }
  | { status: "skipped_no_key" }
  | { status: "decrypt_failed" }
  | { status: "invalid_json" };

export function buildKeyMap(viewingKeys: string[]): Map<string, Uint8Array> {
  const keyMap = new Map<string, Uint8Array>();
  for (const key of viewingKeys) {
    const pair = deriveKeyPair(key);
    keyMap.set(bytesToHex(pair.publicKey), pair.secretKey);
  }
  return keyMap;
}

export function verifyFile(
  data: Buffer,
  keyMap: Map<string, Uint8Array>
): VerifyResult {
  const parsed = parseArchivalFile(data);

  if (parsed.type === "sender") return { status: "skipped_sender" };

  const secretKey = keyMap.get(parsed.publicKeyHex);
  if (!secretKey) return { status: "skipped_no_key" };

  const publicKey = hexToBytes(parsed.publicKeyHex);
  const decrypted = decryptArchival(parsed.ciphertext, publicKey, secretKey);
  if (!decrypted) return { status: "decrypt_failed" };

  try {
    JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return { status: "invalid_json" };
  }

  return { status: "ok" };
}

// CLI entry point — only runs when executed directly
async function main() {
  const { values } = parseArgs({
    options: {
      bucket: { type: "string" },
      keys: { type: "string" },
      prefix: { type: "string" },
    },
  });

  if (!values.bucket || !values.keys) {
    console.error(
      "Usage: --bucket <name> --keys <file> [--prefix <YYYY-MM-DD>]"
    );
    process.exit(1);
  }

  const viewingKeys = readFileSync(values.keys, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const keyMap = buildKeyMap(viewingKeys);
  console.log(
    `Loaded ${viewingKeys.length} viewing keys (${keyMap.size} unique public keys)`
  );

  const storage = new Storage();
  const [files] = await storage
    .bucket(values.bucket)
    .getFiles({ prefix: values.prefix });

  const summary = {
    total: 0,
    ok: 0,
    skippedSender: 0,
    skippedNoKey: 0,
    failed: 0,
  };

  for (const file of files) {
    if (!file.name.endsWith(".enc")) continue;
    summary.total++;

    const [content] = await file.download();
    const result = verifyFile(content, keyMap);

    switch (result.status) {
      case "ok":
        summary.ok++;
        console.log(`OK: ${file.name}`);
        break;
      case "skipped_sender":
        summary.skippedSender++;
        break;
      case "skipped_no_key":
        summary.skippedNoKey++;
        console.warn(`NO KEY: ${file.name}`);
        break;
      case "decrypt_failed":
      case "invalid_json":
        summary.failed++;
        console.error(`FAILED (${result.status}): ${file.name}`);
        break;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total: ${summary.total}`);
  console.log(`Decrypted OK: ${summary.ok}`);
  console.log(`Skipped (sender): ${summary.skippedSender}`);
  console.log(`Skipped (no key): ${summary.skippedNoKey}`);
  console.log(`Failed: ${summary.failed}`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

// Run main only when this file is the entry point
const isMain =
  process.argv[1]?.endsWith("archival-verify.ts") ||
  process.argv[1]?.endsWith("archival-verify.js");
if (isMain) main();
