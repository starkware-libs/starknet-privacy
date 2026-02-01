import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"], // shows failures with context; use "verbose" to see all tests
    outputFile: undefined,
    hideSkippedTests: true,
    testTimeout: 5000, // 5 seconds default, override per-test with 3rd arg
    hookTimeout: 30000, // for beforeAll/afterAll hooks
    teardownTimeout: 5000, // max time for cleanup
    pool: "forks", // isolate tests in separate processes (can be killed)
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
