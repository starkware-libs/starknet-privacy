import { useState, useCallback, useMemo, useRef, type RefObject } from "react";
import { TransactionFinalityStatus, transaction, type Account, type RpcProvider } from "starknet";
import { Open, type PrivateTransfersInterface, type PrivateTransfersBuilder } from "@starkware-libs/starknet-privacy-sdk";
import { getQuotes, quoteToCalls } from "../avnu.ts";
import { findEkuboPool, type AppConfig } from "../config.ts";
import { Timeline } from "../timeline.ts";
import { toRawAmount } from "../format.ts";
import { previewRedeem, STRK_TOKEN_ADDRESS } from "../starknet.ts";
import {
  type FeeAction,
  type FeeMode,
  paymasterBuildApplyAction,
  paymasterExecuteApplyAction,
  toPaymasterCall,
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

async function fetchPaymasterFee(
  config: AppConfig,
  timeline: Timeline,
  poolAddress: string
): Promise<FeeAction | undefined> {
  if (!config.paymasterUrl) return undefined;
  return (
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

/**
 * The pool's `apply_actions` calls `collect_fee()` which pulls
 * `config.feeAmount` STRK from the tx caller to the fee collector.
 *
 * - With paymaster (`feeAction` defined): the paymaster forwarder is the
 *   caller and handles its own allowance. Nothing to do.
 * - Without paymaster: the user account is the caller and must approve STRK
 *   to the pool for `feeAmount` before submitting. This anonymizer issues that
 *   approve and waits for its receipt.
 *
 * `alreadyCovered` is set by `deposit` when depositing STRK — it folds the
 * fee amount into the existing deposit-token approve, so no separate
 * allowance tx is needed.
 */
async function ensureFeeApproval(
  userAccount: Account,
  provider: RpcProvider,
  feeAction: FeeAction | undefined,
  config: AppConfig,
  poolAddress: string,
  timeline: Timeline,
  alreadyCovered = false
): Promise<void> {
  if (feeAction) return;
  if (alreadyCovered) return;
  const feeAmount = config.feeAmount ?? 0n;
  if (feeAmount === 0n) return;
  await timeline.step("Approve fee", async () => {
    const approveCall = {
      contractAddress: STRK_TOKEN_ADDRESS,
      entrypoint: "approve",
      calldata: [poolAddress, feeAmount.toString(), "0"],
    };
    const approveTx = await timeline.step("Estimate + submit", () =>
      userAccount.execute(approveCall, { tip: 0n })
    );
    await timeline.step("Wait for receipt", () =>
      provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS)
    );
  });
}

function addFeeWithdraw(builder: PrivateTransfersBuilder, feeAction: FeeAction | undefined): void {
  if (feeAction) {
    builder.with(feeAction.token, (t) =>
      t.withdraw({ amount: BigInt(feeAction.amount), recipient: feeAction.recipient })
    );
  }
}

// Sequencer accepts proofs for at most latest-10. We use latest-8 as the
// proving block — proving takes ~4s which is less than 2 block times, so
// the proof is still within the acceptance window when the tx arrives.
const PROVING_BLOCK_DEPTH = 9;

export async function waitForProvingBlock(
  timeline: Timeline,
  provider: RpcProvider,
  lastTxBlockNumber: number | undefined
): Promise<number> {
  let latestBlock = await timeline.step("Get block number", () => provider.getBlockNumber());
  if (lastTxBlockNumber !== undefined && lastTxBlockNumber >= latestBlock - PROVING_BLOCK_DEPTH) {
    await timeline.step("Wait for blocks", async () => {
      while (lastTxBlockNumber >= latestBlock - PROVING_BLOCK_DEPTH) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        latestBlock = await provider.getBlockNumber();
      }
    });
  }
  return latestBlock - PROVING_BLOCK_DEPTH;
}

async function buildProveSubmit(
  builder: PrivateTransfersBuilder,
  feeAction: FeeAction | undefined,
  transfers: PrivateTransfersInterface,
  config: AppConfig,
  timeline: Timeline,
  userAccount: Account,
  provider: RpcProvider,
  lastTxBlockNumber: number | undefined
): Promise<{ txHash: string; proofSizeBytes?: number; blockNumber: number }> {
  addFeeWithdraw(builder, feeAction);

  const provingBlockId = await waitForProvingBlock(timeline, provider, lastTxBlockNumber);

  const invocation = await timeline.step("Build transaction", () =>
    builder.createProofInvocation({ provingBlockId })
  );
  const { callAndProof } = await timeline.step("Prove", () =>
    transfers.executeWithInvocation(invocation, provingBlockId)
  );

  let txHash: string;
  if (feeAction) {
    txHash = (
      await timeline.step("Submit via paymaster", () =>
        paymasterExecuteApplyAction(
          config.paymasterUrl!,
          toPaymasterCall(callAndProof.call),
          callAndProof.proof.data,
          callAndProof.proof.proofFacts,
          getFeeMode(config),
          config.avnuApiKey
        )
      )
    ).transaction_hash;
  } else {
    const proofDetails = callAndProof.proof.proofFacts?.length
      ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
      : {};
    // execute() estimates fee internally; splitting estimate+submit would double RPC calls
    txHash = (
      await timeline.step("Estimate + submit", () =>
        userAccount.execute(callAndProof.call, { tip: 0n, ...proofDetails })
      )
    ).transaction_hash;
  }

  const receipt = await timeline.step("Wait for receipt", () =>
    provider.waitForTransaction(txHash, WAIT_OPTIONS)
  );
  if (!receipt.isSuccess()) throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);

  const proofSizeBytes = callAndProof.proof.data
    ? base64ByteLength(callAndProof.proof.data)
    : undefined;
  return { txHash, proofSizeBytes, blockNumber: receipt.block_number };
}

