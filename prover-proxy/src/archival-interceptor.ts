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
  deleteArchivalFile,
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
  readonly blocking: boolean;
  private readonly storageConfig: ArchivalStorageConfig;
  /** Per-transaction upload promises, keyed by fingerprint. Supports concurrent requests. */
  private readonly pendingUploads = new Map<string, Promise<string | null>>();

  constructor(storageConfig: ArchivalStorageConfig, blocking = false) {
    this.storageConfig = storageConfig;
    this.blocking = blocking;
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

    // Store per-transaction upload promise for error()/complete() to reference
    const uploadPromise = uploadArchivalFile(
      this.storageConfig,
      txFingerprint,
      fileContent
    ).catch((error) => {
      console.error(
        JSON.stringify({
          error: "archival_upload_failed",
          message: String(error),
        })
      );
      return null;
    });
    this.pendingUploads.set(txFingerprint, uploadPromise);

    await uploadPromise;
    return { action: "continue" };
  }

  async error(code: number, transaction: ProveTxnV3): Promise<void> {
    const txFingerprint = computeTxFingerprint(transaction);
    const uploadPromise = this.pendingUploads.get(txFingerprint);
    if (!uploadPromise) return;

    const objectPath = await uploadPromise;
    this.pendingUploads.delete(txFingerprint);
    if (!objectPath) return; // Upload failed — nothing to delete

    await deleteArchivalFile(this.storageConfig, objectPath).catch((error) => {
      console.error(
        JSON.stringify({
          error: "archival_delete_failed",
          code,
          message: String(error),
        })
      );
    });
  }

  complete(transaction: ProveTxnV3): void {
    const txFingerprint = computeTxFingerprint(transaction);
    this.pendingUploads.delete(txFingerprint);
  }
}
