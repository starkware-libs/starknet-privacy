/**
 * Declare and deploy `MailboxReceiver` + `NearIntentsAnonymizer` to a live
 * Starknet network.
 *
 * Declares the receiver class first (its class hash is a constructor arg
 * for the anonymizer), then declares and deploys the anonymizer wired to
 * the existing privacy pool deployment. Idempotent on declares — both
 * classes skip cleanly if already declared.
 *
 * Returns a record with both class hashes plus the anonymizer's address
 * for the SDK to pick up.
 */

import { Account, RpcProvider } from "starknet";
import { join } from "path";
import {
  artifactPair,
  declareClass,
  deployContract,
  repoRoot,
} from "./utils.js";

export interface NearIntentsAnonymizerDeployment {
  /** Class hash of `MailboxReceiver` (used to derive mailbox addresses). */
  receiverClassHash: string;
  /** Class hash of the deployed anonymizer (one per binary version). */
  anonymizerClassHash: string;
  /** Address of the deployed anonymizer (the SDK calls this). */
  anonymizerAddress: string;
}

/**
 * Idempotent: skips already-declared classes; the deploy step uses the
 * shared `DEPLOY_SALT_SEED` so re-running with the same seed lands at
 * the same address. Bump the seed to deploy a fresh instance.
 */
export async function deployNearIntentsAnonymizer(
  admin: Account,
  provider: RpcProvider,
  privacyContractAddress: string,
): Promise<NearIntentsAnonymizerDeployment> {
  const artifactsDir = join(repoRoot(), "target/dev");

  // 1. Declare MailboxReceiver.
  const receiverArtifact = artifactPair(
    artifactsDir,
    "near_intents_anonymizer",
    "MailboxReceiver",
  );
  console.log("\n=== Declaring MailboxReceiver ===");
  const receiverClassHash = await declareClass(
    admin,
    provider,
    receiverArtifact.classPath,
    receiverArtifact.compiledPath,
  );

  // 2. Declare NearIntentsAnonymizer.
  const anonymizerArtifact = artifactPair(
    artifactsDir,
    "near_intents_anonymizer",
    "NearIntentsAnonymizer",
  );
  console.log("\n=== Declaring NearIntentsAnonymizer ===");
  const anonymizerClassHash = await declareClass(
    admin,
    provider,
    anonymizerArtifact.classPath,
    anonymizerArtifact.compiledPath,
  );

  // 3. Deploy the anonymizer with (privacy_address, receiver_class_hash).
  console.log(
    `\n=== Deploying NearIntentsAnonymizer(${privacyContractAddress}, ${receiverClassHash}) ===`,
  );
  const anonymizerAddress = await deployContract(
    admin,
    provider,
    anonymizerClassHash,
    [privacyContractAddress, receiverClassHash],
    "0xN1A",
  );

  return { receiverClassHash, anonymizerClassHash, anonymizerAddress };
}
