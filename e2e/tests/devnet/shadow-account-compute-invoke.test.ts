import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { CairoCustomEnum, CallData, cairo, hash, shortString } from "starknet";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deployShadowAccountAnonymizer,
  type ShadowAccountAddresses,
} from "../../src/shadow-account-setup.js";
import { u256Calldata } from "../../src/utils.js";
import { exemptOpenNoteDepositor } from "../../src/screening-policy.js";

describe("shadow account anonymizer compute-and-invoke on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let shadowAccount: ShadowAccountAddresses;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "shadow-account-compute-invoke-indexer.log" },
    });

    const { admin, node, privacy } = env.env;
    tokens = await deployTestTokens(admin, node);
    shadowAccount = await deployShadowAccountAnonymizer(
      admin,
      node,
      privacy.address,
    );
    // Exempt the anonymizer so the devnet flow is not blocked on a screening attestation.
    // The deployed posture is `Delegated` (the pool asks the anonymizer which shadow account to
    // screen), which needs a mock prover able to attest that shadow account. Until that exists,
    // `Exempt` keeps this suite exercising the shadow-account flow itself, not the screening gate.
    await exemptOpenNoteDepositor(
      admin,
      node,
      privacy.address,
      shadowAccount.anonymizer,
    );
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("dapp payout collected via the shadow account settles into an open note", async () => {
    const { env: de, transfers } = env;
    const ONE_TOKEN = 10n ** 18n;
    const payoutAmount = 100n * ONE_TOKEN;

    const balanceOf = async (owner: string): Promise<bigint> => {
      const result = await de.node.callContract({
        contractAddress: tokens.usdToken,
        entrypoint: "balance_of",
        calldata: [owner],
      });
      return BigInt(result[0]) + (BigInt(result[1]) << 128n);
    };

    // Fund the dapp so its `transfer_to_caller` can transfer the payout to the shadow account.
    const mintTx = await de.admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [shadowAccount.mockDapp, ...u256Calldata(payoutAmount)],
    });
    await de.node.waitForTransaction(mintTx.transaction_hash);

    // `compute_data` feeds privacy_compute(identity_key, dapp_name, nonce); the pool prepends
    // the derived identity key. The commitment it returns selects the per-commitment shadow account.
    const dappName = BigInt(shortString.encodeShortString("DAPP"));
    const seqNonce = 0n;
    const transferToCallerSelector = BigInt(
      hash.getSelectorFromName("transfer_to_caller"),
    );
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
        const invokeAdditionalData = new CallData(shadowAccount.anonymizerAbi)
          .compile("privacy_invoke_with_computation", [
            0n, // identity_commitment placeholder — prepended by the pool; sliced off below
            [
              {
                to: shadowAccount.mockDapp,
                selector: transferToCallerSelector,
                calldata: CallData.compile([
                  usdToken,
                  cairo.uint256(payoutAmount),
                ]),
              },
            ],
            [
              {
                note_id: openNote.noteId,
                token: usdToken,
                // Collect the shadow account's entire token balance into the open note.
                collect_policy: new CairoCustomEnum({ All: {} }),
              },
            ],
          ])
          .slice(1)
          .map((felt) => BigInt(felt));
        return {
          contractAddress: shadowAccount.anonymizer,
          computeAdditionalData: [dappName, seqNonce],
          invokeAdditionalData,
        };
      })
      .execute();
    await devnet.executeOutside(callAndProof);
    await env.indexer.waitForBlock(devnet.url);

    // The open note was filled with the dapp payout the shadow account collected.
    const { notes } = await transfers.alice.discoverNotes();
    const usdNotes = notes.get(usdToken) ?? [];
    expect(usdNotes).toHaveLength(1);
    expect(usdNotes[0].amount).toBe(payoutAmount);

    // Funds ended in the privacy pool; the dapp and anonymizer hold nothing.
    const poolBalanceAfter = await balanceOf(de.privacy.address);
    expect(poolBalanceAfter - poolBalanceBefore).toBe(payoutAmount);
    expect(await balanceOf(shadowAccount.mockDapp)).toBe(0n);
    expect(await balanceOf(shadowAccount.anonymizer)).toBe(0n);
  });
});
