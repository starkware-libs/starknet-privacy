// tests/archival-storage.test.ts
import { describe, it, expect } from "vitest";
import {
  formatArchivalFile,
  parseArchivalFile,
} from "../src/archival-storage.js";

describe("formatArchivalFile", () => {
  it("formats header with type and public key, then binary body", () => {
    const publicKeyHex = "abcdef1234567890".repeat(4); // 64 hex chars = 32 bytes
    const encrypted = new Uint8Array([1, 2, 3, 4]);
    const result = formatArchivalFile("viewingkey", publicKeyHex, encrypted);

    // Find newline separator
    const newlineIndex = result.indexOf(0x0a); // \n
    expect(newlineIndex).toBeGreaterThan(0);

    const header = Buffer.from(result.slice(0, newlineIndex)).toString("utf-8");
    expect(header).toBe(`viewingkey,${publicKeyHex}`);

    const body = result.slice(newlineIndex + 1);
    expect(body).toEqual(encrypted);
  });
});

describe("parseArchivalFile", () => {
  it("parses header and body from formatted file", () => {
    const publicKeyHex = "abcdef1234567890".repeat(4);
    const encrypted = new Uint8Array([1, 2, 3, 4]);
    const file = formatArchivalFile("viewingkey", publicKeyHex, encrypted);

    const parsed = parseArchivalFile(Buffer.from(file));
    expect(parsed.type).toBe("viewingkey");
    expect(parsed.publicKeyHex).toBe(publicKeyHex);
    expect(parsed.ciphertext).toEqual(encrypted);
  });

  it("parses sender type", () => {
    const file = formatArchivalFile(
      "sender",
      "aa".repeat(32),
      new Uint8Array([5])
    );
    const parsed = parseArchivalFile(Buffer.from(file));
    expect(parsed.type).toBe("sender");
  });
});
