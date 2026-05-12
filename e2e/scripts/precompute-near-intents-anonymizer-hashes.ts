/**
 * Pre-compute the Sierra + CASM class hashes for `MailboxReceiver` and
 * `NearIntentsAnonymizer` from the on-disk artifacts, without touching the
 * network.
 *
 * Useful for handing the SDK dev a stable `RECEIVER_CLASS_HASH` ahead of
 * the actual Sepolia deploy — they can hardcode it into their mailbox
 * derivation immediately, while the live declaration happens in parallel.
 *
 * Class hashes are deterministic in `(compiler output)`, so as long as the
 * scarb build is reproducible, these match what `account.declare(...)` will
 * compute on-chain.
 *
 * Prerequisites:
 *   scarb build -p near_intents_anonymizer   # from repo root
 *
 * Usage:
 *   cd e2e && tsx scripts/precompute-near-intents-anonymizer-hashes.ts
 */

import { readFileSync } from "fs";
import { hash } from "starknet";
import { artifactPair, repoRoot } from "../src/utils.js";
import { join } from "path";

function classHashes(prefix: string, contractName: string): {
  classHash: string;
  compiledClassHash: string;
} {
  const { classPath, compiledPath } = artifactPair(
    join(repoRoot(), "target/dev"),
    prefix,
    contractName,
  );
  const contractClass = JSON.parse(readFileSync(classPath, "utf8"));
  const compiledClass = JSON.parse(readFileSync(compiledPath, "utf8"));
  return {
    classHash: hash.computeContractClassHash(contractClass),
    compiledClassHash: hash.computeCompiledClassHash(compiledClass),
  };
}

const receiver = classHashes("near_intents_anonymizer", "MailboxReceiver");
const anonymizer = classHashes(
  "near_intents_anonymizer",
  "NearIntentsAnonymizer",
);

console.log("# MailboxReceiver");
console.log(`  Sierra class hash:    ${receiver.classHash}`);
console.log(`  Compiled class hash:  ${receiver.compiledClassHash}`);
console.log();
console.log("# NearIntentsAnonymizer");
console.log(`  Sierra class hash:    ${anonymizer.classHash}`);
console.log(`  Compiled class hash:  ${anonymizer.compiledClassHash}`);
console.log();
console.log("# SDK env (snippet)");
console.log(`NEAR_INTENTS_RECEIVER_CLASS_HASH=${receiver.classHash}`);
console.log(`NEAR_INTENTS_ANONYMIZER_CLASS_HASH=${anonymizer.classHash}`);
