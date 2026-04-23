/**
 * Build browser-compatible bundles for the SDK.
 *
 * Creates:
 * - dist/browser/starknet-sdk.min.js - Main SDK (minified, ESM)
 * - dist/browser/starknet-sdk-testing.min.js - Testing utilities (minified, ESM)
 *
 * Sourcemaps (.map) are emitted next to each bundle for local debugging but
 * are excluded from the published npm package via the `files` field in
 * sdk/package.json. Non-minified dev bundles are not produced — consumers
 * that need readable code should import from the main (non-browser) entry
 * and let their bundler handle it.
 *
 * Run with: npx tsx scripts/build-browser.ts
 */

import { build, BuildOptions } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const sdkRoot = join(__dirname, "..");
const outdir = join(sdkRoot, "dist", "browser");

// Shared build options
const sharedOptions: Partial<BuildOptions> = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  // Don't mark starknet as external - bundle it
  external: [],
  define: {
    // Provide fallbacks for Node.js globals
    "process.env.SDK_DEBUG": "undefined",
    "process.env.SDK_DEBUG_COLOR": "undefined",
    "process.env.NO_COLOR": "undefined",
    "process.env.FORCE_COLOR": "undefined",
  },
};

async function buildBundle(
  name: string,
  entryPoint: string
): Promise<{ size: number; gzipSize: number }> {
  const outfile = join(outdir, `${name}.min.js`);

  await build({
    ...sharedOptions,
    entryPoints: [entryPoint],
    outfile,
    minify: true,
  });

  // Calculate sizes
  const content = readFileSync(outfile);
  const size = content.length;

  // Estimate gzip size (actual gzip would require zlib)
  const gzipSize = Math.round(size * 0.3); // rough estimate

  return { size, gzipSize };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  console.log("Building browser bundles...\n");

  // Create output directory
  mkdirSync(outdir, { recursive: true });

  // Build main SDK
  console.log("Building main SDK...");
  const mainEntry = join(sdkRoot, "src", "index.ts");
  const main = await buildBundle("starknet-sdk", mainEntry);
  console.log(`  starknet-sdk.min.js: ${formatSize(main.size)}`);

  // Build testing utilities (browser-compatible)
  console.log("\nBuilding testing utilities...");
  const testingEntry = join(sdkRoot, "src", "testing", "browser.ts");
  const testing = await buildBundle("starknet-sdk-testing", testingEntry);
  console.log(`  starknet-sdk-testing.min.js: ${formatSize(testing.size)}`);

  // Generate package.json for the browser dist
  const browserPkg = {
    name: "starknet-sdk-browser",
    version: "0.1.0",
    type: "module",
    main: "./starknet-sdk.min.js",
    exports: {
      ".": "./starknet-sdk.min.js",
      "./testing": "./starknet-sdk-testing.min.js",
    },
  };
  writeFileSync(join(outdir, "package.json"), JSON.stringify(browserPkg, null, 2));

  console.log("\n✓ Browser bundles created at dist/browser/");
  console.log("\nUsage in browser:");
  console.log('  <script type="module">');
  console.log('    import { createPrivateTransfers } from "./starknet-sdk.min.js";');
  console.log('    import { Mocknet } from "./starknet-sdk-testing.min.js";');
  console.log("  </script>");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
