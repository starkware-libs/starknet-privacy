import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 120_000,
  },
});
