import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ec, num } from "starknet";
import {
  Devnet,
  createDevnetTestEnv,
  type DevnetTestEnv,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  runAuditFetch,
  runAuditAnalyze,
  type SlotEntry,
} from "../../src/audit.js";

// A fixed auditor keypair so the run is reproducible. The public key is the
// Stark-curve x-coordinate of `privateKey * G` — the same `derive_public_key`
// the Cairo contract and the Rust auditor use.
const AUDITOR_PRIVATE_KEY = "0x5a17d17e";
const AUDITOR_PUBLIC_KEY = ec.starkCurve.getStarkKey(AUDITOR_PRIVATE_KEY);

describe("solvency-audit E2E", () => {
  let devnet: Devnet;
  let test: DevnetTestEnv;

  beforeAll(async () => {
    devnet = new Devnet({ auditorPublicKey: AUDITOR_PUBLIC_KEY });
    test = await createDevnetTestEnv(devnet);
    const { env, transfers } = test;

    // Create real state (mock-proved on devnet): register alice & bob, then
    // alice deposits 100 STRK and transfers 50 to bob — producing channels,
    // subchannels, notes, and ViewingKeySet events for the audit to find.
    await env.alice.execute({
      contractAddress: env.strk,
      entrypoint: "approve",
      calldata: [env.privacy.address, 100n, 0n],
    });
    const { callAndProof: bobReg } = await transfers.bob
      .build()
      .register()
      .execute();
    await devnet.executeOutside(bobReg);
    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(env.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: env.bob.address, amount: 50n })
      .surplusTo(env.alice.address)
      .execute();
    await devnet.executeOutside(callAndProof);
  });

  afterAll(async () => {
    await devnet?.cleanup();
  });

  it("deploys the pool with the configured auditor public key", async () => {
    const env = devnet.setup!;
    const onChain = await env.privacy.get_auditor_public_key();
    expect(num.toBigInt(onChain)).toBe(num.toBigInt(AUDITOR_PUBLIC_KEY));
  });

  it("classifies infrastructure slots at the derived addresses", async () => {
    const env = devnet.setup!;
    const to = await env.provider.getBlockNumber();
    const snapshot = await runAuditFetch({
      rpcUrl: devnet.url,
      contract: env.privacy.address,
      from: 0,
      to,
    });
    const { snapshot: classified } = await runAuditAnalyze({
      snapshot,
      auditorKey: AUDITOR_PRIVATE_KEY,
    });

    const byKind = (kind: string): SlotEntry | undefined =>
      Object.values(classified.slots).find((slot) => slot.kind === kind);

    // The auditor-key and proof-validity singletons must land on the slots
    // actually holding those constructor values — proving our slot-address
    // derivation matches the deployed contract's layout.
    const auditor = byKind("singleton:auditor_public_key");
    expect(auditor).toBeDefined();
    expect(num.toBigInt(auditor!.value)).toBe(num.toBigInt(AUDITOR_PUBLIC_KEY));

    const proofValidity = byKind("singleton:proof_validity_blocks");
    expect(proofValidity).toBeDefined();
    expect(num.toBigInt(proofValidity!.value)).toBe(450n);
  });

  it("fetch captures registered users, meta, and contract storage", async () => {
    const env = test.env;
    const to = await env.provider.getBlockNumber();
    const snapshot = await runAuditFetch({
      rpcUrl: devnet.url,
      contract: env.privacy.address,
      from: 0,
      to,
    });

    // ViewingKeySet scan finds both registered users (alongside infra grantees).
    const viewingKeyAddrs = snapshot.users
      .filter((user) => user.kind === "viewing_key")
      .map((user) => num.toBigInt(user.addr));
    expect(viewingKeyAddrs).toContain(num.toBigInt(env.alice.address));
    expect(viewingKeyAddrs).toContain(num.toBigInt(env.bob.address));

    // Meta records the audited contract and the on-chain auditor public key.
    expect(num.toBigInt(snapshot.meta.contract_address)).toBe(
      num.toBigInt(env.privacy.address),
    );
    expect(num.toBigInt(snapshot.meta.auditor_public_key)).toBe(
      num.toBigInt(AUDITOR_PUBLIC_KEY),
    );

    // Storage holds far more than the infra slots (channels/notes were written).
    expect(Object.keys(snapshot.slots).length).toBeGreaterThan(10);
  });

  it("analyze recovers users and reconciles the STRK note sum with balanceOf", async () => {
    const env = test.env;
    const to = await env.provider.getBlockNumber();
    const snapshot = await runAuditFetch({
      rpcUrl: devnet.url,
      contract: env.privacy.address,
      from: 0,
      to,
    });
    const { snapshot: classified, summary } = await runAuditAnalyze({
      snapshot,
      auditorKey: AUDITOR_PRIVATE_KEY,
    });

    // The auditor recovered both users' viewing keys cleanly.
    const count = (label: string): number =>
      Number(summary.match(new RegExp(`${label}:\\s*(\\d+)`))![1]);
    expect(count("users processed")).toBe(2);
    expect(count("recovery failures")).toBe(0);
    expect(count("public-key mismatches")).toBe(0);
    expect(count("foreign auditor-key refs")).toBe(0);

    // Every non-zero slot is now explained: user attribution + all infra slots
    // (singletons, components, role_admin/role_member, SRC5). Empty anomaly set
    // is the completeness check (DESIGN §11).
    expect(count("anomaly slots")).toBe(0);

    // Solvency: the summed unspent STRK notes equal the pool's on-chain balance.
    // Alice deposited 100 STRK; after transferring 50 to Bob the pool still holds
    // 100 (50 Alice change + 50 Bob), all unspent.
    const balanceResult = await env.provider.callContract({
      contractAddress: env.strk,
      entrypoint: "balanceOf",
      calldata: [env.privacy.address],
    });
    const poolBalance =
      num.toBigInt(balanceResult[0]) + (num.toBigInt(balanceResult[1]) << 128n);
    expect(poolBalance).toBe(100n);

    const strkKey = Object.keys(classified.balances).find(
      (token) => num.toBigInt(token) === num.toBigInt(env.strk),
    );
    expect(strkKey).toBeDefined();
    expect(num.toBigInt(classified.balances[strkKey!])).toBe(poolBalance);
  });
});
