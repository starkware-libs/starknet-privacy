import { useState, useCallback, useMemo, useRef } from "react";
import { Account, TransactionFinalityStatus, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AccountConfig, AppConfig } from "../config.ts";
import type { TransactionStatus } from "./useTransactions.ts";
import type { BuilderOperation } from "../components/TransactionBuilder.tsx";
import { Timeline } from "../timeline.ts";
import { toRawAmount } from "../format.ts";

const WAIT_OPTIONS = {
  successStates: [TransactionFinalityStatus.PRE_CONFIRMED],
  retryInterval: 100,
};

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

export function useTransactionBuilder(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  activeAddress: string | undefined,
  poolAddress: string,
  config: AppConfig,
  accounts: AccountConfig[],
  onSettled: () => void,
) {
  const [status, setStatus] = useState<TransactionStatus>({
    pending: false,
    action: null,
    lastTxHash: null,
    lastError: null,
    proofSizeBytes: null,
    timeline: null,
  });

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    const accountConfig = accounts.find(
      (account) => account.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return new Account({
      provider,
      address: accountConfig.address,
      signer: accountConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAddress, accounts]);

  const executeBatch = useCallback(
    (operations: BuilderOperation[]) => {
      const action = "Builder";
      const timeline = new Timeline();
      setStatus({ pending: true, action, lastTxHash: null, lastError: null, proofSizeBytes: null, timeline: null });

      void (async () => {
        try {
          if (!userAccount || !transfers || !provider || !activeAddress)
            throw new Error("Not ready");

          await timeline.step(action, async () => {
            const decimalsByToken = new Map(config.tokens.map((t) => [t.address, t.decimals]));
            function scaleOp(token: string, humanAmount: string): bigint {
              return toRawAmount(humanAmount, decimalsByToken.get(token) ?? 0);
            }

            // Approve pool for deposit amounts, grouped by token
            const depositsByToken = new Map<string, bigint>();
            for (const op of operations) {
              if (op.operationType === "deposit" && op.token) {
                const current = depositsByToken.get(op.token) ?? 0n;
                depositsByToken.set(op.token, current + scaleOp(op.token, op.amount));
              }
            }

            if (depositsByToken.size > 0) {
              await timeline.step("Approve", async () => {
                for (const [token, totalAmount] of depositsByToken) {
                  const approveCall = {
                    contractAddress: token,
                    entrypoint: "approve",
                    calldata: [poolAddress, totalAmount.toString(), "0"],
                  };
                  const approveTx = await timeline.step(`Approve ${token.slice(0, 10)}...`, () =>
                    userAccount.execute(approveCall, { tip: 0n }),
                  );
                  await timeline.step("Wait for receipt", () =>
                    provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS),
                  );
                }
              });
            }

            const surplusOperation = operations.find((op) => op.operationType === "surplus");

            const builder = transfers
              .build({
                autoRegister: true,
                autoSetup: true,
                autoDiscover: { notes: "refresh", channels: "refresh" },
                autoSelectNotes: "naive",
              })
              .surplusTo(
                surplusOperation?.recipient ?? activeAddress,
                surplusOperation?.withdrawSurplus,
              );

            // Group token ops by token address
            const operationsByToken = new Map<string, BuilderOperation[]>();
            for (const op of operations) {
              if (op.operationType === "surplus") continue;
              const tokenAddress = op.token;
              if (!tokenAddress) continue;
              const group = operationsByToken.get(tokenAddress) ?? [];
              group.push(op);
              operationsByToken.set(tokenAddress, group);
            }

            let chain = builder;
            for (const [tokenAddress, tokenOps] of operationsByToken) {
              chain = chain.with(tokenAddress, (tokenBuilder) => {
                for (const op of tokenOps) {
                  const rawAmount = scaleOp(tokenAddress, op.amount);
                  if (op.operationType === "deposit")
                    tokenBuilder.deposit({
                      amount: rawAmount,
                      recipient: op.recipient || undefined,
                    });
                  if (op.operationType === "transfer")
                    tokenBuilder.transfer({ recipient: op.recipient!, amount: rawAmount });
                  if (op.operationType === "withdraw")
                    tokenBuilder.withdraw({
                      amount: rawAmount,
                      recipient: op.recipient || activeAddress,
                    });
                }
              });
            }

            const provingBlockId = await timeline.step("Get block number",
              () => provider.getBlockNumber(),
            ) - 10;

            const { callAndProof } = await timeline.step("SDK build + prove", () =>
              chain.execute({ provingBlockId }),
            );

            const proofDetails = callAndProof.proof.proofFacts?.length
              ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
              : {};

            const executeTx = await timeline.step("Estimate + submit", () =>
              userAccount.execute(callAndProof.call, {
                tip: 0n,
                ...proofDetails,
              }),
            );

            const receipt = await timeline.step("Wait for receipt", () =>
              provider.waitForTransaction(executeTx.transaction_hash, WAIT_OPTIONS),
            );
            if (!receipt.isSuccess()) {
              throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
            }

            const proofSizeBytes = callAndProof.proof.data
              ? base64ByteLength(callAndProof.proof.data)
              : null;
            setStatus({ pending: false, action: null, lastTxHash: executeTx.transaction_hash, lastError: null, proofSizeBytes, timeline });
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${action}] failed:`, err);
          setStatus({ pending: false, action: null, lastTxHash: null, lastError: `${action}: ${message}`, proofSizeBytes: null, timeline });
        } finally {
          onSettledRef.current();
        }
      })();
    },
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      accounts,
    ],
  );

  return { status, executeBatch };
}
