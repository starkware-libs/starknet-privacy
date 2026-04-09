import { Storage } from "@google-cloud/storage";

export type ArchivalFileType = "viewingkey" | "sender" | "denied";

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
 * Patches the type field in an archival file's header (e.g., to mark as "denied").
 * Returns a new Buffer with the updated header and the same body.
 */
export function patchFileType(data: Buffer, newType: ArchivalFileType): Buffer {
  const newlineIndex = data.indexOf(0x0a);
  if (newlineIndex === -1) throw new Error("Invalid archival file: no header");
  const header = data.subarray(0, newlineIndex).toString("utf-8");
  const commaIndex = header.indexOf(",");
  if (commaIndex === -1)
    throw new Error("Invalid archival file: malformed header");
  const publicKeyHex = header.slice(commaIndex + 1);
  const newHeader = Buffer.from(`${newType},${publicKeyHex}\n`);
  return Buffer.concat([newHeader, data.subarray(newlineIndex + 1)]);
}

/**
 * Uploads an encrypted archival file to GCS.
 * Path: <bucket>/<YYYY-MM-DD>/<txHash>.enc
 * Returns the object path for later patching.
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
 * Downloads a file from GCS, patches its type, and re-uploads it.
 * Used to mark denied transactions after screening completes.
 */
export async function patchArchivalType(
  config: ArchivalStorageConfig,
  objectPath: string,
  newType: ArchivalFileType
): Promise<void> {
  const storage = config.keyFilePath
    ? new Storage({ keyFilename: config.keyFilePath })
    : new Storage();

  const file = storage.bucket(config.bucket).file(objectPath);
  const [content] = await file.download();
  const patched = patchFileType(content, newType);
  await file.save(patched, { resumable: false });
}
