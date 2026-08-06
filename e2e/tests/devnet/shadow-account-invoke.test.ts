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
  deployShadowAccountAnonymizer,
  type ShadowAccountAddresses,
} from "../../src/shadow-account-setup.js";
import { u256Calldata } from "../../src/utils.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";
import { exemptOpenNoteDepositor } from "../../src/screening-policy.js";

/**
 * End-to-end shadow account invoke through the dapp client on devnet, plus address validation.
 *
 * `client.build().with(token).createOpenNote().shadowAccounts(dappName).invoke(nonce, { calls })` runs
 * the dapp `calls` through the user's shadow account (deploying it) and settles the payout into the open
 * note — the same roundtrip as the Cairo/core tests, but driven by the client. There is no paymaster:
 * the injected wallet proves via the SDK prover and broadcasts the proven call with an ordinary
 * account (`devnet.executeOutside`), which is all AVNU does in production. Afterwards
 * `build().shadowAccounts(dappName).addresses()` must report the now-deployed shadow account at the address
 * a `ShadowAccount` contract is actually deployed to.
 */
describe("dapp client: shadowAccounts(dappName).invoke + addresses on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let tokens: TokenAddresses;
  let shadowAccount: ShadowAccountAddresses;
  let client: PrivacyClient;

  const DAPP = "DAPP";
  const ONE_TOKEN = 10n ** 18n;
  const payoutAmount = 100n * ONE_TOKEN;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "shadow-account-invoke-client-indexer.log" },
    });
    const { admin, alice, node, privacy } = env.env;
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

    // Fund the dapp so its `transfer_to_caller` can pay the shadow account.
    const mintTx = await admin.execute({
      contractAddress: tokens.usdToken,
      entrypoint: "mint",
      calldata: [shadowAccount.mockDapp, ...u256Calldata(payoutAmount)],
    });
    await node.waitForTransaction(mintTx.transaction_hash);

    // The SDK prover proves the client's actions; a devnet wallet broadcasts the proven call with an
    // ordinary account instead of a paymaster (no fee — any account may execute the public part).
    const prover = makeCoreProver({
      signer: alice.signer,
      address: alice.address,
      passphrase: "e2e-passphrase",
      node: node,
      indexerApiUrl: env.indexer.apiUrl,
      poolAddress: privacy.address,
      shadowAccountAnonymizerAddress: shadowAccount.anonymizer,
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
            calldata: call.calldata ?? [],
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
      node: node,
      shadowAccountAnonymizerAddress: shadowAccount.anonymizer,
    });
  }, E2E_TIMEOUTS.hook);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it(
    "runs a shadow account invoke (deploying the shadow account) and reports it via addresses()",
    async () => {
      // Roundtrip: create the open note the payout settles into, then run the dapp payout through
      // the shadow account at nonce 0. Broadcasts (executeOutside) without reverting iff the invoke +
      // settlement succeed on-chain.
      await client
        .build()
        .with(tokens.usdToken)
        .createOpenNote()
        .shadowAccounts(DAPP)
        .invoke(0, {
          calls: [
            {
              contractAddress: shadowAccount.mockDapp,
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

      // The invoke deployed nonce 0's shadow account; nonces 1 and 2 remain undeployed.
      const infos = await client
        .build()
        .shadowAccounts(DAPP)
        .addresses({ end: 3 });
      expect(infos.map((info) => Number(info.nonce))).toEqual([0, 1, 2]);
      expect(infos[0].is_deployed).toBe(true);
      expect(infos[1].is_deployed).toBe(false);
      expect(infos[2].is_deployed).toBe(false);

      // The reported address is correct: a ShadowAccount of the anonymizer's class is actually
      // deployed there.
      const [expectedClassHash] = await env.env.node.callContract({
        contractAddress: shadowAccount.anonymizer,
        entrypoint: "get_shadow_account_class_hash",
        calldata: [],
      });
      const deployedClassHash = await env.env.node.getClassHashAt(
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
        .shadowAccounts(DAPP)
        .addresses({ end: 5, untilUndeployed: true });
      expect(infos.map((info) => Number(info.nonce))).toEqual([0]);
      expect(infos[0].is_deployed).toBe(true);
    },
    E2E_TIMEOUTS.test,
  );

  it(
    "dappName scopes the shadow accounts — a different dapp has none deployed",
    async () => {
      const other = shortString.encodeShortString("OTHER");
      const infos = await client
        .build()
        .shadowAccounts(other)
        .addresses({ end: 3 });
      expect(infos.every((info) => info.is_deployed === false)).toBe(true);
    },
    E2E_TIMEOUTS.test,
  );
});
