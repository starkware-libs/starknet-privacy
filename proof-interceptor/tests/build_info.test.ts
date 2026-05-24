// tests/build_info.test.ts
import { describe, it, expect } from "vitest";
import { SERVICE_VERSION, GIT_SHA } from "../src/build_info.js";
import { registry } from "../src/metrics.js";

describe("build info", () => {
  it("loads a non-empty service version from package.json", () => {
    expect(typeof SERVICE_VERSION).toBe("string");
    expect(SERVICE_VERSION.length).toBeGreaterThan(0);
    expect(SERVICE_VERSION).not.toBe("unknown");
  });

  it("falls back to 'unknown' for git SHA when env var is unset", () => {
    expect(typeof GIT_SHA).toBe("string");
    expect(GIT_SHA.length).toBeGreaterThan(0);
  });

  it("exposes build_info gauge in the Prometheus registry", async () => {
    const text = await registry.metrics();
    expect(text).toContain("proof_interceptor_build_info");
    const re = new RegExp(
      `proof_interceptor_build_info\\{[^}]*version="${SERVICE_VERSION}"[^}]*git_sha="${GIT_SHA}"[^}]*\\}\\s+1`
    );
    expect(text).toMatch(re);
  });
});
