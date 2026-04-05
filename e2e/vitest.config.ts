import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { E2E_TIMEOUTS } from "./src/timeouts.js";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: E2E_TIMEOUTS.hook,
    testTimeout: E2E_TIMEOUTS.test,
    env: loadEnv("", process.cwd(), ""),
    setupFiles: ["./src/vitest-setup.ts"],
  },
});
