import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deployForgeInfra,
  processForgeEpoch,
  type ForgeAddresses,
} from "../../src/forge-setup.js";
import { u256Calldata } from "../../src/utils.js";

/**
 * End-to-end devnet test for the v2 epoch-gated redemption lifecycle
 * (`MockForgeYieldsGateway`): deposit → request_redeem → process_epoch →
 * claim_redeem. Also exercises the two failure modes:
 *   - Claiming before settlement panics with `NOT_CLAIMABLE_YET`.
 *   - Claiming twice panics with `ALREADY_CLAIMED`.
 *
 * Anonymizer is NOT used here — the anonymizer only knows `ForgeOperation::Deposit`.
 * The redemption flow is exercised at the gateway boundary, which is where the
 * future v2 anonymizer (Option C in REDEMPTION_DESIGN.md) will plug in.
 */
describe("ForgeYields redemption lifecycle (mock)", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let forge: ForgeAddresses;

  const ONE_TOKEN = 10n ** 18n;
  const depositAmount = 100n * ONE_TOKEN;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "forge-redeem-indexer.log" },
    });
    const { admin, provider } = env.env;
    tokens = await deployTestTokens(admin, provider);
    forge = await deployForgeInfra(admin, provider, {
      name: "Forge USDC Strategy",
      symbol: "fyUSDC",
      underlying: tokens.usdToken,
      salt: "0x901",
    });

    // Seed alice with USD and have her deposit straight into the gateway (no
    // privacy pool — we're testing the gateway's redemption surface).
    const { admin: adminAcct, provider: prov, alice } = env.env;
    const mintTx = await adminAcct.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [alice.address, ...u256Calldata(depositAmount)],
    });
    await prov.waitForTransaction(mintTx.transaction_hash);

    const approveTx = await alice.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "approve",
      calldata: [forge.gateway, ...u256Calldata(depositAmount)],
    });
    await prov.waitForTransaction(approveTx.transaction_hash);

    const depositTx = await alice.execute({
      contractAddress: forge.gateway,
      entrypoint: "deposit",
      calldata: [...u256Calldata(depositAmount), alice.address],
    });
    await prov.waitForTransaction(depositTx.transaction_hash);
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("claim before settlement panics with NOT_CLAIMABLE_YET", async () => {
    const { env: de } = env;
    const shares = 10n * ONE_TOKEN;

    const requestTx = await de.alice.execute({
      contractAddress: forge.gateway,
      entrypoint: "request_redeem",
      calldata: [...u256Calldata(shares), de.alice.address, de.alice.address],
    });
    await de.provider.waitForTransaction(requestTx.transaction_hash);

    // Try to claim id 1 BEFORE any process_epoch — must panic.
    await expect(
      de.alice.execute({
        contractAddress: forge.gateway,
        entrypoint: "claim_redeem",
        calldata: u256Calldata(1n),
      }),
    ).rejects.toThrow(/NOT_CLAIMABLE_YET/);
  });

  it("request_redeem → process_epoch (+10%) → claim_redeem pays out settled assets", async () => {
    const { env: de } = env;
    const shares = 20n * ONE_TOKEN;

    // 1. request_redeem — this is alice's 2nd request, so id is 2.
    const requestTx = await de.alice.execute({
      contractAddress: forge.gateway,
      entrypoint: "request_redeem",
      calldata: [...u256Calldata(shares), de.alice.address, de.alice.address],
    });
    await de.provider.waitForTransaction(requestTx.transaction_hash);
    const ID = 2n;

    // 2. process_epoch with +10% pps.
    const newPps = (ONE_TOKEN * 110n) / 100n;
    await processForgeEpoch(de.admin, de.provider, forge.gateway, newPps);

    // Sanity: epoch 1's pps snapshot was recorded.
    const ppsAtEpoch = await de.provider.callContract({
      contractAddress: forge.gateway,
      entrypoint: "pps_at_epoch",
      calldata: u256Calldata(1n),
    });
    expect(BigInt(ppsAtEpoch[0])).toBe(newPps);

    // 3. claim_redeem(id) — transfer underlying at the settled pps.
    const balanceOf = async (token: string, addr: string): Promise<bigint> => {
      const r = await de.provider.callContract({
        contractAddress: token,
        entrypoint: "balance_of",
        calldata: [addr],
      });
      return BigInt(r[0]);
    };

    const balBefore = await balanceOf(tokens.usdToken, de.alice.address);
    const claimTx = await de.alice.execute({
      contractAddress: forge.gateway,
      entrypoint: "claim_redeem",
      calldata: u256Calldata(ID),
    });
    await de.provider.waitForTransaction(claimTx.transaction_hash);
    const balAfter = await balanceOf(tokens.usdToken, de.alice.address);

    // 20 shares * 1.1 pps = 22 USD of underlying.
    const expectedAssets = (shares * newPps) / ONE_TOKEN;
    expect(balAfter - balBefore).toBe(expectedAssets);

    // 4. Second claim of the same id must fail.
    await expect(
      de.alice.execute({
        contractAddress: forge.gateway,
        entrypoint: "claim_redeem",
        calldata: u256Calldata(ID),
      }),
    ).rejects.toThrow(/ALREADY_CLAIMED/);
  });
});
