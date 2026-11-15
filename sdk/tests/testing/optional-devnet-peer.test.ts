import { describe, it, expect, vi } from "vitest";
import { build } from "esbuild";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Devnet } from "../../src/testing/devnet.js";

// Simulates a consumer that did not install the optional peer: importing it throws.
vi.mock("starknet-devnet", () => {
  throw new Error("Cannot find package 'starknet-devnet'");
});

const TESTING_ENTRY_POINT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/testing/index.ts"
);

describe("starknet-devnet as an optional peer dependency", () => {
  it("bundles the testing entry point for Node when starknet-devnet cannot be resolved", async () => {
    // The alias points at a path that does not exist, so esbuild's resolution of the
    // import fails the same way it does in a consumer without the package installed.
    const result = await build({
      entryPoints: [TESTING_ENTRY_POINT],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      alias: { "starknet-devnet": "./missing-starknet-devnet" },
    });

    expect(result.errors).toEqual([]);
    // Left as a runtime import, resolved only when a devnet is spawned.
    expect(result.outputFiles[0].text).toContain('await import("starknet-devnet")');
  });

  it("names the missing peer when a devnet is spawned without it", async () => {
    const initialization = new Devnet().initialize();

    await expect(initialization).rejects.toThrow(
      "Devnet requires the optional peer dependency starknet-devnet"
    );
    await expect(initialization).rejects.toHaveProperty("cause");
  });
});
