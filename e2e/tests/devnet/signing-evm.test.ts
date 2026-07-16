import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CallData, num, shortString, type TypedData } from "starknet";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import type {
  Paymaster,
  PaymasterBuild,
  PaymasterCall,
  PaymasterExecute,
  PaymasterQuote,
  PrivacyClient,
} from "@starkware-libs/starknet-privacy-client";
import {
  Eip712HashSigner,
  outsideExecutionTypedData,
  secp256k1SignFn,
} from "@starkware-libs/starknet-privacy-client/signers";
import {
  makeSdkWalletClient,
  tokenBalance,
  broadcastAppliedActions,
} from "../../src/signing-client.js";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import {
  deployEth712Account,
  type Eth712Account,
} from "../../src/eth712-account-setup.js";
import { u256Calldata } from "../../src/utils.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

/**
 * The full EVM depositor path through the dapp client: an EVM wallet (`StarknetEth712Account`) deposits
 * into the privacy pool. The account's own secp256k1 key both authorizes the proof (EIP-712 `CallSet`,
 * verified on-chain by `is_custom_signature_valid` — case I) and signs the ERC-20 `approve` that rides
 * in a SNIP-9 `OutsideExecution` (`Eip712.signMessage`). Only the paymaster is mocked — it relays the
 * signed OutsideExecution to `execute_from_outside_v2` (running the approve as the account) and
 * broadcasts the proven `apply_actions` via `executeOutside`, exactly as AVNU would.
 */
