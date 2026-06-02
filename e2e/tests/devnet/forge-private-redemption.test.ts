import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import {
  buildForgeDepositInvoke,
  buildForgeRequestRedeemInvoke,
  buildForgeClaimRedeemInvoke,
  forgeRedemptionCommitment,
  decodeRedemptionId,
  REDEMPTION_REQUESTED_EVENT_SELECTOR,
} from "@starkware-libs/starknet-privacy-sdk/anonymizers/forge";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deployForgeInfra,
  processForgeEpoch,
  type ForgeAddresses,
} from "../../src/forge-setup.js";
import { u256Calldata } from "../../src/utils.js";

/**
 * Full **private** redemption flow:
 *
 *   1. Mint USD, deposit into the privacy pool.
 *   2. Private deposit into Forge (USD note → share note via the anonymizer).
 *   3. Private RequestRedeem (share note → anonymizer burns shares via the gateway).
 *      Anonymizer emits `RedemptionRequested(gateway, id, commitment)`. SDK reads
 *      the id from the receipt and persists `(id, secret)` in the wallet.
 *   4. `process_epoch(+10% pps)` (admin) — the mock's epoch lifecycle settles
 *      the redemption.
 *   5. Private ClaimRedeem (anonymizer claims at the gateway, fills a fresh USD
 *      open note via the privacy pool).
 *
 * Asserts that the final private USD note's amount equals
 * `(shares * settled_pps) / WAD` — i.e. the user got their underlying back at
 * the appreciated price, fully private (the gateway never saw the user's
 * address).
 */
