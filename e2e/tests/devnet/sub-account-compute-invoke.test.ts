import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { CallData, cairo, hash, shortString } from "starknet";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deploySubAccountAnonymizer,
  type SubAccountAddresses,
} from "../../src/sub-account-setup.js";
import { u256Calldata } from "../../src/utils.js";

describe("SubAccount anonymizer compute-and-invoke on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let subAccount: SubAccountAddresses;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "sub-account-compute-invoke-indexer.log" },
    });

    const { admin, provider, privacy } = env.env;
    tokens = await deployTestTokens(admin, provider);
    subAccount = await deploySubAccountAnonymizer(
      admin,
      provider,
      privacy.address,
    );
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("dapp payout collected via the sub-account settles into an open note", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const payoutAmount = 100n * ONE_TOKEN;

    const balanceOf = async (owner: string): Promise<bigint> => {
      const result = await de.provider.callContract({
        contractAddress: tokens.usdToken,
        entrypoint: "balance_of",
        calldata: [owner],
      });
      return BigInt(result[0]) + (BigInt(result[1]) << 128n);
    };

    // Fund the dapp so its `pay_out` can transfer the payout to the sub-account.
    const mintTx = await de.admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [subAccount.mockDapp, ...u256Calldata(payoutAmount)],
    });
    await de.provider.waitForTransaction(mintTx.transaction_hash);

    // `compute_data` feeds privacy_compute(identity_key, dapp_name, nonce); the pool prepends
    // the derived identity key. The commitment it returns selects the per-commitment sub-account.
    const dappName = BigInt(shortString.encodeShortString("DAPP"));
    const seqNonce = 0n;
    const payOutSelector = BigInt(hash.getSelectorFromName("pay_out"));
    const usdToken = BigInt(tokens.usdToken);

    const poolBalanceBefore = await balanceOf(de.privacy.address);

    // Single tx: create the open note the payout settles into, and run compute-and-invoke.
    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(tokens.usdToken)
      .transfer({ recipient: de.alice.address, amount: Open })
      .done()
      .computeAndInvoke((args) => {
        expect(args.openNotes).toHaveLength(1);
        const [openNote] = args.openNotes;
        // `invokeAdditionalData` carries `privacy_invoke_with_computation`'s args after the
        // identity_commitment, which the pool prepends from the privacy_compute result. Compile
        // (calls, open_notes) via the anonymizer ABI and drop the leading commitment felt, so the
        // Array<Call>/Span lengths come from the ABI rather than hand-counted offsets.
        const invokeAdditionalData = new CallData(subAccount.anonymizerAbi)
          .compile("privacy_invoke_with_computation", [
            0n, // identity_commitment placeholder — prepended by the pool; sliced off below
            [
              {
                to: subAccount.mockDapp,
                selector: payOutSelector,
                calldata: CallData.compile([
                  usdToken,
                  cairo.uint256(payoutAmount),
                ]),
              },
            ],
            [{ note_id: openNote.noteId, token: usdToken }],
          ])
          .slice(1)
          .map((felt) => BigInt(felt));
        return {
          contractAddress: subAccount.anonymizer,
          computeAdditionalData: [dappName, seqNonce],
          invokeAdditionalData,
        };
      })
      .execute();
    await devnet.executeOutside(callAndProof);
    await env.indexer.waitForBlock(devnet.url);

    // The open note was filled with the dapp payout the sub-account collected.
    const { notes } = await transfers.alice.discoverNotes();
    const usdNotes = notes.get(usdToken) ?? [];
    expect(usdNotes).toHaveLength(1);
    expect(usdNotes[0].amount).toBe(payoutAmount);

    // Funds ended in the privacy pool; the dapp and anonymizer hold nothing.
    const poolBalanceAfter = await balanceOf(de.privacy.address);
    expect(poolBalanceAfter - poolBalanceBefore).toBe(payoutAmount);
    expect(await balanceOf(subAccount.mockDapp)).toBe(0n);
    expect(await balanceOf(subAccount.anonymizer)).toBe(0n);
  });
});
