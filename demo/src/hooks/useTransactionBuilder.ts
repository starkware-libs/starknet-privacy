import { useState, useCallback, useMemo } from "react";
import { TransactionFinalityStatus, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AccountConfig, AppConfig } from "../config.ts";
import type { TransactionStatus } from "./useTransactions.ts";
import type { BuilderOperation } from "../components/TransactionBuilder.tsx";
import { createAccount } from "../starknet.ts";
import { Timeline } from "../timeline.ts";

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
  onSuccess: () => void,
) {
  const [status, setStatus] = useState<TransactionStatus>({
    pending: false,
    lastTxHash: null,
    lastError: null,
    proofSizeBytes: null,
    timeline: null,
  });

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    const accountConfig = accounts.find(
      (account) => account.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return createAccount(provider, accountConfig);
  }, [provider, activeAddress, accounts]);

  const executeBatch = useCallback(
    (operations: BuilderOperation[]) => {
      const action = "Builder";
      const timeline = new Timeline();
      setStatus({ pending: true, lastTxHash: null, lastError: null, proofSizeBytes: null, timeline: null });

      (async () => {
        try {
          if (!userAccount || !transfers || !provider || !activeAddress)
            throw new Error("Not ready");

          await timeline.step(action, async () => {
            const totalDepositAmount = operations
              .filter((op) => op.operationType === "deposit")
              .reduce((sum, op) => sum + BigInt(op.amount), 0n);

            if (totalDepositAmount > 0n) {
              await timeline.step("Approve", async () => {
                const approveCall = {
                  contractAddress: config.tokenAddress,
                  entrypoint: "approve",
                  calldata: [poolAddress, totalDepositAmount.toString(), "0"],
                };
                const approveTx = await timeline.step("Estimate + submit", () =>
                  userAccount.execute(approveCall, { tip: 0n }),
                );
                await timeline.step("Wait for receipt", () =>
                  provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS),
                );
              });
            }

            const surplusOperation = operations.find(
              (op) => op.operationType === "surplus",
            );

            const builder = transfers.build({
              autoRegister: true,
              autoSetup: true,
              autoDiscover: { notes: "refresh", channels: "refresh" },
              autoSelectNotes: "naive",
            }).surplusTo(
              surplusOperation?.recipient ?? activeAddress,
              surplusOperation?.withdrawSurplus,
            );

            const invokeOperation = operations.find(
              (op) => op.operationType === "invoke",
            );
            if (invokeOperation) {
              builder.invoke(() => ({
                contractAddress: invokeOperation.contractAddress!,
                calldata: invokeOperation.calldata
                  ? invokeOperation.calldata.split(",").map((segment) => segment.trim())
                  : [],
              }));
            }

            const provingBlockId = await timeline.step("Get block number",
              () => provider.getBlockNumber(),
            ) - 10;

            const { callAndProof } = await timeline.step("SDK build + prove", () =>
              builder
                .with(config.tokenAddress, (tokenBuilder) => {
                  for (const op of operations) {
                    if (op.operationType === "deposit")
                      tokenBuilder.deposit({ amount: BigInt(op.amount), recipient: op.recipient || undefined });
                    if (op.operationType === "transfer")
                      tokenBuilder.transfer({ recipient: op.recipient!, amount: BigInt(op.amount) });
                    if (op.operationType === "withdraw")
                      tokenBuilder.withdraw({ amount: BigInt(op.amount), recipient: op.recipient || activeAddress });
                  }
                })
                .execute({ provingBlockId }),
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
            setStatus({ pending: false, lastTxHash: executeTx.transaction_hash, lastError: null, proofSizeBytes, timeline });
            onSuccess();
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${action}] failed:`, err);
          setStatus({ pending: false, lastTxHash: null, lastError: `${action}: ${message}`, proofSizeBytes: null, timeline });
        }
      })();
    },
    [userAccount, transfers, provider, activeAddress, config, poolAddress, onSuccess],
  );

  return { status, executeBatch };
}
