// The workspace links the local SDK regardless of the client's peer range, so a stale range never
// fails an install here; it only breaks dapps installing the published pair. A prerelease satisfies
// a range only within the same x.y.z (0.14.4-rc.0 is outside ^0.14.3-rc.8), so every new SDK patch
// rc needs the range bumped.
import { readFileSync } from "node:fs";
import semver from "semver";

const SDK_NAME = "@starkware-libs/starknet-privacy-sdk";

const sdkVersion = readManifest("../../sdk/package.json").version;
const peerRange = readManifest("../package.json").peerDependencies[SDK_NAME];

if (!semver.satisfies(sdkVersion, peerRange)) {
  console.error(
    `SDK ${sdkVersion} is outside the client's peer range ${peerRange}; bump it in client/package.json`
  );
  process.exit(1);
}

function readManifest(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}
