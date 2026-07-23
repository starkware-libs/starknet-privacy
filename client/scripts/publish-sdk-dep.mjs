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
 * String-replaces the single dependency line (rather than re-serializing the JSON) so the manifest's
 * formatting is untouched and `restore` leaves no spurious diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SDK_NAME = "@starkware-libs/starknet-privacy-sdk";
const LOCAL_LINK = "file:../sdk";

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
} else {
  throw new Error("usage: publish-sdk-dep.mjs <pin|restore>");
}
