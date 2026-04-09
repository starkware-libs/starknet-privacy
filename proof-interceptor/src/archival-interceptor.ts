// src/archival-interceptor.ts
import { createHash } from "node:crypto";
import type { ProveTxnV3 } from "./types.js";
import type { TransactionInterceptor, Verdict } from "./interceptor.js";
import {
  extractEncryptionSeed,
  deriveKeyPair,
  encryptForArchival,
} from "./archival-crypto.js";
import {
  formatArchivalFile,
  uploadArchivalFile,
  type ArchivalStorageConfig,
} from "./archival-storage.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function computeTxFingerprint(transaction: ProveTxnV3): string {
  return createHash("sha256")
    .update(transaction.sender_address)
    .update(transaction.nonce)
    .update((transaction.calldata ?? []).join(","))
    .digest("hex");
}

export class ArchivalInterceptor implements TransactionInterceptor {
  readonly name = "archival";
  private readonly storageConfig: ArchivalStorageConfig;

  constructor(storageConfig: ArchivalStorageConfig) {
    this.storageConfig = storageConfig;
  }

  async intercept(transaction: ProveTxnV3): Promise<Verdict> {
    const serializedTransaction = JSON.stringify(transaction);

    const { type, seed } = extractEncryptionSeed(
      transaction.calldata as string[],
      transaction.sender_address
    );
    const keyPair = deriveKeyPair(seed);
    const publicKeyHex = bytesToHex(keyPair.publicKey);

    const plaintext = new TextEncoder().encode(serializedTransaction);
    const encrypted = encryptForArchival(plaintext, keyPair.publicKey);

    const fileContent = formatArchivalFile(type, publicKeyHex, encrypted);
    const txFingerprint = computeTxFingerprint(transaction);

    try {
      await uploadArchivalFile(this.storageConfig, txFingerprint, fileContent);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: "archival_upload_failed",
          message: String(error),
        })
      );
    }

    return { action: "allow" };
  }
}
