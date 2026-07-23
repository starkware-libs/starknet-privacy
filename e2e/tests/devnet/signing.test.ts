import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants, ec, num } from "starknet";
import type { TypedData } from "starknet";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import type {
  Paymaster,
  PaymasterBuild,
  PaymasterCall,
  PaymasterExecute,
  PaymasterQuote,
  PrivacyClient,
} from "@starkware-libs/starknet-privacy-client";
import { Snip12CallSetSigner } from "@starkware-libs/starknet-privacy-client/signers";
import {
  makeSdkWalletClient,
  tokenBalance,
  broadcastAppliedActions,
} from "../../src/signing-client.js";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

/**
 * A legacy SN wallet (e.g. Fordefi) authorizes a privacy operation by signing the SNIP-12 `CallSet`
 * message — not the synthetic proving transaction. It consumes the dapp client (`Snip12CallSetSigner`
 * behind `CorePrivateTransfersProver` + `SdkWallet`), so this drives a real deposit through the actual
 * client stack: `client.build().with(token).deposit(...).submit()`.
 *
 * Only the paymaster is mocked — devnet has no AVNU, so the mock quotes a pool-funded fee, fronts the
 * deposit's approve directly as alice (the token owner — a devnet stand-in for the paymaster relaying
 * it; `SdkWallet` still signMessage-signs the approve typed data, but this simplified mock does not
 * consume that signature — the EVM test's `execute_from_outside_v2` does), and broadcasts the proven
 * `apply_actions` call with an ordinary account (`executeOutside`) — the public part a real paymaster
 * performs. The pool authorizes the deposit via `is_valid_signature(compute_call_set_hash(...))`
 * (case III), reproduced off-chain by the mock prover's `compile_actions_authorized` path — so a
 * deposit signed by alice's own key succeeds, and one signed by any other key is rejected during proving.
 */
describe("dapp client: SNIP-12 CallSet signer deposit on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  const AMOUNT = 100n;
  const FEE = 1n;
  const KEPT = AMOUNT - FEE;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "signing-snip12-indexer.log" },
    });
  }, E2E_TIMEOUTS.hook);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  /** Alice's STARK private key, read from the devnet's predeployed accounts. */
  async function alicePrivateKey(): Promise<string> {
    const response = await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_getPredeployedAccounts",
      }),
    });
    const { result } = (await response.json()) as {
      result: Array<{ address: string; private_key: string }>;
    };
    const account = result.find(
      (candidate) =>
        BigInt(candidate.address) === BigInt(env.env.alice.address),
    );
    if (!account) throw new Error("alice not found among predeployed accounts");
    return account.private_key;
  }

  // Stand-in for the paymaster's approve typed data — SdkWallet has the user signMessage it.
  const APPROVE_TYPED_DATA: TypedData = {
    domain: { name: "Privacy", version: "1", chainId: "TEST", revision: "1" },
    primaryType: "Approve",
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Approve: [{ name: "spender", type: "ContractAddress" }],
    },
    message: { spender: "0x0" },
  };

  /**
   * A devnet stand-in for the AVNU paymaster (no SNIP-29 endpoint, no fee sponsorship). It quotes a
   * tiny pool-funded fee, and on execute runs the deposit's `approve` as the user (a real paymaster
   * relays it in the user-signed invoke) then broadcasts the proven `apply_actions` call with an
   * ordinary account via `executeOutside`.
   */
  function mockPaymaster(): Paymaster {
    const { admin, strk, provider } = env.env;
    let approveCalls: PaymasterCall[] = [];
    return {
      async buildTransaction(build: PaymasterBuild): Promise<PaymasterQuote> {
        approveCalls = build.kind === "invokeAndApplyAction" ? build.calls : [];
        return {
          feeAction: {
            type: "withdraw",
            recipient: admin.address,
            token: strk,
            amount: num.toHex(FEE),
          },
          typedData:
            build.kind === "invokeAndApplyAction"
              ? APPROVE_TYPED_DATA
              : undefined,
        };
      },
      async executeTransaction(
        execute: PaymasterExecute,
      ): Promise<{ transactionHash: string }> {
        for (const call of approveCalls) {
          const tx = await env.env.alice.execute({
            contractAddress: call.to,
            entrypoint: "approve",
            calldata: call.calldata,
          });
          await provider.waitForTransaction(tx.transaction_hash);
        }
        const { transaction_hash } = await broadcastAppliedActions(
          devnet,
          execute,
        );
        return { transactionHash: transaction_hash };
      },
    };
  }

  /**
   * A dapp client whose account signs (CallSet proof authorization + the approve's SNIP-12 message)
   * with `signingKey`. The pool verifies against alice's on-chain public key, so a `signingKey` other
   * than alice's fails the signature check during proving.
   */
  function buildClient(signingKey: string): PrivacyClient {
    const { alice, privacy, provider } = env.env;
    const signer = new Snip12CallSetSigner({
      accountAddress: alice.address,
      chainId: constants.StarknetChainId.SN_SEPOLIA,
      sign: (messageHash) =>
        ec.starkCurve.sign(num.toHex(messageHash), signingKey),
    });
    return makeSdkWalletClient({
      signer,
      address: alice.address,
      passphrase: "e2e-signing-passphrase",
      provider,
      indexerApiUrl: env.indexer.apiUrl,
      poolAddress: privacy.address,
      paymaster: mockPaymaster(),
    });
  }

  /** STRK the privacy pool holds. */
  const poolStrkBalance = (): Promise<bigint> =>
    tokenBalance(env.env.provider, env.env.strk, env.env.privacy.address);

  it(
    "applies a deposit authorized by a SNIP-12 CallSet signature",
    async () => {
      const { strk, alice } = env.env;
      const poolBefore = await poolStrkBalance();

      // Deposit and keep the balance (minus the paymaster fee) in alice's own note.
      await buildClient(await alicePrivateKey())
        .build()
        .with(strk)
        .deposit({ amount: AMOUNT })
        .with(strk)
        .transfer({ amount: KEPT, recipient: alice.address })
        .submit();
      await env.indexer.waitForBlock(devnet.url);

      // Funds moved into the pool (deposit minus the withdrawn fee) — the deposit's CallSet signature
      // was accepted (case III) and the mock fronted its approve as alice.
      expect((await poolStrkBalance()) - poolBefore).toBe(KEPT);
    },
    E2E_TIMEOUTS.test,
  );

  it(
    "rejects a deposit signed with the wrong key during proving",
    async () => {
      const { strk, alice } = env.env;

      // A valid STARK key that is not alice's — the pool's is_valid_signature rejects every OR branch.
      const client = buildClient("0x1234567890abcdef1234567890abcdef");
      await expect(
        client
          .build()
          .with(strk)
          .deposit({ amount: AMOUNT })
          .with(strk)
          .transfer({ amount: KEPT, recipient: alice.address })
          .submit(),
      ).rejects.toThrow();
    },
    E2E_TIMEOUTS.test,
  );
});
