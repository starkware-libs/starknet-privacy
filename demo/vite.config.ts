import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const sdkDist = resolve(__dirname, "../sdk/dist");

export default defineConfig({
  plugins: [react()],
  // Multi-page build: emit both the original demo (`index.html`) and the
  // standalone wallet (`wallet.html`) into dist/. Without this, vite's prod
  // build only bundles `index.html` and the deployed site 404s on /wallet.html.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        wallet: resolve(__dirname, "wallet.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api/rpc": {
        target: "https://rpc.pathfinder.equilibrium.co",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/rpc/, "/testnet-sepolia/rpc/v0_10"),
      },
    },
  },
  resolve: {
    // Force all `starknet` imports to resolve to demo/node_modules/starknet.
    // Without this, Rollup walks up from starknet-sdk's symlinked dist files
    // and misses the hoisted copy. dedupe is also what keeps TS and the
    // bundler agreeing on a single Account class identity.
    dedupe: ["starknet"],
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
      "starknet-sdk/dist/internal/proof-invocation-factory.js": resolve(
        sdkDist,
        "internal/proof-invocation-factory.js",
      ),
    },
  },
});
