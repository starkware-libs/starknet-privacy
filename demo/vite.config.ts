import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const sdkDist = resolve(__dirname, "../sdk/dist");

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force all `starknet` imports to resolve to demo/node_modules/starknet.
    // Without this, Rollup walks up from starknet-sdk's symlinked dist files
    // and misses the hoisted copy. dedupe is also what keeps TS and the
    // bundler agreeing on a single Account class identity.
    dedupe: ["starknet"],
    alias: {
      // Remap the mock-proving import to avoid pulling in Node-only devnet module
      "starknet-sdk/dist/internal/mock-proving.js": resolve(
        sdkDist,
        "internal/mock-proving.js",
      ),
      "starknet-sdk/dist/internal/indexer-discovery.js": resolve(
        sdkDist,
        "internal/indexer-discovery.js",
      ),
    },
  },
});
