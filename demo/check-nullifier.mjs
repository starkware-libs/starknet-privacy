/**
 * Standalone script to check if a nullifier exists for a given note.
 *
 * Usage: node check-nullifier.mjs
 *
 * Uses the SDK's hash utilities to compute the nullifier, then calls the pool
 * contract's `nullifier_exists` view function via the RPC proxy.
 */

import { ec } from "starknet";
import { RpcProvider, Contract } from "starknet";

// --- Config ---
const RPC_URL = "http://127.0.0.1:8080/v1/debug/rpc_proxy";
const POOL_ADDRESS = "0x29a9cf26f2de1dbe16923fd6da791a2158497baeb9cc2fb8f99ed464938d731";

// Note data from the API response
const CHANNEL_KEY = 0x65bbd306e00dec23e2fffe764b4e7d5880a50ec8d81d71c3347ccd3f32f892bn;
const TOKEN = 0x7b19e89252b1ee5d7ff07a0e0e278b16b058f322053f799469b969e31b82969n;
const NOTE_INDEX = 3;
const NOTE_ID = 0x671a8199b0a8c1124b4bc076fdc4f758db05af6ed0aea958393f3a738831b67n;

// Alice's viewing key (owner private key)
const OWNER_PRIVATE_KEY = 0xA11CEn;

// --- Hash (matches SDK's hash function: h(h(data))) ---
function shortStringToFelt(str) {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    result = (result << 8n) | BigInt(str.charCodeAt(i));
  }
  return result;
}

function hash(...values) {
  const feltValues = values.map((v) =>
    typeof v === "string" ? shortStringToFelt(v) : BigInt(v)
  );
  const firstHash = ec.starkCurve.poseidonHashMany(feltValues);
  return ec.starkCurve.poseidonHashMany([firstHash]);
}

// --- Compute nullifier ---
const NULLIFIER_TAG = "NULLIFIER_TAG:V1";
const nullifier = hash(NULLIFIER_TAG, CHANNEL_KEY, TOKEN, NOTE_INDEX, 0n, OWNER_PRIVATE_KEY);

console.log("Note ID:          ", "0x" + NOTE_ID.toString(16));
console.log("Channel Key:      ", "0x" + CHANNEL_KEY.toString(16));
console.log("Token:            ", "0x" + TOKEN.toString(16));
console.log("Note Index:       ", NOTE_INDEX);
console.log("Owner Private Key:", "0x" + OWNER_PRIVATE_KEY.toString(16));
console.log("Computed Nullifier:", "0x" + nullifier.toString(16));
console.log();

// --- Call pool contract ---
const provider = new RpcProvider({ nodeUrl: RPC_URL });

const result = await provider.callContract({
  contractAddress: POOL_ADDRESS,
  entrypoint: "nullifier_exists",
  calldata: ["0x" + nullifier.toString(16)],
});
const exists = result[0] !== "0x0";
console.log("nullifier_exists: ", exists, `(raw: ${result[0]})`);

// Also verify note_id computation matches
const NOTE_ID_TAG = "NOTE_ID_TAG:V1";
const computedNoteId = hash(NOTE_ID_TAG, CHANNEL_KEY, TOKEN, NOTE_INDEX, 0n);
console.log();
console.log("Computed Note ID: ", "0x" + computedNoteId.toString(16));
console.log("Expected Note ID: ", "0x" + NOTE_ID.toString(16));
console.log("Note ID match:    ", computedNoteId === NOTE_ID);
