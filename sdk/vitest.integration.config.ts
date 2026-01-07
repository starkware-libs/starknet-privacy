import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: "./tests/globalSetup.ts",
    fileParallelism: false,
    hookTimeout: 60000,
    testTimeout: 60000,
    coverage: {
      enabled: false,
    },
  },
});
