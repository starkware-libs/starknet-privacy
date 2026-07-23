import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CallData, cairo, num, shortString } from "starknet";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createPrivacyClient } from "@starkware-libs/starknet-privacy-client";
import type {
  PrivacyClient,
  PrivacyWallet,
  Strk20Action,
} from "@starkware-libs/starknet-privacy-client";
import {
  makeCoreProver,
  broadcastProvenCall,
} from "../../src/signing-client.js";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { deployTestTokens, type TokenAddresses } from "../../src/vesu-setup.js";
import {
  deploySubAccountAnonymizer,
  type SubAccountAddresses,
} from "../../src/sub-account-setup.js";
import { u256Calldata } from "../../src/utils.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

/**
 * End-to-end sub-account invoke through the dapp client on devnet, plus address validation.
 *
 * `client.build().with(token).createOpenNote().subaccounts(dappName).invoke(nonce, { calls })` runs
 * the dapp `calls` through the user's sub-account (deploying it) and settles the payout into the open
 * note — the same roundtrip as the Cairo/core tests, but driven by the client. There is no paymaster:
 * the injected wallet proves via the SDK prover and broadcasts the proven call with an ordinary
 * account (`devnet.executeOutside`), which is all AVNU does in production. Afterwards
 * `build().subaccounts(dappName).addresses()` must report the now-deployed sub-account at the address
 * a `SubAccount` contract is actually deployed to.
 */
describe("dapp client: subaccounts(dappName).invoke + addresses on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let subAccount: SubAccountAddresses;
  let client: PrivacyClient;

  const DAPP = "DAPP";
  const ONE_TOKEN = 10n ** 18n;
  const payoutAmount = 100n * ONE_TOKEN;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "sub-account-invoke-client-indexer.log" },
    });
    const { admin, alice, provider, privacy } = env.env;
    tokens = await deployTestTokens(admin, provider);
    subAccount = await deploySubAccountAnonymizer(
      admin,
      provider,
      privacy.address,
    );

    // Fund the dapp so its `transfer_to_caller` can pay the sub-account.
    const mintTx = await admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [subAccount.mockDapp, ...u256Calldata(payoutAmount)],
    });
    await provider.waitForTransaction(mintTx.transaction_hash);

    // The SDK prover proves the client's actions; a devnet wallet broadcasts the proven call with an
    // ordinary account instead of a paymaster (no fee — any account may execute the public part).
    const prover = makeCoreProver({
      signer: alice.signer,
      address: alice.address,
      passphrase: "e2e-passphrase",
      provider,
      indexerApiUrl: env.indexer.apiUrl,
      poolAddress: privacy.address,
      subAccountAnonymizerAddress: subAccount.anonymizer,
    });
    const wallet = {
      partialCommitment: (dappName: string) =>
        prover.partialCommitment(dappName),
      strk20PrepareInvoke: (actions: Strk20Action[], simulate?: boolean) =>
        prover.prove(actions, simulate),
      strk20InvokeTransaction: async (actions: Strk20Action[]) => {
        const { call, proof } = await prover.prove(actions);
        return broadcastProvenCall(
          devnet,
          {
            contractAddress: call.contract_address,
            entrypoint: call.entry_point,
            calldata: call.calldata,
          },
          {
            data: proof.data,
            output: proof.output,
            proofFacts: proof.proof_facts,
          },
        );
      },
      executeWithProof: async () => {
        throw new Error("unused");
      },
      estimateInvokeFee: async () => {
        throw new Error("unused");
      },
    } as unknown as PrivacyWallet;

    client = createPrivacyClient({
      wallet,
      userAddress: alice.address,
      provider,
      subAccountAnonymizerAddress: subAccount.anonymizer,
    });
  }, E2E_TIMEOUTS.hook);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it(
    "runs a sub-account invoke (deploying the sub-account) and reports it via addresses()",
    async () => {
      // Roundtrip: create the open note the payout settles into, then run the dapp payout through
      // the sub-account at nonce 0. Broadcasts (executeOutside) without reverting iff the invoke +
      // settlement succeed on-chain.
      await client
        .build()
        .with(tokens.usdToken)
        .createOpenNote()
        .subaccounts(DAPP)
        .invoke(0, {
          calls: [
            {
              contractAddress: subAccount.mockDapp,
              entrypoint: "transfer_to_caller",
              calldata: CallData.compile([
                tokens.usdToken,
                cairo.uint256(payoutAmount),
              ]),
            },
          ],
        })
        .submit();
      await env.indexer.waitForBlock(devnet.url);

      // The invoke deployed nonce 0's sub-account; nonces 1 and 2 remain undeployed.
      const infos = await client
        .build()
        .subaccounts(DAPP)
        .addresses({ end: 3 });
      expect(infos.map((info) => Number(info.nonce))).toEqual([0, 1, 2]);
      expect(infos[0].is_deployed).toBe(true);
      expect(infos[1].is_deployed).toBe(false);
      expect(infos[2].is_deployed).toBe(false);

      // The reported address is correct: a SubAccount contract of the anonymizer's class is actually
      // deployed there.
      const [expectedClassHash] = await env.env.provider.callContract({
        contractAddress: subAccount.anonymizer,
        entrypoint: "get_sub_account_class_hash",
        calldata: [],
      });
      const deployedClassHash = await env.env.provider.getClassHashAt(
        num.toHex(infos[0].address),
      );
      expect(num.toBigInt(deployedClassHash)).toBe(
        num.toBigInt(expectedClassHash),
      );
    },
    E2E_TIMEOUTS.test,
  );

  it(
    "untilUndeployed:true returns the deployed prefix (just nonce 0)",
    async () => {
      const infos = await client
        .build()
        .subaccounts(DAPP)
        .addresses({ end: 5, untilUndeployed: true });
      expect(infos.map((info) => Number(info.nonce))).toEqual([0]);
      expect(infos[0].is_deployed).toBe(true);
    },
    E2E_TIMEOUTS.test,
  );

  it(
    "dappName scopes the sub-accounts — a different dapp has none deployed",
    async () => {
      const other = shortString.encodeShortString("OTHER");
      const infos = await client
        .build()
        .subaccounts(other)
        .addresses({ end: 3 });
      expect(infos.every((info) => info.is_deployed === false)).toBe(true);
    },
    E2E_TIMEOUTS.test,
  );
});
