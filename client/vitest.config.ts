import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 5000,
    hookTimeout: 30000,
    pool: "forks",
    setupFiles: ["tests/setup.ts"],
  },
});
