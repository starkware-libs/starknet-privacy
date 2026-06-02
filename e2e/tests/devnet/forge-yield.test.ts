import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { buildForgeDepositInvoke } from "@starkware-libs/starknet-privacy-sdk/anonymizers/forge";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deployForgeInfra,
  processForgeEpoch,
  type ForgeAddresses,
} from "../../src/forge-setup.js";
import { u256Calldata } from "../../src/utils.js";

/**
 * End-to-end devnet test for the ForgeYields anonymizer deposit flow.
 *
 * Flow exercised:
 *   1. Mint USD → approve privacy pool → deposit USD into pool (alice now holds a private USD note)
 *   2. Invoke `ForgeYieldsAnonymizer::privacy_invoke(Deposit, ...)`:
 *        - Withdraw some USD from the pool to the anonymizer
 *        - Anonymizer calls `MockForgeYieldsGateway::deposit` → shares minted to anonymizer
 *        - Anonymizer fills an open note on the share token (gateway address)
 *   3. Verify alice holds share notes equal to the deposited USD (pps = 1e18 initial)
 *   4. Simulate yield via `process_epoch` (bump pps) and confirm `convert_to_assets`
 *      reports the boosted underlying value of those shares
 *
 * Withdraw / redeem is NOT exercised — the mock's `request_redeem`/`claim_redeem`
 * intentionally panic with `'NOT_IMPLEMENTED'`, mirroring the v1 anonymizer scope.
 */
describe("ForgeYields private deposit on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let forge: ForgeAddresses;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "forge-yield-indexer.log" },
    });

    const { admin, provider } = env.env;
    tokens = await deployTestTokens(admin, provider);
    forge = await deployForgeInfra(admin, provider, {
      name: "Forge USDC Strategy",
      symbol: "fyUSDC",
      underlying: tokens.usdToken,
      salt: "0x900",
    });
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deposit USD into pool, private-invoke ForgeYields, observe share notes + yield", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const depositAmount = 100n * ONE_TOKEN;
    const lendAmount = 50n * ONE_TOKEN;

    // ── Mint USD to alice, approve the privacy pool ──────────────────────────────
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

    // ── Phase 1: Deposit USD into the privacy pool ───────────────────────────────
    const { callAndProof: poolDepositCall } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken, (token) =>
        token.deposit({ amount: depositAmount }),
      )
      .surplusTo(de.alice.address)
      .execute();
    await devnet.executeOutside(poolDepositCall);
    await env.indexer.waitForBlock(devnet.url);

    // ── Phase 2: Private-invoke ForgeYieldsAnonymizer::Deposit ───────────────────
    // Withdraw USD to the anonymizer; anonymizer deposits into the gateway and
    // fills an open note on the share token with the minted shares.
    const { callAndProof: forgeDepositCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken)
      .withdraw({ recipient: forge.anonymizer, amount: lendAmount })
      .surplusTo(de.alice.address, false)
      .with(forge.gateway)
      .transfer({
        recipient: de.alice.address,
        amount: Open,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error(
            "Expected one open note for Forge deposit invocation",
          );
        }
        return buildForgeDepositInvoke({
          anonymizer: forge.anonymizer,
          underlying: tokens.usdToken,
          gateway: forge.gateway,
          assets: lendAmount,
          noteId: openNote.noteId,
        });
      })
      .execute();
    await devnet.executeOutside(forgeDepositCall);
    await env.indexer.waitForBlock(devnet.url);

    // ── Phase 3: Confirm share notes were created (pps == 1e18 → 1:1) ────────────
    const { notes: postLend } = await transfers.alice.discoverNotes();
    const shareNotes = postLend.get(BigInt(forge.gateway)) ?? [];
    const totalShares = shareNotes.reduce((sum, n) => sum + n.amount, 0n);
    expect(totalShares).toBe(lendAmount);

    // Underlying note remainder = depositAmount - lendAmount
    const usdNotes = postLend.get(BigInt(tokens.usdToken)) ?? [];
    const remainingUsd = usdNotes.reduce((sum, n) => sum + n.amount, 0n);
    expect(remainingUsd).toBe(depositAmount - lendAmount);

    // ── Phase 4: Simulate yield (+10%) via process_epoch, then read pps + convert ─
    const newPps = (ONE_TOKEN * 110n) / 100n; // 1.1e18 — 10% gain
    await processForgeEpoch(de.admin, de.provider, forge.gateway, newPps);

    const ppsCall = await de.provider.callContract({
      contractAddress: forge.gateway,
      entrypoint: "pps",
    });
    // pps is u256: low at [0], high at [1] (we expect high = 0 for sane values)
    const ppsLow = BigInt(ppsCall[0]);
    expect(ppsLow).toBe(newPps);

    const convertCall = await de.provider.callContract({
      contractAddress: forge.gateway,
      entrypoint: "convert_to_assets",
      calldata: u256Calldata(totalShares),
    });
    const assetsLow = BigInt(convertCall[0]);
    // Shares are still the same amount on-chain; their underlying value at the
    // new pps is shares * pps / WAD = 50 * 1.1 = 55 USD.
    const expectedAssets = (totalShares * newPps) / ONE_TOKEN;
    expect(assetsLow).toBe(expectedAssets);
  });
});
