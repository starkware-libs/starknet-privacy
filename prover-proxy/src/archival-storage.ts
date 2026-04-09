import { Storage } from "@google-cloud/storage";

export type ArchivalFileType = "viewingkey" | "sender";

export interface ArchivalStorageConfig {
  bucket: string;
  keyFilePath?: string;
}

export interface ParsedArchivalFile {
  type: ArchivalFileType;
  publicKeyHex: string;
  ciphertext: Uint8Array;
}

/**
 * Formats an archival file: header line with type and public key, then encrypted body.
 */
export function formatArchivalFile(
  type: ArchivalFileType,
  publicKeyHex: string,
  encrypted: Uint8Array
): Uint8Array {
  const header = new TextEncoder().encode(`${type},${publicKeyHex}\n`);
  const result = new Uint8Array(header.length + encrypted.length);
  result.set(header);
  result.set(encrypted, header.length);
  return result;
}

/**
 * Parses an archival file back into its components.
 */
export function parseArchivalFile(data: Buffer): ParsedArchivalFile {
  const newlineIndex = data.indexOf(0x0a);
  if (newlineIndex === -1) throw new Error("Invalid archival file: no header");
  const header = data.subarray(0, newlineIndex).toString("utf-8");
  const commaIndex = header.indexOf(",");
  if (commaIndex === -1)
    throw new Error("Invalid archival file: malformed header");
  return {
    type: header.slice(0, commaIndex) as ArchivalFileType,
    publicKeyHex: header.slice(commaIndex + 1),
    ciphertext: new Uint8Array(data.subarray(newlineIndex + 1)),
  };
}

/**
 * Uploads an encrypted archival file to GCS.
 * Path: <bucket>/<YYYY-MM-DD>/<txHash>.enc
 * Returns the object path (without extension) for denial markers.
 */
export async function uploadArchivalFile(
  config: ArchivalStorageConfig,
  txHash: string,
  fileContent: Uint8Array
): Promise<string> {
  const storage = config.keyFilePath
    ? new Storage({ keyFilename: config.keyFilePath })
    : new Storage();

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const objectName = `${date}/${txHash}.enc`;

  await storage
    .bucket(config.bucket)
    .file(objectName)
    .save(Buffer.from(fileContent), { resumable: false });

  return objectName;
}

/**
 * Deletes an archived transaction file from GCS.
 * Called when a transaction is denied or fails — no point keeping it.
 */
export async function deleteArchivalFile(
  config: ArchivalStorageConfig,
  objectPath: string
): Promise<void> {
  const storage = config.keyFilePath
    ? new Storage({ keyFilename: config.keyFilePath })
    : new Storage();

  await storage.bucket(config.bucket).file(objectPath).delete();
}