export type TransactionStatus = {
  pending: boolean;
  action: string | null;
  lastTxHash: string | null;
  lastError: string | null;
  proofSizeBytes: number | null;
  timeline: Timeline | null;
};

export function useTransactions(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  userAccount: Account | undefined,
  adminAccount: Account | undefined,
  activeAddress: string | undefined,
  poolAddress: string,
  config: AppConfig,
  onSettled: () => void,
  onBalancesChanged: (() => Promise<void>) | undefined,
  lastTxBlockNumberRef: RefObject<number | undefined>,
  updateLastTxBlockNumber: (blockNumber: number) => void
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
  const onBalancesChangedRef = useRef(onBalancesChanged);
  onBalancesChangedRef.current = onBalancesChanged;

  const decimalsByToken = useMemo(
    () => new Map(config.tokens.map((t) => [t.address, t.decimals])),
    [config.tokens]
  );

  function scaleAmount(token: string, humanAmount: string): bigint {
    const decimals = decimalsByToken.get(token) ?? 0;
    return toRawAmount(humanAmount, decimals);
  }

  const execute = useCallback(
    async (
      action: string,
      fn: (
        tl: Timeline
      ) => Promise<{ txHash: string; proofSizeBytes?: number; blockNumber?: number }>
    ) => {
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
      try {
        const result = await timeline.step(action, () => fn(timeline));
        if (result.blockNumber !== undefined) {
          updateLastTxBlockNumber(result.blockNumber);
        }
        setStatus({
          pending: false,
          action,
          lastTxHash: result.txHash,
          lastError: null,
          proofSizeBytes: result.proofSizeBytes ?? null,
          timeline,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${action}] failed: ${message}`);
        setStatus({
          pending: false,
          action,
          lastTxHash: null,
          lastError: `${action}: ${message}`,
          proofSizeBytes: null,
          timeline,
        });
      } finally {
        onSettledRef.current();
      }
    },
    [updateLastTxBlockNumber]
  );

  const register = useCallback(
    () =>
      execute("Register", async (tl) => {
        if (!userAccount || !transfers || !provider) throw new Error("Not ready");

        await ensureFeeApproval(userAccount, provider, undefined, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers.build().register();
        return buildProveSubmit(
          builder,
          undefined,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [userAccount, transfers, provider, config, poolAddress, execute, lastTxBlockNumberRef]
  );

  const mint = useCallback(
    (token: string, amount: string) =>
      execute("Mint", async (tl) => {
        if (!adminAccount || !activeAddress || !provider) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);

        const tokenConfig = config.tokens.find((t) => t.address === token);
        const mintCall = {
          contractAddress: token,
          entrypoint: tokenConfig?.mintEntrypoint ?? "permissionedMint",
          calldata: [activeAddress, rawAmount.toString(), "0"],
        };

        const tx = await tl.step("Estimate + submit", () =>
          adminAccount.execute(mintCall, { tip: 0n })
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(tx.transaction_hash, WAIT_OPTIONS)
        );

        if (onBalancesChangedRef.current) await onBalancesChangedRef.current();
        return { txHash: tx.transaction_hash };
      }),
    [adminAccount, activeAddress, provider, execute]
  );

  const deposit = useCallback(
    (token: string, amount: string) =>
      execute("Deposit", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);

        // Fetch paymaster fee first so the deposit-token approve can fold in
        // the pool fee when depositing STRK without a paymaster (saves one tx).
        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);

        const strkDeposit = !feeAction && BigInt(token) === BigInt(STRK_TOKEN_ADDRESS);
        const depositApprovalAmount = rawAmount + (strkDeposit ? (config.feeAmount ?? 0n) : 0n);

        await tl.step("Approve", async () => {
          const approveCall = {
            contractAddress: token,
            entrypoint: "approve",
            calldata: [poolAddress, depositApprovalAmount.toString(), "0"],
          };
          const approveTx = await tl.step("Estimate + submit", () =>
            userAccount.execute(approveCall, { tip: 0n })
          );
          await tl.step("Wait for receipt", () =>
            provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS)
          );
        });

        await ensureFeeApproval(
          userAccount,
          provider,
          feeAction,
          config,
          poolAddress,
          tl,
          strkDeposit
        );

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(token, (t) => t.deposit({ amount: rawAmount, recipient: activeAddress }));
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const withdraw = useCallback(
    (token: string, amount: string) =>
      execute("Withdraw", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);
        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        await ensureFeeApproval(userAccount, provider, feeAction, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(token, (t) => t.withdraw({ amount: rawAmount, recipient: activeAddress }));
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const transfer = useCallback(
    (token: string, recipient: string, amount: string) =>
      execute("Transfer", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);
        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        await ensureFeeApproval(userAccount, provider, feeAction, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(token, (t) => t.transfer({ recipient, amount: rawAmount }));
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const swap = useCallback(
    (fromToken: string, toToken: string, amount: string, minReceivedRaw: bigint) =>
      execute("Swap", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        if (!config.ekubo) throw new Error("Ekubo config not set");
        const rawAmount = scaleAmount(fromToken, amount);

        const pool = findEkuboPool(config.ekubo, fromToken, toToken);
        if (!pool) throw new Error("No Ekubo pool configured for this pair");

        const { executorAddress, routerAddress } = config.ekubo;
        const {
          token0: poolToken0,
          token1: poolToken1,
          fee: poolFee,
          tickSpacing,
          extension,
          skipAhead,
        } = pool;

        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        await ensureFeeApproval(userAccount, provider, feeAction, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .surplusTo(activeAddress)
          .with(fromToken)
          .withdraw({ recipient: executorAddress, amount: rawAmount })
          .surplusTo(activeAddress, false)
          .with(toToken)
          .transfer({ recipient: activeAddress, amount: Open })
          .done()
          .invoke((args) => {
            const openNote = args.openNotes[0];
            if (!openNote) {
              throw new Error("Expected one open note for swap invocation");
            }
            return {
              contractAddress: executorAddress,
              calldata: [
                routerAddress,
                fromToken,
                rawAmount, // i129 mag
                0n, // i129 sign (positive = sell)
                poolToken0,
                poolToken1,
                poolFee,
                tickSpacing,
                extension,
                minReceivedRaw & ((1n << 128n) - 1n), // minimum_received (low)
                minReceivedRaw >> 128n, // minimum_received (high)
                skipAhead,
                openNote.noteId,
              ],
            };
          });
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const avnuSwap = useCallback(
    (fromToken: string, toToken: string, amount: string, slippageBps: number) =>
      execute("AVNU Swap", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(fromToken, amount);

        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        if (!feeAction) {
          throw new Error("AVNU private swap requires the paymaster — enable it and retry");
        }

        const quotes = await tl.step("Get AVNU quote", () =>
          getQuotes({
            sellTokenAddress: fromToken,
            buyTokenAddress: toToken,
            sellAmount: rawAmount,
            takerAddress: activeAddress,
            size: 1,
          })
        );
        const quote = quotes[0];
        if (!quote) throw new Error("AVNU: no quote for this pair");

        const avnuCalls = await tl.step("Build swap calls", () =>
          // `private: true` routes through AVNU's private-swap executor and
          // returns calldata that expects the privacy pool's open-note id.
          quoteToCalls({
            quoteId: quote.quoteId,
            slippage: slippageBps / 10000,
            private: true,
          })
        );
        const { calls: innerCalls, executorAddress } = avnuCalls;
        if (!executorAddress) {
          throw new Error("AVNU: missing executorAddress — enable private swap on the branch");
        }

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .surplusTo(activeAddress)
          .with(fromToken)
          .withdraw({ recipient: executorAddress, amount: rawAmount })
          .surplusTo(activeAddress, false)
          .with(toToken)
          .transfer({ recipient: activeAddress, amount: Open })
          .done()
          .invoke((args) => {
            const openNote = args.openNotes[0];
            if (!openNote) {
              throw new Error("Expected one open note for AVNU swap invocation");
            }
            // AVNU private-swap executor entrypoint layout:
            //   [buyToken, ...Array<Call> (Cairo 1 serialization), openNoteId]
            // transaction.fromCallsToExecuteCalldata_cairo1 emits
            //   [num_calls, (to, selector, calldata_len, ...calldata)*] — exactly
            // what the executor expects for the inner swap route.
            const serializedCalls = transaction.fromCallsToExecuteCalldata_cairo1(innerCalls);
            return {
              contractAddress: executorAddress,
              calldata: [toToken, ...serializedCalls, openNote.noteId],
            };
          });
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const vesuSupply = useCallback(
    (token: string, vTokenAddress: string, amount: string) =>
      execute("Vesu Supply", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        if (!config.vesu) throw new Error("Vesu config not set");
        const rawAmount = scaleAmount(token, amount);
        const { anonymizerAddress } = config.vesu;

        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        await ensureFeeApproval(userAccount, provider, feeAction, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .surplusTo(activeAddress)
          .with(token)
          .withdraw({ recipient: anonymizerAddress, amount: rawAmount })
          .surplusTo(activeAddress, false)
          .with(vTokenAddress)
          .transfer({ recipient: activeAddress, amount: Open })
          .done()
          .invoke((args) => ({
            contractAddress: anonymizerAddress,
            calldata: [
              0n, // LendingOperation::Deposit
              token, // in_token (underlying)
              vTokenAddress, // out_token (vToken)
              rawAmount, // assets (u256 low)
              0n, // assets (u256 high)
              args.openNotes[0].noteId,
            ],
          }));
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  const vesuWithdraw = useCallback(
    (token: string, vTokenAddress: string, amount: string) =>
      execute("Vesu Withdraw", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        if (!config.vesu) throw new Error("Vesu config not set");
        // `amount` is in vToken shares (matches the displayed balance). Two
        // different denominations are needed downstream:
        //   - rawShares: privacy-pool `.with(vTokenAddress).withdraw(amount)`
        //     moves vTokens from the pool to the anonymizer, so `amount` there is
        //     in vToken raw units (18 decimals).
        //   - rawAssets: the anonymizer's `assets` calldata field is interpreted
        //     as underlying raw units (e.g. USDC 6 decimals) by Vesu. Compute
        //     it via preview_redeem(shares) → assets. Using rawShares here
        //     asks Vesu for 10^(18-6)× too much underlying and triggers
        //     "insufficient-reserve".
        const rawShares = scaleAmount(vTokenAddress, amount);
        const rawAssets = await tl.step("Preview redeem", () =>
          previewRedeem(provider, vTokenAddress, rawShares)
        );
        const { anonymizerAddress } = config.vesu;

        const feeAction = await fetchPaymasterFee(config, tl, poolAddress);
        await ensureFeeApproval(userAccount, provider, feeAction, config, poolAddress, tl);

        const lastTxBlockNumber = lastTxBlockNumberRef.current;

        const builder = transfers
          .build({
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .surplusTo(activeAddress)
          .with(vTokenAddress)
          .withdraw({ recipient: anonymizerAddress, amount: rawShares })
          .surplusTo(activeAddress, false)
          .with(token)
          .transfer({ recipient: activeAddress, amount: Open })
          .done()
          .invoke((args) => ({
            contractAddress: anonymizerAddress,
            calldata: [
              1n, // LendingOperation::Withdraw
              vTokenAddress, // in_token (vToken)
              token, // out_token (underlying)
              rawAssets, // assets (u256 low) — underlying units
              0n, // assets (u256 high)
              args.openNotes[0].noteId,
            ],
          }));
        return buildProveSubmit(
          builder,
          feeAction,
          transfers,
          config,
          tl,
          userAccount,
          provider,
          lastTxBlockNumber
        );
      }),
    [
      userAccount,
      transfers,
      provider,
      activeAddress,
      config,
      poolAddress,
      execute,
      lastTxBlockNumberRef,
    ]
  );

  return {
    status,
    register,
    mint,
    deposit,
    withdraw,
    transfer,
    swap,
    avnuSwap,
    vesuSupply,
    vesuWithdraw,
  };
}
