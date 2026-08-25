// src/build_info.ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  version: string;
}

/**
 * Resolves the service version by reading `package.json` adjacent to the
 * compiled `dist/` (or `src/` under vitest). Returns `"unknown"` if the file
 * can't be read or parsed — version info is observability metadata, never a
 * load-bearing field.
 */
function loadServiceVersion(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(moduleDir, "..", "package.json");
    const text = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(text) as PackageMetadata;
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through to "unknown"
  }
  return "unknown";
}

export const SERVICE_VERSION = loadServiceVersion();

/**
 * Git commit SHA the binary was built from. Surfaced via the `GIT_SHA`
 * environment variable, set by the Docker build (`docker build --build-arg
 * GIT_SHA=$(git rev-parse HEAD)`) or by the CI pipeline. Defaults to
 * `"unknown"` so the metric remains queryable on local dev runs.
 */
export const GIT_SHA = process.env.GIT_SHA ?? "unknown";
