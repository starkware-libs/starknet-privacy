import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: [
        "src/internal/builders.ts",
        "src/internal/compiler.ts",
        "src/testing/transfers.ts",
        "src/testing/discovery.ts",
        "src/testing/pool.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 70,
        lines: 80,
      },
    },
    setupFiles: ["tests/setup.ts"],
  },
});
