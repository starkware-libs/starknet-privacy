import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ec, num } from "starknet";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
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

  beforeAll(async () => {
    devnet = new Devnet({ auditorPublicKey: AUDITOR_PUBLIC_KEY });
    await devnet.initialize();
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
});