describe("ForgeYields private redemption (end-to-end)", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let forge: ForgeAddresses;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "forge-private-redemption-indexer.log" },
    });
    const { admin, provider } = env.env;
    tokens = await deployTestTokens(admin, provider);
    forge = await deployForgeInfra(admin, provider, {
      name: "Forge USDC Strategy",
      symbol: "fyUSDC",
      underlying: tokens.usdToken,
      salt: "0x902",
    });
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("private deposit → private request_redeem → process_epoch → private claim", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const depositAmount = 100n * ONE_TOKEN;
    const shareAmount = 50n * ONE_TOKEN;

    // ── 0. Mint USD, approve the privacy pool ────────────────────────────────
    const mintTx = await de.admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [de.alice.address, ...u256Calldata(depositAmount)],
    });
    await de.provider.waitForTransaction(mintTx.transaction_hash);
    const approveTx = await de.alice.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "approve",
      calldata: [de.privacy.address, depositAmount, 0n],
    });
    await de.provider.waitForTransaction(approveTx.transaction_hash);

    // ── 1. Private deposit (USD into the pool) ───────────────────────────────
    const { callAndProof: poolDepositCall } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken, (t) => t.deposit({ amount: depositAmount }))
      .surplusTo(de.alice.address)
      .execute();
    await devnet.executeOutside(poolDepositCall);
    await env.indexer.waitForBlock(devnet.url);

    // ── 2. Private Forge deposit (USD → shares note) ─────────────────────────
    const { callAndProof: forgeDepositCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken)
      .withdraw({ recipient: forge.anonymizer, amount: shareAmount })
      .surplusTo(de.alice.address, false)
      .with(forge.gateway)
      .transfer({ recipient: de.alice.address, amount: Open })
      .done()
      .invoke((args) =>
        buildForgeDepositInvoke({
          anonymizer: forge.anonymizer,
          underlying: tokens.usdToken,
          gateway: forge.gateway,
          assets: shareAmount,
          noteId: args.openNotes[0].noteId,
        }),
      )
      .execute();
    await devnet.executeOutside(forgeDepositCall);
    await env.indexer.waitForBlock(devnet.url);

    const { notes: postDeposit } = await transfers.alice.discoverNotes();
    const sharesOwned = (postDeposit.get(BigInt(forge.gateway)) ?? []).reduce(
      (sum, n) => sum + n.amount,
      0n,
    );
    expect(sharesOwned).toBe(shareAmount);

    // ── 3. Private RequestRedeem (shares → burned at gateway, id off-chain) ──
    const secret = "0xc0ffee";
    const commitment = forgeRedemptionCommitment(secret);

    const { callAndProof: requestCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(forge.gateway)
      .withdraw({ recipient: forge.anonymizer, amount: shareAmount })
      .surplusTo(de.alice.address, false)
      .done()
      .invoke(() =>
        buildForgeRequestRedeemInvoke({
          anonymizer: forge.anonymizer,
          gateway: forge.gateway,
          shares: shareAmount,
          commitment,
        }),
      )
      .execute();
    const requestReceipt = await devnet.executeOutside(requestCall);
    await env.indexer.waitForBlock(devnet.url);

    // Pull the redemption id out of the anonymizer's RedemptionRequested event.
    type ReceiptEvent = {
      from_address: string;
      keys: string[];
      data: string[];
    };
    const receiptEvents: ReceiptEvent[] =
      "events" in requestReceipt
        ? (requestReceipt.events as ReceiptEvent[])
        : [];
    const requestEvent = receiptEvents.find(
      (ev) =>
        BigInt(ev.from_address) === BigInt(forge.anonymizer) &&
        BigInt(ev.keys[0]) === BigInt(REDEMPTION_REQUESTED_EVENT_SELECTOR),
    );
    if (!requestEvent) {
      throw new Error("RedemptionRequested event not found in receipt");
    }
    const redemptionId = decodeRedemptionId(requestEvent.data);
    expect(redemptionId).toBeGreaterThan(0n);

    // Sanity: the share note is now spent — wallet's gateway-share balance is 0.
    const { notes: postRequest } = await transfers.alice.discoverNotes();
    const sharesAfterRequest = (
      postRequest.get(BigInt(forge.gateway)) ?? []
    ).reduce((sum, n) => sum + n.amount, 0n);
    expect(sharesAfterRequest).toBe(0n);

    // ── 4. Admin: simulate +10% yield by minting extra underlying to the
    //    gateway's buffer, then process_epoch with the new pps. In real life
    //    the strategy itself produces this yield; the mock has no real strategy
    //    so we top up the buffer manually.
    const yieldAmount = (shareAmount * 10n) / 100n; // +10% of redeemed shares
    const yieldMintTx = await de.admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [forge.gateway, ...u256Calldata(yieldAmount)],
    });
    await de.provider.waitForTransaction(yieldMintTx.transaction_hash);

    const newPps = (ONE_TOKEN * 110n) / 100n;
    await processForgeEpoch(de.admin, de.provider, forge.gateway, newPps);

    // ── 5. Private ClaimRedeem (gateway → underlying note via anonymizer) ────
    const expectedAssets = (shareAmount * newPps) / ONE_TOKEN; // 50 * 1.1 = 55

    const { callAndProof: claimCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken)
      .transfer({ recipient: de.alice.address, amount: Open })
      .done()
      .invoke((args) =>
        buildForgeClaimRedeemInvoke({
          anonymizer: forge.anonymizer,
          gateway: forge.gateway,
          underlying: tokens.usdToken,
          redemptionId,
          secret,
          noteId: args.openNotes[0].noteId,
        }),
      )
      .execute();
    await devnet.executeOutside(claimCall);
    await env.indexer.waitForBlock(devnet.url);

    const { notes: postClaim } = await transfers.alice.discoverNotes();
    const usdNotes = postClaim.get(BigInt(tokens.usdToken)) ?? [];
    const newUsdNote = usdNotes.find((n) => n.amount === expectedAssets);
    expect(newUsdNote).toBeDefined();

    // Total USD held in private notes = initial - shareAmount (deposited)
    //                                + expectedAssets (redeemed at +10%).
    const totalUsd = usdNotes.reduce((sum, n) => sum + n.amount, 0n);
    expect(totalUsd).toBe(depositAmount - shareAmount + expectedAssets);
  });
});
