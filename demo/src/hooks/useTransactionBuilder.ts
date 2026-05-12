import { useState, useCallback, useRef, type RefObject } from "react";
import { TransactionFinalityStatus, hash, type Account, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AppConfig } from "../config.ts";
import { type TransactionStatus, waitForProvingBlock } from "./useTransactions.ts";
import type { BuilderOperation } from "../components/TransactionBuilder.tsx";
import { Timeline } from "../timeline.ts";
import { toRawAmount } from "../format.ts";
import {
  type FeeAction,
  type FeeMode,
  paymasterBuildApplyAction,
  paymasterBuildInvokeAndApplyAction,
  paymasterExecuteApplyAction,
  paymasterExecuteInvokeAndApplyAction,
  toPaymasterCall,
  normalizeSignature,
  type PaymasterCall,
} from "../paymaster.ts";

const WAIT_OPTIONS = {
  successStates: [TransactionFinalityStatus.PRE_CONFIRMED],
  retryInterval: 100,
};

function getFeeMode(config: AppConfig): FeeMode {
  return { mode: "sponsored_private", pool_fee_token: config.paymasterFeeToken!, tip: "normal" };
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

import type { PendingStored } from "./usePendingStored.ts";

function buildOperationsLabel(operations: BuilderOperation[]): string {
  const parts: string[] = [];
  for (const op of operations) {
    if (op.operationType === "surplus") continue;
    const amount = op.amount ? op.amount : "?";
    parts.push(`${op.operationType} ${amount}`);
  }
  return parts.length ? parts.join(", ") : "deferred batch";
}

export function useTransactionBuilder(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  userAccount: Account | undefined,
  activeAddress: string | undefined,
  poolAddress: string,
  config: AppConfig,
  onSettled: () => void,
  lastTxBlockNumberRef: RefObject<number | undefined>,
  updateLastTxBlockNumber: (blockNumber: number) => void,
  deferredApplyEnabled: boolean,
  addPendingStored: (entry: PendingStored) => void
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

  const executeBatch = useCallback(
    (operations: BuilderOperation[]) => {
      const action = "Builder";
      const timeline = new Timeline();
      timeline.onStepChange = (label) => {
        setStatus((previous) => (previous.pending ? { ...previous, action: label } : previous));
      };
      setStatus({
        pending: true,
        action,
        lastTxHash: null,
        lastError: null,
        proofSizeBytes: null,
        timeline,
      });

      void (async () => {
        try {
          if (!userAccount || !transfers || !provider || !activeAddress)
            throw new Error("Not ready");

          await timeline.step(action, async () => {
            const decimalsByToken = new Map(config.tokens.map((t) => [t.address, t.decimals]));
            function scaleOp(token: string, humanAmount: string): bigint {
              return toRawAmount(humanAmount, decimalsByToken.get(token) ?? 0);
            }

            // Collect deposit amounts per token (needed for approve)
            const depositsByToken = new Map<string, bigint>();
            for (const op of operations) {
              if (op.operationType === "deposit" && op.token) {
                const current = depositsByToken.get(op.token) ?? 0n;
                depositsByToken.set(op.token, current + scaleOp(op.token, op.amount));
              }
            }
            const hasDeposits = depositsByToken.size > 0;

            // Paymaster fee + optional typed_data for deposits
            let feeAction: FeeAction | undefined;
            let invokeTypedData: unknown | undefined;
            let invokeSignature: string[] | undefined;

            if (config.paymasterUrl) {
              if (hasDeposits) {
                const approveCalls: PaymasterCall[] = [...depositsByToken.entries()].map(
                  ([token, totalAmount]) => ({
                    to: token,
                    selector: hash.getSelectorFromName("approve"),
                    calldata: [poolAddress, "0x" + totalAmount.toString(16), "0x0"],
                  })
                );
                const buildResult = await timeline.step("Get paymaster fee", () =>
                  paymasterBuildInvokeAndApplyAction(
                    config.paymasterUrl!,
                    poolAddress,
                    getFeeMode(config),
                    activeAddress,
                    approveCalls,
                    config.avnuApiKey
                  )
                );
                feeAction = buildResult.fee_action;
                invokeTypedData = buildResult.typed_data;
                const signature = await timeline.step("Sign approvals", () =>
                  userAccount.signMessage(buildResult.typed_data)
                );
                invokeSignature = normalizeSignature(signature);
              } else {
                feeAction = (
                  await timeline.step("Get paymaster fee", () =>
                    paymasterBuildApplyAction(
                      config.paymasterUrl!,
                      poolAddress,
                      getFeeMode(config),
                      config.avnuApiKey
                    )
                  )
                ).fee_action;
              }
            } else if (hasDeposits) {
              // Direct execution: approve separately
              await timeline.step("Approve", async () => {
                for (const [token, totalAmount] of depositsByToken) {
                  const approveCall = {
                    contractAddress: token,
                    entrypoint: "approve",
                    calldata: [poolAddress, totalAmount.toString(), "0"],
                  };
                  const approveTx = await timeline.step(`Approve ${token.slice(0, 10)}...`, () =>
                    userAccount.execute(approveCall, { tip: 0n })
                  );
                  await timeline.step("Wait for receipt", () =>
                    provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS)
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
                surplusOperation?.withdrawSurplus
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

            if (feeAction) {
              chain.with(feeAction.token, (t) =>
                t.withdraw({ amount: BigInt(feeAction!.amount), recipient: feeAction!.recipient })
              );
            }

            const provingBlockId = await waitForProvingBlock(
              timeline,
              provider,
              lastTxBlockNumberRef.current
            );

            const invocation = await timeline.step("Build transaction", () =>
              chain.createProofInvocation({ provingBlockId })
            );

            // Deferred mode: only run store_actions (with proof). Apply is a separate
            // user-triggered action — see `applyStored` returned by this hook.
            // Paymaster is bypassed in this branch.
            if (deferredApplyEnabled) {
              const deferred = await timeline.step("Prove + build store", () =>
                transfers.buildStoreCallFromInvocation(invocation, provingBlockId)
              );
              const storeProofDetails = deferred.callAndProof.proof.proofFacts?.length
                ? {
                    proofFacts: deferred.callAndProof.proof.proofFacts,
                    proof: deferred.callAndProof.proof.data,
                  }
                : {};
              const storeTx = await timeline.step("Submit store_actions", () =>
                userAccount.execute(deferred.callAndProof.call, {
                  tip: 0n,
                  ...storeProofDetails,
                })
              );
              const storeReceipt = await timeline.step("Wait for store receipt", () =>
                provider.waitForTransaction(storeTx.transaction_hash, WAIT_OPTIONS)
              );
              if (!storeReceipt.isSuccess()) {
                throw new Error(`store_actions reverted: ${JSON.stringify(storeReceipt)}`);
              }
              updateLastTxBlockNumber(storeReceipt.block_number);
              addPendingStored({
                actionsHash: deferred.actionsHash,
                label: buildOperationsLabel(operations),
                createdAt: Date.now(),
                storeTxHash: storeTx.transaction_hash,
                ownerAddress: activeAddress,
              });
              const proofSizeBytes = deferred.callAndProof.proof.data
                ? base64ByteLength(deferred.callAndProof.proof.data)
                : null;
              setStatus({
                pending: false,
                action: null,
                lastTxHash: storeTx.transaction_hash,
                lastError: null,
                proofSizeBytes,
                timeline,
              });
              return;
            }

            const { callAndProof } = await timeline.step("Prove", () =>
              transfers.executeWithInvocation(invocation, provingBlockId)
            );

            let txHash: string;
            if (config.paymasterUrl) {
              if (invokeTypedData && invokeSignature) {
                const response = await timeline.step("Submit via paymaster", () =>
                  paymasterExecuteInvokeAndApplyAction(
                    config.paymasterUrl!,
                    toPaymasterCall(callAndProof.call),
                    callAndProof.proof.data,
                    callAndProof.proof.proofFacts,
                    getFeeMode(config),
                    activeAddress,
                    invokeTypedData as Parameters<typeof paymasterExecuteInvokeAndApplyAction>[6],
                    invokeSignature!,
                    config.avnuApiKey
                  )
                );
                txHash = response.transaction_hash;
              } else {
                const response = await timeline.step("Submit via paymaster", () =>
                  paymasterExecuteApplyAction(
                    config.paymasterUrl!,
                    toPaymasterCall(callAndProof.call),
                    callAndProof.proof.data,
                    callAndProof.proof.proofFacts,
                    getFeeMode(config),
                    config.avnuApiKey
                  )
                );
                txHash = response.transaction_hash;
              }
            } else {
              const proofDetails = callAndProof.proof.proofFacts?.length
                ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
                : {};
              // execute() estimates fee internally; splitting estimate+submit would double RPC calls
              const executeTx = await timeline.step("Estimate + submit", () =>
                userAccount.execute(callAndProof.call, { tip: 0n, ...proofDetails })
              );
              txHash = executeTx.transaction_hash;
            }

            const receipt = await timeline.step("Wait for receipt", () =>
              provider.waitForTransaction(txHash, WAIT_OPTIONS)
            );
            if (!receipt.isSuccess()) {
              throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
            }

            updateLastTxBlockNumber(receipt.block_number);

            const proofSizeBytes = callAndProof.proof.data
              ? base64ByteLength(callAndProof.proof.data)
              : null;
            setStatus({
              pending: false,
              action: null,
              lastTxHash: txHash,
              lastError: null,
              proofSizeBytes,
              timeline,
            });
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[${action}] failed: ${message}`);
          setStatus({
            pending: false,
            action: null,
            lastTxHash: null,
            lastError: `${action}: ${message}`,
            proofSizeBytes: null,
            timeline,
          });
        } finally {
          onSettledRef.current();
        }
      })();
    },
    [userAccount, transfers, provider, activeAddress, config, poolAddress, deferredApplyEnabled]
  );

  return { status, executeBatch };
}
