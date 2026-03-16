import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AppConfig } from "../config.ts";
import type { TransactionStatus } from "./useTransactions.ts";
import type { BuilderOperation } from "../components/TransactionBuilder.tsx";
import {
  ERC20_RESOURCE_BOUNDS,
  POOL_RESOURCE_BOUNDS,
} from "../starknet.ts";

export function useTransactionBuilder(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  activeAddress: string | undefined,
  poolAddress: string,
  config: AppConfig,
  onSuccess: () => void,
) {
  const [status, setStatus] = useState<TransactionStatus>({
    pending: false,
    lastTxHash: null,
    lastError: null,
  });

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    const accountConfig = config.accounts.find(
      (account) => account.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return new Account({
      provider,
      address: accountConfig.address,
      signer: accountConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAddress, config.accounts]);

  const executeBatch = useCallback(
    (operations: BuilderOperation[]) => {
      const action = "Builder";
      console.log(`[${action}] starting with ${operations.length} operations...`);
      setStatus({ pending: true, lastTxHash: null, lastError: null });

      (async () => {
        try {
          if (!userAccount || !transfers || !provider || !activeAddress)
            throw new Error("Not ready");

          // Approve pool for total deposit amount
          const totalDepositAmount = operations
            .filter((op) => op.operationType === "deposit")
            .reduce((sum, op) => sum + BigInt(op.amount), 0n);

          if (totalDepositAmount > 0n) {
            const approveTx = await userAccount.execute(
              {
                contractAddress: config.tokenAddress,
                entrypoint: "approve",
                calldata: [poolAddress, totalDepositAmount.toString(), "0"],
              },
              { resourceBounds: ERC20_RESOURCE_BOUNDS },
            );
            console.log(`[${action}] approve tx: ${approveTx.transaction_hash}`);
            await provider.waitForTransaction(approveTx.transaction_hash);
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
            builder.invoke({
              contractAddress: invokeOperation.contractAddress!,
              calldata: invokeOperation.calldata
                ? invokeOperation.calldata.split(",").map((segment) => segment.trim())
                : [],
            });
          }

          const provingBlockId = await provider.getBlockNumber() - 10;
          const { callAndProof } = await builder
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
            .execute({ provingBlockId });
          console.log(`[${action}] callAndProof built, submitting pool tx...`);

          const executeTx = await userAccount.execute(callAndProof.call, {
            resourceBounds: POOL_RESOURCE_BOUNDS,
            ...(callAndProof.proof.proofFacts?.length
              ? {
                  proofFacts: callAndProof.proof.proofFacts,
                  proof: callAndProof.proof.data,
                }
              : {}),
          });
          console.log(`[${action}] pool tx: ${executeTx.transaction_hash}`);
          const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
          if (!receipt.isSuccess()) {
            throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
          }

          console.log(`[${action}] confirmed: ${executeTx.transaction_hash}`);
          setStatus({ pending: false, lastTxHash: executeTx.transaction_hash, lastError: null });
          onSuccess();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${action}] failed:`, err);
          setStatus({ pending: false, lastTxHash: null, lastError: `${action}: ${message}` });
        }
      })();
    },
    [userAccount, transfers, provider, activeAddress, config, poolAddress, onSuccess],
  );

  return { status, executeBatch };
}
