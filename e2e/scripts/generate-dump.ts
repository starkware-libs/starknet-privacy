/**
 * Generate devnet + contract-state fixtures for Rust crate tests.
 *
 * Outputs (written directly to crate fixture directories):
 *   crates/discovery-core/tests/fixtures/devnet-state.json
 *   crates/discovery-service/tests/fixtures/devnet-dump.json.gz
 *   crates/discovery-service/tests/fixtures/devnet-dump.metadata.json
 *
 * Usage: npm run generate-dump   (from e2e/)
 */
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { gzipSync } from "zlib";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { Devnet, createDevnetTestEnv, type DevnetEnvironment } from "starknet-sdk/testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

const DISCOVERY_CORE_FIXTURES = join(repoRoot, "crates/discovery-core/tests/fixtures");
const DISCOVERY_SERVICE_FIXTURES = join(repoRoot, "crates/discovery-service/tests/fixtures");

const devnet = new Devnet();
const { env, transfers } = await createDevnetTestEnv(devnet);

// Approve STRK spending for alice
await env.alice.execute({
  contractAddress: env.strk,
  entrypoint: "approve",
  calldata: [env.privacy.address, 100n, 0n],
});

// Register bob
const { callAndProof: bobReg } = await transfers.bob.build().register().execute();
await devnet.executeOutside(bobReg);

// Alice: deposit 100 STRK + transfer 50 to bob (representative scenario)
const { callAndProof } = await transfers.alice
  .build({
    autoRegister: true,
    autoSetup: true,
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  .with(env.strk)
  .deposit({ amount: 100n, recipient: env.alice.address })
  .transfer({ recipient: env.bob.address, amount: 50n })
  .execute();

await devnet.executeOutside(callAndProof);

// Bob: discover incoming notes and withdraw 50 STRK
const bobNotes = (await transfers.bob.discoverNotes()).notes;
const { callAndProof: bobWithdraw } = await transfers.bob
  .build({ autoDiscover: { channels: "refresh" } })
  .with(env.strk)
  .inputs(...bobNotes.get(env.strk)!)
  .withdraw({ amount: 50n })
  .execute();

await devnet.executeOutside(bobWithdraw);

console.log("Scenario complete, generating fixtures...");

const spawnTimestamp = Math.floor(Date.now() / 1000);

// Extract alice's private key from the Account signer (Signer.pk is protected)
const alicePk = (env.alice.signer as any).pk as Uint8Array | string;
const rawHex = typeof alicePk === "string" ? alicePk : Buffer.from(alicePk).toString("hex");
const alicePrivateKey = rawHex.startsWith("0x") ? rawHex : "0x" + rawHex;

// All dumps happen while devnet is still running — no race conditions.
await dumpContractState(env, join(DISCOVERY_CORE_FIXTURES, "devnet-state.json"));
await dumpDevnet(devnet.url, DISCOVERY_SERVICE_FIXTURES);
writeFileSync(
  join(DISCOVERY_SERVICE_FIXTURES, "devnet-dump.metadata.json"),
  JSON.stringify(
    {
      timestamp: spawnTimestamp,
      contract_address: env.privacy.address,
      alice_address: env.alice.address,
      alice_private_key: alicePrivateKey,
    },
    null,
    2
  ) + "\n"
);

await devnet.cleanup();
console.log("Fixtures written.");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dump contract storage state to a JSON file for Rust discovery-core tests.
 * Iterates through all blocks and accumulates storage diffs for the privacy contract.
 */
async function dumpContractState(
  env: DevnetEnvironment,
  outputPath: string
): Promise<void> {
  const latestBlock = await env.provider.getBlockNumber();
  const storageState: Record<string, string> = {};

  for (let blockNum = 0; blockNum <= latestBlock; blockNum++) {
    const stateUpdate = await env.provider.getStateUpdate(blockNum);
    for (const diff of stateUpdate.state_diff.storage_diffs) {
      if (diff.address.toLowerCase() === env.privacy.address.toLowerCase()) {
        for (const entry of diff.storage_entries) {
          storageState[entry.key] = entry.value;
        }
      }
    }
  }

  const output = {
    _comment:
      "Devnet storage dump for Rust discovery tests. Regenerate with: cd e2e && npm run generate-dump",
    constants: {
      contract_address: env.privacy.address,
      alice_address: env.alice.address,
      alice_viewing_key: "0xa11ce",
      bob_address: env.bob.address,
      bob_viewing_key: "0xb0b",
      admin_address: env.admin.address,
      eth_token: env.eth,
      strk_token: env.strk,
    },
    block: latestBlock,
    slots: storageState,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`  ${outputPath} (${Object.keys(storageState).length} slots)`);
}

/**
 * Ask devnet to dump its state via RPC, then gzip-compress into the fixtures dir.
 */
async function dumpDevnet(rpcUrl: string, fixturesDir: string): Promise<void> {
  const tempPath = join(tmpdir(), `devnet-dump-${Date.now()}.json`);
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "devnet_dump",
      params: { path: tempPath },
    }),
  });
  const dumpPath = join(fixturesDir, "devnet-dump.json.gz");
  writeFileSync(dumpPath, gzipSync(readFileSync(tempPath)));
  unlinkSync(tempPath);
  console.log(`  ${dumpPath}`);
}
