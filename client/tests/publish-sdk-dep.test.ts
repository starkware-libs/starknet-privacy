import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs real `npm publish` against a fake registry on a copy of the client manifest and its pack hooks,
// so the test observes exactly what npm would upload without touching the repo or npmjs.com.

const SDK_NAME = "@starkware-libs/starknet-privacy-sdk";
const FIXTURE_SDK_VERSION = "9.9.9-rc.1";
const NPM_TIMEOUT_MS = 60_000;

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..");

interface NpmResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PublishUpload {
  versions: Record<string, { dependencies?: Record<string, string> }>;
}

let workDir: string;
let fixtureClientDir: string;
let registry: Server;
let registryUrl: string;
let registryUploads: PublishUpload[];

function runCommand(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<NpmResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: fixtureClientDir,
        // An empty user config keeps the developer's ~/.npmrc (and any real token) out of the run.
        env: { ...process.env, npm_config_userconfig: join(workDir, "empty.npmrc"), ...extraEnv },
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ exitCode, stdout, stderr });
      }
    );
  });
}

function runNpm(args: string[], extraEnv: Record<string, string> = {}): Promise<NpmResult> {
  const registryHost = registryUrl.replace(/^http:/, "");
  return runCommand("npm", [...args, `--${registryHost}:_authToken=test-token`], extraEnv);
}

function runVerify(tarballName: string): Promise<NpmResult> {
  return runCommand(process.execPath, ["scripts/publish-sdk-dep.mjs", "verify", tarballName]);
}

async function packTarball(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const packResult = await runNpm(["pack", "--silent", ...args], extraEnv);
  expect(packResult.exitCode).toBe(0);
  // Pack hooks print their own lines first; npm prints the tarball name last.
  const tarballName = packResult.stdout.trim().split("\n").at(-1) ?? "";
  expect(tarballName).toMatch(/\.tgz$/);
  return tarballName;
}

// Simulates a publisher whose ~/.npmrc sets ignore-scripts=true, which skips every pack hook.
const IGNORE_SCRIPTS_CONFIG = { npm_config_ignore_scripts: "true" };

function sdkDependencyInFixtureManifest(): string {
  const manifest = JSON.parse(readFileSync(join(fixtureClientDir, "package.json"), "utf8"));
  return manifest.dependencies[SDK_NAME];
}

beforeEach(async () => {
  registryUploads = [];
  registry = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "PUT") {
        registryUploads.push(JSON.parse(body));
        response.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
      } else {
        response.writeHead(404, { "content-type": "application/json" }).end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;

  // Mirror the monorepo layout the hooks rely on: client/ next to sdk/package.json.
  workDir = mkdtempSync(join(tmpdir(), "client-publish-"));
  fixtureClientDir = join(workDir, "client");
  mkdirSync(join(fixtureClientDir, "scripts"), { recursive: true });
  mkdirSync(join(fixtureClientDir, "dist"));
  mkdirSync(join(workDir, "sdk"));
  writeFileSync(join(workDir, "empty.npmrc"), "");
  writeFileSync(
    join(workDir, "sdk", "package.json"),
    JSON.stringify({ name: SDK_NAME, version: FIXTURE_SDK_VERSION })
  );
  copyFileSync(
    join(clientDir, "scripts", "publish-sdk-dep.mjs"),
    join(fixtureClientDir, "scripts", "publish-sdk-dep.mjs")
  );
  writeFileSync(join(fixtureClientDir, "dist", "index.js"), "export {};\n");
  const manifest = JSON.parse(readFileSync(join(clientDir, "package.json"), "utf8"));
  manifest.publishConfig.registry = registryUrl;
  writeFileSync(join(fixtureClientDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
});

afterEach(async () => {
  await new Promise((resolve) => registry.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

describe("client publish hooks", () => {
  it(
    "refuses a directory publish before packing or uploading anything",
    async () => {
      const result = await runNpm(["publish", "--tag", "latest"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Refusing to publish the client directory");
      expect(registryUploads).toHaveLength(0);
      expect(sdkDependencyInFixtureManifest()).toBe("file:../sdk");
    },
    NPM_TIMEOUT_MS
  );

  it(
    "uploads registry metadata pinning the SDK version when the packed tarball is published",
    async () => {
      const tarballName = await packTarball([]);
      expect(sdkDependencyInFixtureManifest()).toBe("file:../sdk");
      const verifyResult = await runVerify(tarballName);
      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout).toContain(FIXTURE_SDK_VERSION);

      const publishResult = await runNpm([
        "publish",
        tarballName,
        "--tag",
        "latest",
        "--registry",
        registryUrl,
      ]);

      expect(publishResult.exitCode).toBe(0);
      expect(registryUploads).toHaveLength(1);
      const publishedVersions = Object.values(registryUploads[0].versions);
      expect(publishedVersions).toHaveLength(1);
      expect(publishedVersions[0].dependencies?.[SDK_NAME]).toBe(FIXTURE_SDK_VERSION);
    },
    NPM_TIMEOUT_MS
  );

  it(
    "verify rejects a tarball packed while the npm config ignores scripts",
    async () => {
      const tarballName = await packTarball([], IGNORE_SCRIPTS_CONFIG);

      const verifyResult = await runVerify(tarballName);

      expect(verifyResult.exitCode).not.toBe(0);
      expect(verifyResult.stderr).toContain(`dependencies.${SDK_NAME}: "file:../sdk"`);
    },
    NPM_TIMEOUT_MS
  );

  it(
    "packing with --ignore-scripts=false pins the SDK even when the npm config ignores scripts",
    async () => {
      const tarballName = await packTarball(["--ignore-scripts=false"], IGNORE_SCRIPTS_CONFIG);

      const verifyResult = await runVerify(tarballName);

      expect(verifyResult.exitCode).toBe(0);
      expect(verifyResult.stdout).toContain(FIXTURE_SDK_VERSION);
      expect(sdkDependencyInFixtureManifest()).toBe("file:../sdk");
    },
    NPM_TIMEOUT_MS
  );
});
