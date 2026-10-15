/**
 * Swap the SDK dependency between the monorepo link and a published version around packing.
 *
 * The committed `package.json` pins `@starkware-libs/starknet-privacy-sdk` to `file:../sdk`, so local
 * dev, `Client CI`, and the e2e suite all build against the in-repo SDK (including unreleased changes).
 * That link, however, is not resolvable for an npm consumer — so `prepack` (`pin`) rewrites it to the
 * SDK's current version (read from `../sdk/package.json`) before the tarball is packed, and `postpack`
 * (`restore`) puts the link back. The compiled `dist` imports the SDK by name, so only the manifest
 * changes, not behavior. Release order: publish the SDK first, then the client (whose `prepack` reads
 * the SDK version the release just set).
 *
 * Only the packed tarball may be published. Publishing the directory runs the same pack hooks, but
 * npm builds the registry metadata from the manifest after `postpack` has restored the link, so the
 * registry would record `file:../sdk` as the dependency, which is what consumers' installs resolve.
 * `prepublishOnly` (`refuse-directory-publish`) aborts a directory publish before anything is packed;
 * `npm publish <tarball>` runs no lifecycle scripts, so it is unaffected.
 *
 * Hooks never run when the publisher's npm config sets `ignore-scripts=true`: `npm pack` then packs the
 * `file:../sdk` link unpinned. `verify <tarball>` reads the packed manifest and rejects any dependency
 * that still points at a local path, whatever the config that produced the tarball.
 *
 * String-replaces the single dependency line (rather than re-serializing the JSON) so the manifest's
 * formatting is untouched and `restore` leaves no spurious diff.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SDK_NAME = "@starkware-libs/starknet-privacy-sdk";
const LOCAL_LINK = "file:../sdk";
// Specs that resolve only on the publisher's disk; a consumer's install cannot satisfy them.
const LOCAL_SPEC_PREFIXES = ["file:", "link:"];
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(clientDir, "package.json");
const depLine = (version) => `"${SDK_NAME}": "${version}"`;

const mode = process.argv[2];
const manifest = readFileSync(manifestPath, "utf8");

if (mode === "pin") {
  const sdkVersion = JSON.parse(
    readFileSync(join(clientDir, "..", "sdk", "package.json"), "utf8")
  ).version;
  if (!manifest.includes(depLine(LOCAL_LINK))) {
    throw new Error(
      `${SDK_NAME} is not "${LOCAL_LINK}" in package.json (already pinned from a failed pack?). ` +
        "Run `git checkout client/package.json` and retry."
    );
  }
  writeFileSync(manifestPath, manifest.replace(depLine(LOCAL_LINK), depLine(sdkVersion)));
  console.log(`prepack: pinned ${SDK_NAME} -> ${sdkVersion} for publish`);
} else if (mode === "restore") {
  const escapedName = SDK_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  writeFileSync(
    manifestPath,
    manifest.replace(new RegExp(`"${escapedName}": "[^"]*"`), depLine(LOCAL_LINK))
  );
  console.log(`postpack: restored ${SDK_NAME} -> ${LOCAL_LINK}`);
} else if (mode === "refuse-directory-publish") {
  console.error(
    `Refusing to publish the client directory: the registry would record ${SDK_NAME} as ` +
      `"${LOCAL_LINK}". Run \`npm pack\`, then \`npm publish <tarball>\` (see sdk/README.md).`
  );
  process.exit(1);
} else if (mode === "verify") {
  const tarballPath = process.argv[3];
  if (!tarballPath) {
    throw new Error("usage: publish-sdk-dep.mjs verify <tarball>");
  }
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", tarballPath, "package/package.json"], { encoding: "utf8" })
  );
  const localDependencies = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(packedManifest[field] ?? {})
      .filter(([, spec]) => LOCAL_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix)))
      .map(([name, spec]) => `${field}.${name}: "${spec}"`)
  );
  if (localDependencies.length > 0) {
    console.error(
      `Refusing ${tarballPath}: it still links local paths (${localDependencies.join(", ")}). ` +
        "Repack with `npm pack --ignore-scripts=false` so the pack hooks pin them."
    );
    process.exit(1);
  }
  console.log(
    `verified ${tarballPath}: ${SDK_NAME} is "${packedManifest.dependencies?.[SDK_NAME]}"`
  );
} else {
  throw new Error("usage: publish-sdk-dep.mjs <pin|restore|refuse-directory-publish|verify>");
}
