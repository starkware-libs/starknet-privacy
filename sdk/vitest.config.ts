import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    reporters: ["default"], // shows failures with context; use "verbose" to see all tests
    outputFile: undefined,
    hideSkippedTests: true,
    testTimeout: 5000, // 5 seconds default, override per-test with 3rd arg
    hookTimeout: 30000, // for beforeAll/afterAll hooks
    teardownTimeout: 5000, // max time for cleanup
    pool: "forks", // isolate tests in separate processes (can be killed)
    // Tests that spawn a real devnet (`tests/devnet.test.ts` and `tests/**/*.devnet.test.ts`)
    // collide if run as parallel forks — each fork wants its own devnet, and the resulting
    // RPC traffic + filesystem state races. Carve them into their own project with
    // `fileParallelism: false`; everything else stays parallel.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/devnet.test.ts", "tests/**/*.devnet.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "devnet",
          include: ["tests/devnet.test.ts", "tests/**/*.devnet.test.ts"],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
        // Debug utilities - not critical path
        "src/utils/logging.ts",
        "src/utils/error-decoder.ts",
        "src/testing/tracing-provider.ts",
        "src/testing/helpers.ts",
      ],
      skipFull: true, // hide files with 100% coverage
      thresholds: {
        statements: 70,
        branches: 50,
        functions: 60,
        lines: 70,
      },
    },
    setupFiles: ["tests/setup.ts"],

    // Browser mode configuration (enabled via CLI: --browser.enabled)
    browser: {
      enabled: false,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
