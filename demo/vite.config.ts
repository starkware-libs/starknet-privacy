import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const sdkDist = resolve(__dirname, "../sdk/dist");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Remap testing imports to avoid pulling in Node-only devnet module
      "starknet-sdk/dist/testing/mock-proving.js": resolve(
        sdkDist,
        "testing/mock-proving.js",
      ),
      "starknet-sdk/dist/internal/indexer-discovery.js": resolve(
        sdkDist,
        "internal/indexer-discovery.js",
      ),
    },
  },
});
