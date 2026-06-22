import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import {
  deployTestTokens,
  deployVesuInfra,
  deployVesuAnonymizer,
  type TokenAddresses,
  type VesuAddresses,
} from "../../src/vesu-setup.js";
import { u256Calldata } from "../../src/utils.js";

describe("Vesu lending on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let vesu: VesuAddresses;
  let anonymizerAddress: string;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "vesu-lending-indexer.log" },
    });

    const { admin, provider } = env.env;
    tokens = await deployTestTokens(admin, provider);
    vesu = await deployVesuInfra(admin, provider, tokens);
    anonymizerAddress = await deployVesuAnonymizer(admin, provider);
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deposit USD + Vesu lend + Vesu unlend roundtrip", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const depositAmount = 100n * ONE_TOKEN;
    const lendAmount = 50n * ONE_TOKEN;

    // Mint USD to alice and approve privacy pool (wait for confirmation)
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

    // Phase 1: Deposit USD into privacy pool
    const { callAndProof: depositCall } = await transfers.alice
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
    await devnet.executeOutside(depositCall);
    await env.indexer.waitForBlock(devnet.url);

    // Phase 2: Lend (withdraw USD to anonymizer → anonymizer deposits into Vesu → get vToken)
    const { callAndProof: lendCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken)
      .withdraw({ recipient: anonymizerAddress, amount: lendAmount })
      .surplusTo(de.alice.address, false)
      .with(vesu.usdVToken)
      .transfer({
        recipient: de.alice.address,
        amount: Open,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for lend invocation");
        }
        return {
          contractAddress: anonymizerAddress,
          calldata: [
            0n, // LendingOperation::Deposit
            tokens.usdToken,
            vesu.usdVToken,
            lendAmount,
            0n,
            openNote.noteId,
          ],
        };
      })
      .execute();
    await devnet.executeOutside(lendCall);
    await env.indexer.waitForBlock(devnet.url);

    // Phase 3: Discover vToken notes
    const { notes: vTokenNotes } = await transfers.alice.discoverNotes();
    const vTokenOutputNotes = vTokenNotes.get(BigInt(vesu.usdVToken)) ?? [];
    const vTokenAmount = vTokenOutputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(vTokenAmount).toBeGreaterThan(0n);

    // Phase 4: Unlend (withdraw vTokens → anonymizer → get USD back)
    const { callAndProof: unlendCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(vesu.usdVToken)
      .withdraw({ recipient: anonymizerAddress, amount: vTokenAmount })
      .surplusTo(de.alice.address, false)
      .with(tokens.usdToken)
      .transfer({
        recipient: de.alice.address,
        amount: Open,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for unlend invocation");
        }
        return {
          contractAddress: anonymizerAddress,
          calldata: [
            1n, // LendingOperation::Withdraw (Vault::redeem internally).
            vesu.usdVToken,
            tokens.usdToken,
            vTokenAmount, // The amount of vToken shares to be redeemed.
            0n,
            openNote.noteId,
          ],
        };
      })
      .execute();
    await devnet.executeOutside(unlendCall);
    await env.indexer.waitForBlock(devnet.url);

    // Phase 5: Discover USD notes and verify value preservation
    const { notes: finalNotes } = await transfers.alice.discoverNotes();
    const usdOutputNotes = finalNotes.get(BigInt(tokens.usdToken)) ?? [];
    const totalUsdRecovered = usdOutputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(totalUsdRecovered).toBeGreaterThan(0n);

    // Roundtrip should preserve value: at minimum the change from the deposit
    expect(totalUsdRecovered).toBeGreaterThanOrEqual(
      depositAmount - lendAmount,
    );
  });
});
