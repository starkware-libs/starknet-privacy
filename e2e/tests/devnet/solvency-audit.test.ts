import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ec, num } from "starknet";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";

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
});
