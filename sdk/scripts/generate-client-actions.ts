#!/usr/bin/env npx tsx
/**
 * Generates TypeScript client action types from the ABI
 *
 * Usage: npx tsx scripts/generate-client-actions.ts
 *
 * Type mappings:
 *   core::felt252                                    → bigint
 *   core::integer::u128                              → bigint
 *   core::integer::u64                               → bigint
 *   core::integer::u32                               → number
 *   core::starknet::contract_address::ContractAddress → StarknetAddressBigint
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PrivacyPoolABI } from "../src/internal/abi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_FILE = join(__dirname, "../src/internal/client-actions.ts");

// Type mappings from Cairo ABI types to TypeScript
const TYPE_MAP: Record<string, string> = {
  "core::felt252": "bigint",
  "core::integer::u128": "bigint",
  "core::integer::u64": "bigint",
  "core::integer::u32": "number",
  "core::starknet::contract_address::ContractAddress": "StarknetAddressBigint",
  "core::bool": "boolean",
};

const mapType = (abiType: string): string => {
  const mapped = TYPE_MAP[abiType];
  if (!mapped) {
    console.warn(`  Warning: Unknown type "${abiType}", using "unknown"`);
    return "unknown";
  }
  return mapped;
};

const typeName = (fullName: string): string => fullName.split("::").pop()!;

const findEnum = (name: string) =>
  PrivacyPoolABI.find((e) => e.type === "enum" && e.name === name) as
    | { type: "enum"; name: string; variants: { name: string; type: string }[] }
    | undefined;

const findStruct = (name: string) =>
  PrivacyPoolABI.find((e) => e.type === "struct" && e.name === name) as
    | { type: "struct"; name: string; members: { name: string; type: string }[] }
    | undefined;

function main(): void {
  console.log("Generating client actions from ABI...");

  const clientAction = findEnum("privacy::actions::ClientAction");
  if (!clientAction) {
    throw new Error("Could not find ClientAction enum in ABI");
  }

  console.log(`Found ClientAction enum with ${clientAction.variants.length} variants`);
  for (const v of clientAction.variants) {
    console.log(`  - ${v.name}: ${typeName(v.type)}`);
  }

  const output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * Generated from sdk/src/internal/abi.ts
 * Run: npx tsx scripts/generate-client-actions.ts
 */

import { Call } from "starknet";
import { StarknetAddressBigint } from "../interfaces.js";

${clientAction.variants
  .map((v) => {
    const struct = findStruct(v.type)!;
    return `export type ${typeName(struct.name)} = {
${struct.members.map((m) => `  ${m.name}: ${mapType(m.type)};`).join("\n")}
};`;
  })
  .join("\n\n")}

export type FollowupCallInput = {
  call: Call;
};

/**
 * Union of all client actions.
 */
export type ClientAction =
${clientAction.variants.map((v) => `  | { type: "${v.name}"; input: ${typeName(v.type)} }`).join("\n")}
  | { type: "FollowupCall"; input: FollowupCallInput };

/** All valid client action type names */
export const CLIENT_ACTION_TYPES = [
${clientAction.variants.map((v) => `  "${v.name}",`).join("\n")}
  "FollowupCall",
] as const;

export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];
`;

  console.log(`\nWriting output to: ${OUTPUT_FILE}`);
  writeFileSync(OUTPUT_FILE, output);

  console.log("Done!");
}

main();
