// tests/archival-interceptor.test.ts
import { describe, it, expect, vi } from "vitest";
import { ArchivalInterceptor } from "../src/archival-interceptor.js";
import type { ProveTxnV3 } from "../src/types.js";
import * as storage from "../src/archival-storage.js";

const makeTransaction = (
  calldata: string[],
  overrides?: Partial<Record<string, unknown>>
): ProveTxnV3 =>
  ({
    type: "INVOKE",
    version: "0x3",
    sender_address: "0xabc123",
    calldata,
    signature: [],
    nonce: "0x0",
    resource_bounds: {},
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L2",
    fee_data_availability_mode: "L2",
    ...overrides,
  }) as unknown as ProveTxnV3;

// ABI-valid privacy pool calldata (Deposit action, decodable by PrivacyPoolABI)
const privacyPoolCalldata = [
  "0x1",
  "0xaaa",
  "0xbbb",
  "0x6",
  "0xaaa111",
  "0xbbb222",
  "0x1",
  "0x5", // Deposit variant
  "0xdead",
  "0x64",
];
// Non-privacy-pool calldata (multi-call)
const multiCalldata = ["0x2", "0xfff"];

describe("ArchivalInterceptor", () => {
  it("always returns allow", async () => {
    vi.spyOn(storage, "uploadArchivalFile").mockResolvedValue(
      "2026-04-09/0xabc.enc"
    );
    const interceptor = new ArchivalInterceptor({ bucket: "test-bucket" });
    const transaction = makeTransaction(privacyPoolCalldata);

    const verdict = await interceptor.intercept(transaction);
    expect(verdict.action).toBe("allow");
  });

  it("encrypts and uploads the parsed transaction (not raw body)", async () => {
    const uploadSpy = vi
      .spyOn(storage, "uploadArchivalFile")
      .mockResolvedValue("2026-04-09/0xabc.enc");
    const interceptor = new ArchivalInterceptor({ bucket: "test-bucket" });
    const transaction = makeTransaction(privacyPoolCalldata);

    await interceptor.intercept(transaction);

    expect(uploadSpy).toHaveBeenCalledOnce();
    const [config, , fileContent] = uploadSpy.mock.calls[0];
    expect(config.bucket).toBe("test-bucket");

    // Verify file format: header line with viewingkey type
    const parsed = storage.parseArchivalFile(Buffer.from(fileContent));
    expect(parsed.type).toBe("viewingkey");
    expect(parsed.publicKeyHex.length).toBe(64); // 32 bytes hex
    expect(parsed.ciphertext.length).toBeGreaterThan(0);
  });

  it("uses sender type for non-privacy-pool transactions", async () => {
    const uploadSpy = vi
      .spyOn(storage, "uploadArchivalFile")
      .mockResolvedValue("2026-04-09/0xabc.enc");
    const interceptor = new ArchivalInterceptor({ bucket: "test-bucket" });
    const transaction = makeTransaction(multiCalldata);

    await interceptor.intercept(transaction);

    const [, , fileContent] = uploadSpy.mock.calls[0];
    const parsed = storage.parseArchivalFile(Buffer.from(fileContent));
    expect(parsed.type).toBe("sender");
  });

  it("still returns allow even if upload fails", async () => {
    vi.spyOn(storage, "uploadArchivalFile").mockRejectedValue(
      new Error("GCS down")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ArchivalInterceptor({ bucket: "test-bucket" });
    const transaction = makeTransaction(privacyPoolCalldata);

    const verdict = await interceptor.intercept(transaction);
    expect(verdict.action).toBe("allow");
  });

  it("returns allow for concurrent transactions independently", async () => {
    let uploadCallCount = 0;
    vi.spyOn(storage, "uploadArchivalFile").mockImplementation(
      async (_config, txHash) => {
        uploadCallCount++;
        return `2026-04-09/${txHash}.enc`;
      }
    );
    const interceptor = new ArchivalInterceptor({ bucket: "test-bucket" });

    const tx1 = makeTransaction(privacyPoolCalldata);
    // Different nonce so fingerprints differ
    const tx2 = makeTransaction(privacyPoolCalldata, { nonce: "0x1" });

    // Both intercept() calls run concurrently
    const [verdict1, verdict2] = await Promise.all([
      interceptor.intercept(tx1),
      interceptor.intercept(tx2),
    ]);
    expect(uploadCallCount).toBe(2);
    expect(verdict1.action).toBe("allow");
    expect(verdict2.action).toBe("allow");
  });
});
