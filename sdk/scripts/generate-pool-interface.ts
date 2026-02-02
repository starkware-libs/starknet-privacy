#!/usr/bin/env npx tsx
/**
 * Generates PoolContractInterface and related struct types from the ABI
 *
 * Usage: npx tsx scripts/generate-pool-interface.ts
 *
 * Type mappings for inputs (accepting values):
 *   core::felt252                                    → BigNumberish
 *   core::integer::u64                               → BigNumberish
 *   core::integer::u32                               → number
 *   core::starknet::contract_address::ContractAddress → BigNumberish
 *
 * Type mappings for outputs (returned values):
 *   core::felt252                                    → BigNumberish
 *   core::integer::u64                               → bigint | number
 *   core::integer::u32                               → number
 *   core::bool                                       → boolean
 *   core::starknet::contract_address::ContractAddress → BigNumberish
 *   Structs                                          → Generated type name
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PrivacyPoolABI } from "../src/internal/abi.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_FILE = join(__dirname, "../src/internal/pool-contract-interface.ts");

// Type mappings for INPUT parameters (accepting values)
const INPUT_TYPE_MAP: Record<string, string> = {
  "core::felt252": "BigNumberish",
  "core::integer::u128": "BigNumberish",
  "core::integer::u64": "BigNumberish",
  "core::integer::u32": "number",
  "core::starknet::contract_address::ContractAddress": "BigNumberish",
  "core::bool": "boolean",
};

// Type mappings for OUTPUT/RETURN values
const OUTPUT_TYPE_MAP: Record<string, string> = {
  "core::felt252": "BigNumberish",
  "core::integer::u128": "bigint",
  "core::integer::u64": "bigint | number",
  "core::integer::u32": "number",
  "core::starknet::contract_address::ContractAddress": "BigNumberish",
  "core::bool": "boolean",
};

// Structs to generate (Cairo name → TypeScript name)
// Note renamed to NoteData to avoid conflict with SDK's Note interface
const STRUCT_RENAMES: Record<string, string> = {
  "privacy::objects::Note": "NoteData",
};

// Structs that should be generated (in order)
const STRUCTS_TO_GENERATE = [
  "privacy::objects::EncChannelInfo",
  "privacy::objects::EncSubchannelInfo",
  "privacy::objects::EncOutgoingChannelInfo",
  "privacy::objects::Note",
  "privacy::objects::EncPrivateKey",
];

type AbiStruct = {
  type: "struct";
  name: string;
  members: { name: string; type: string }[];
};

type AbiFunction = {
  type: "function";
  name: string;
  inputs: { name: string; type: string }[];
  outputs: { type: string }[];
  state_mutability: string;
};

type AbiInterface = {
  type: "interface";
  name: string;
  items: AbiFunction[];
};

const findStruct = (name: string): AbiStruct | undefined =>
  PrivacyPoolABI.find((e) => e.type === "struct" && e.name === name) as AbiStruct | undefined;

const findInterface = (name: string): AbiInterface | undefined =>
  PrivacyPoolABI.find((e) => e.type === "interface" && e.name === name) as
    | AbiInterface
    | undefined;

const getTypeName = (cairoType: string): string => {
  if (STRUCT_RENAMES[cairoType]) return STRUCT_RENAMES[cairoType];
  return cairoType.split("::").pop()!;
};

const mapInputType = (cairoType: string): string => {
  const mapped = INPUT_TYPE_MAP[cairoType];
  if (mapped) return mapped;
  // Check if it's a known struct
  if (STRUCTS_TO_GENERATE.includes(cairoType)) return getTypeName(cairoType);
  console.warn(`  Warning: Unknown input type "${cairoType}", using "unknown"`);
  return "unknown";
};

const mapOutputType = (cairoType: string): string => {
  const mapped = OUTPUT_TYPE_MAP[cairoType];
  if (mapped) return mapped;
  // Check if it's a known struct
  if (STRUCTS_TO_GENERATE.includes(cairoType)) return getTypeName(cairoType);
  console.warn(`  Warning: Unknown output type "${cairoType}", using "unknown"`);
  return "unknown";
};

const toCamelCase = (snakeCase: string): string => {
  return snakeCase.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
};

function main(): void {
  console.log("Generating PoolContractInterface from ABI...");

  // Find IViews interface
  const iViews = findInterface("privacy::interface::IViews");
  if (!iViews) {
    throw new Error("Could not find IViews interface in ABI");
  }

  console.log(`Found IViews interface with ${iViews.items.length} functions`);

  // Generate struct types
  console.log("\nGenerating struct types:");
  const structDefs = STRUCTS_TO_GENERATE.map((structName) => {
    const struct = findStruct(structName);
    if (!struct) {
      throw new Error(`Could not find struct ${structName} in ABI`);
    }
    const tsName = getTypeName(structName);
    console.log(`  - ${tsName} (from ${structName})`);
    return `export type ${tsName} = {
${struct.members.map((m) => `  ${m.name}: ${mapOutputType(m.type)};`).join("\n")}
};`;
  }).join("\n\n");

  // Generate interface methods
  console.log("\nGenerating interface methods:");
  const methodDefs = iViews.items
    .filter((item) => item.state_mutability === "view")
    .map((fn) => {
      const params = fn.inputs
        .map((input) => `${toCamelCase(input.name)}: ${mapInputType(input.type)}`)
        .join(", ");
      const returnType =
        fn.outputs.length === 0 ? "void" : mapOutputType(fn.outputs[0].type);
      console.log(`  - ${fn.name}(${fn.inputs.map((i) => i.name).join(", ")}) -> ${returnType}`);
      return `  ${fn.name}(${params}): ${returnType} | Promise<${returnType}>;`;
    })
    .join("\n");

  const output = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * Generated from sdk/src/internal/abi.ts
 * Run: npx tsx scripts/generate-pool-interface.ts
 */

import { BigNumberish } from "starknet";

// ============ Struct Types ============

${structDefs}

// ============ Pool Contract Interface ============

/**
 * Interface for pool contract view methods.
 * Generated from IViews interface in the ABI.
 *
 * Return types are widened to accept sync and async implementations:
 * - Methods can return T | Promise<T>
 * - Implementations should defensively convert values with toBigInt()
 */
export interface PoolContractInterface {
${methodDefs}
}
`;

  console.log(`\nWriting output to: ${OUTPUT_FILE}`);
  writeFileSync(OUTPUT_FILE, output);

  console.log("Done!");
}

main();
