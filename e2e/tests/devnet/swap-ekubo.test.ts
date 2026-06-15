import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deployEkuboInfra,
  deployEkuboExecutor,
  DEVNET_POOL_CONFIG,
  type EkuboAddresses,
} from "../../src/ekubo-setup.js";
import { u256Calldata } from "../../src/utils.js";

describe("Ekubo swap on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let ekubo: EkuboAddresses;
  let executorAddress: string;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "swap-ekubo-indexer.log" },
    });

    const { admin, provider } = env.env;
    tokens = await deployTestTokens(admin, provider);
    ekubo = await deployEkuboInfra(admin, provider, tokens);
    executorAddress = await deployEkuboExecutor(
      admin,
      provider,
      env.env.privacy.address,
    );
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deposit BTC + swap BTC→USD via executor yields USD output note and BTC change", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const depositAmount = 100n * ONE_TOKEN;
    const swapAmount = 10n * ONE_TOKEN;
    const { fee, tickSpacing, extension, skipAhead } = DEVNET_POOL_CONFIG;

    // Mint BTC to alice and approve privacy pool
    await de.admin.execute({
      contractAddress: tokens.btcToken,
      entrypoint: "mint",
      calldata: [de.alice.address, ...u256Calldata(depositAmount)],
    });
    await de.alice.execute({
      contractAddress: tokens.btcToken,
      entrypoint: "approve",
      calldata: [de.privacy.address, depositAmount, 0n],
    });

    // Deposit BTC into privacy pool
    const { callAndProof: depositCall } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.btcToken, (token) =>
        token.deposit({ amount: depositAmount }),
      )
      .surplusTo(de.alice.address)
      .execute();
    await devnet.executeOutside(depositCall);
    await env.indexer.waitForBlock(devnet.url);

    // Swap BTC→USD via executor
    const { callAndProof: swapCall } = await transfers.alice
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.btcToken)
      .withdraw({ recipient: executorAddress, amount: swapAmount })
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
          throw new Error("Expected one open note for swap invocation");
        }
        // privacy_invoke(router_addr, token_amount{token, amount{mag, sign}},
        //   pool_key{token0, token1, fee, tick_spacing, extension},
        //   minimum_received{low, high}, skip_ahead, note_id)
        return {
          contractAddress: executorAddress,
          calldata: [
            ekubo.routerAddress,
            tokens.btcToken, // token_amount.token
            swapAmount, // token_amount.amount.mag
            0n, // token_amount.amount.sign (positive)
            ekubo.poolToken0,
            ekubo.poolToken1,
            fee,
            tickSpacing,
            extension,
            0n, // minimum_received low
            0n, // minimum_received high
            skipAhead,
            openNote.noteId,
          ],
        };
      })
      .execute();
    await devnet.executeOutside(swapCall);
    await env.indexer.waitForBlock(devnet.url);

    // Verify USD output note from swap
    const { notes } = await transfers.alice.discoverNotes();
    const usdOutputNotes = notes.get(BigInt(tokens.usdToken)) ?? [];
    const usdOutputAmount = usdOutputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(usdOutputAmount).toBeGreaterThan(0n);

    // Verify BTC change note
    const btcChangeNotes = notes.get(BigInt(tokens.btcToken)) ?? [];
    const btcChangeAmount = btcChangeNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(btcChangeAmount).toBe(depositAmount - swapAmount);
  });
});