describe("dapp client: Eth712Account (EVM) deposit on devnet", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let account: Eth712Account;

  const EVM_KEY =
    0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n;
  const AMOUNT = 100n;
  const FEE = 1n;
  const KEPT = AMOUNT - FEE;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: { logFile: "signing-evm-indexer.log" },
    });
    account = await deployEth712Account(
      env.env.admin,
      env.env.provider,
      EVM_KEY,
    );
  }, E2E_TIMEOUTS.hook);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  /**
   * A devnet stand-in for the AVNU paymaster driving an Eth712Account. On execute it relays the
   * deposit's approve through the account's `execute_from_outside_v2` (authorized by the account's
   * EIP-712 OutsideExecution signature, which `SdkWallet` obtained via `signMessage`), then broadcasts
   * the proven `apply_actions`.
   */
  function efoMockPaymaster(): Paymaster {
    const { admin, strk, provider } = env.env;
    // The OutsideExecution the account authorizes; stashed so execute relays exactly what was signed.
    let outsideExecution:
      | {
          caller: string;
          nonce: string;
          execute_after: number;
          execute_before: number;
          calls: PaymasterCall[];
        }
      | undefined;
    return {
      async buildTransaction(build: PaymasterBuild): Promise<PaymasterQuote> {
        const feeAction = {
          type: "withdraw" as const,
          recipient: admin.address,
          token: strk,
          amount: num.toHex(FEE),
        };
        if (build.kind !== "invokeAndApplyAction") return { feeAction };

        const now = Math.floor(Date.now() / 1000);
        outsideExecution = {
          caller: num.toHex(shortString.encodeShortString("ANY_CALLER")),
          nonce: "0x1",
          execute_after: now - 3600,
          execute_before: now + 3600,
          calls: build.calls,
        };
        // Build the OutsideExecution typed data with the real domain the account verifies against
        // (SN_SEPOLIA / evm chain 1 / this account) — the signer now reads the domain from here.
        const typedData = outsideExecutionTypedData({
          accountAddress: account.address,
          snChainName: "SN_SEPOLIA",
          evmChainId: 1n,
          calls: outsideExecution.calls.map((call) => ({
            address: call.to,
            selector: call.selector,
            data: call.calldata,
          })),
          caller: outsideExecution.caller,
          nonce: outsideExecution.nonce,
          executeAfter: outsideExecution.execute_after,
          executeBefore: outsideExecution.execute_before,
        }) as unknown as TypedData;
        return { feeAction, typedData };
      },
      async executeTransaction(
        execute: PaymasterExecute,
      ): Promise<{ transactionHash: string }> {
        if (execute.kind === "invokeAndApplyAction" && outsideExecution) {
          const relay = await admin.execute({
            contractAddress: account.address,
            entrypoint: "execute_from_outside_v2",
            calldata: new CallData(account.abi).compile(
              "execute_from_outside_v2",
              {
                outside_execution: {
                  caller: outsideExecution.caller,
                  nonce: outsideExecution.nonce,
                  execute_after: outsideExecution.execute_after,
                  execute_before: outsideExecution.execute_before,
                  calls: outsideExecution.calls.map((call) => ({
                    to: call.to,
                    selector: call.selector,
                    calldata: call.calldata,
                  })),
                },
                signature: execute.signature,
              },
            ),
          });
          await provider.waitForTransaction(relay.transaction_hash);
        }
        const { transaction_hash } = await broadcastAppliedActions(
          devnet,
          execute,
        );
        return { transactionHash: transaction_hash };
      },
    };
  }

  function buildClient(): PrivacyClient {
    const { privacy, provider } = env.env;
    const signer = new Eip712HashSigner({
      accountAddress: account.address,
      snChainName: "SN_SEPOLIA",
      evmChainId: 1n,
      sign: secp256k1SignFn(EVM_KEY),
    });
    return makeSdkWalletClient({
      signer,
      address: account.address,
      passphrase: "e2e-evm-passphrase",
      provider,
      indexerApiUrl: env.indexer.apiUrl,
      poolAddress: privacy.address,
      paymaster: efoMockPaymaster(),
    });
  }

  const poolStrkBalance = (): Promise<bigint> =>
    tokenBalance(env.env.provider, env.env.strk, env.env.privacy.address);

  it(
    "applies a deposit authorized by EIP-712 (case I) with an outside-execution approve",
    async () => {
      const { admin, strk, provider } = env.env;
      // Fund the EVM account with the STRK it will deposit.
      const fund = await admin.execute({
        contractAddress: strk,
        entrypoint: "transfer",
        calldata: [account.address, ...u256Calldata(AMOUNT)],
      });
      await provider.waitForTransaction(fund.transaction_hash);

      const poolBefore = await poolStrkBalance();
      await buildClient()
        .build()
        .with(strk)
        .deposit({ amount: AMOUNT })
        .with(strk)
        .transfer({ amount: KEPT, recipient: account.address })
        .submit();
      await env.indexer.waitForBlock(devnet.url);

      // Funds moved into the pool (deposit minus fee) — the account's EIP-712 proof signature was
      // accepted (case I) and its approve authorized via the outside-execution signature.
      expect((await poolStrkBalance()) - poolBefore).toBe(KEPT);
    },
    E2E_TIMEOUTS.test,
  );

  it(
    "withdraws the note authorized by EIP-712 (case I) — no approve",
    async () => {
      // Reuses the note the deposit left. A withdraw pulls out of the pool, so it needs no approve /
      // outside-execution — only the proof's EIP-712 CallSet signature (case I). SdkWallet folds the
      // fee as a withdraw, so leave FEE room and send the rest to alice.
      const { strk, alice, provider } = env.env;
      const withdrawn = KEPT - FEE;
      const aliceStrk = (): Promise<bigint> =>
        tokenBalance(provider, strk, alice.address);
      const before = await aliceStrk();

      await buildClient()
        .build()
        .with(strk)
        .withdraw({ amount: withdrawn, recipient: alice.address })
        .submit();
      await env.indexer.waitForBlock(devnet.url);

      // Alice received the withdrawal — the account's EIP-712 CallSet signature authorized it on-chain.
      expect((await aliceStrk()) - before).toBe(withdrawn);
    },
    E2E_TIMEOUTS.test,
  );
});
