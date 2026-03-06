import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import { Open, type PrivateTransfersInterface } from "starknet-sdk";
import type { AppConfig } from "../config.ts";
import { ERC20_RESOURCE_BOUNDS, POOL_RESOURCE_BOUNDS } from "../starknet.ts";
import { toRawAmount } from "../format.ts";

export type TransactionStatus = {
  pending: boolean;
  lastTxHash: string | null;
  lastError: string | null;
};

export function useTransactions(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  activeAddress: string | undefined,
  poolAddress: string,
  config: AppConfig,
  onSuccess: () => void
) {
  const [status, setStatus] = useState<TransactionStatus>({
    pending: false,
    lastTxHash: null,
    lastError: null,
  });

  const adminAccount = useMemo(() => {
    if (!provider) return undefined;
    return new Account({
      provider,
      address: config.adminAddress,
      signer: config.adminKey,
      cairoVersion: "1",
    });
  }, [provider, config.adminAddress, config.adminKey]);

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    // Find the private key for active address from config
    const accountConfig = config.accounts.find((a) => a.address === activeAddress);
    if (!accountConfig) return undefined;
    return new Account({
      provider,
      address: accountConfig.address,
      signer: accountConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAddress, config.accounts]);

  const decimalsByToken = useMemo(
    () => new Map(config.tokens.map((t) => [t.address, t.decimals])),
    [config.tokens]
  );

  function scaleAmount(token: string, humanAmount: string): bigint {
    const decimals = decimalsByToken.get(token) ?? 0;
    return toRawAmount(humanAmount, decimals);
  }

  const execute = useCallback(
    async (action: string, fn: () => Promise<string>) => {
      console.log(`[${action}] starting...`);
      setStatus({ pending: true, lastTxHash: null, lastError: null });
      try {
        const txHash = await fn();
        console.log(`[${action}] confirmed: ${txHash}`);
        setStatus({ pending: false, lastTxHash: txHash, lastError: null });
        onSuccess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${action}] failed:`, err);
        setStatus({ pending: false, lastTxHash: null, lastError: `${action}: ${message}` });
      }
    },
    [onSuccess]
  );

  const register = useCallback(
    () =>
      execute("Register", async () => {
        if (!userAccount || !transfers || !provider) throw new Error("Not ready");

        console.log("[Register] registering account in privacy pool...");

        const provingBlockId = (await provider.getBlockNumber()) - 10;
        const { callAndProof } = await transfers.build().register().execute({ provingBlockId });
        console.log("[Register] callAndProof built, submitting tx...");

        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: POOL_RESOURCE_BOUNDS,
          ...(callAndProof.proof.proofFacts?.length
            ? {
                proofFacts: callAndProof.proof.proofFacts,
                proof: callAndProof.proof.data,
              }
            : {}),
        });
        console.log(`[Register] tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, execute]
  );

  const mint = useCallback(
    (token: string, amount: string) =>
      execute("Mint", async () => {
        if (!adminAccount || !activeAddress || !provider) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);
        console.log(`[Mint] amount=${rawAmount} to=${activeAddress} token=${token}`);
        const tx = await adminAccount.execute(
          {
            contractAddress: token,
            entrypoint: "permissionedMint",
            calldata: [activeAddress, rawAmount.toString(), "0"],
          },
          { resourceBounds: ERC20_RESOURCE_BOUNDS }
        );
        console.log(`[Mint] tx submitted: ${tx.transaction_hash}`);
        await provider.waitForTransaction(tx.transaction_hash);
        return tx.transaction_hash;
      }),
    [adminAccount, activeAddress, provider, execute]
  );

  const deposit = useCallback(
    (token: string, amount: string) =>
      execute("Deposit", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);

        console.log(`[Deposit] amount=${rawAmount} recipient=${activeAddress} token=${token}`);

        // Approve pool to spend tokens
        const approveTx = await userAccount.execute(
          {
            contractAddress: token,
            entrypoint: "approve",
            calldata: [poolAddress, rawAmount.toString(), "0"],
          },
          { resourceBounds: ERC20_RESOURCE_BOUNDS }
        );
        console.log(`[Deposit] approve tx: ${approveTx.transaction_hash}`);
        await provider.waitForTransaction(approveTx.transaction_hash);

        // Build and execute deposit
        const provingBlockId = (await provider.getBlockNumber()) - 10;
        const { callAndProof } = await transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .with(token, (t) => t.deposit({ amount: rawAmount, recipient: activeAddress }))
          .execute({ provingBlockId });
        console.log("[Deposit] callAndProof built, submitting pool tx...");

        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: POOL_RESOURCE_BOUNDS,
          ...(callAndProof.proof.proofFacts?.length
            ? {
                proofFacts: callAndProof.proof.proofFacts,
                proof: callAndProof.proof.data,
              }
            : {}),
        });
        console.log(`[Deposit] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, poolAddress, execute]
  );

  const withdraw = useCallback(
    (token: string, amount: string) =>
      execute("Withdraw", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);

        console.log(`[Withdraw] amount=${rawAmount} recipient=${activeAddress} token=${token}`);

        const provingBlockId = (await provider.getBlockNumber()) - 10;
        const { callAndProof } = await transfers
          .build({
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(token, (t) => t.withdraw({ amount: rawAmount, recipient: activeAddress }))
          .execute({ provingBlockId });
        console.log("[Withdraw] callAndProof built, submitting pool tx...");

        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: POOL_RESOURCE_BOUNDS,
          ...(callAndProof.proof.proofFacts?.length
            ? {
                proofFacts: callAndProof.proof.proofFacts,
                proof: callAndProof.proof.data,
              }
            : {}),
        });
        console.log(`[Withdraw] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, execute]
  );

  const transfer = useCallback(
    (token: string, recipient: string, amount: string) =>
      execute("Transfer", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        const rawAmount = scaleAmount(token, amount);

        console.log(`[Transfer] amount=${rawAmount} recipient=${recipient} token=${token}`);

        const provingBlockId = (await provider.getBlockNumber()) - 10;
        const { callAndProof } = await transfers
          .build({
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(token, (t) => t.transfer({ recipient, amount: rawAmount }))
          .execute({ provingBlockId });
        console.log("[Transfer] callAndProof built, submitting pool tx...");

        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: POOL_RESOURCE_BOUNDS,
          ...(callAndProof.proof.proofFacts?.length
            ? {
                proofFacts: callAndProof.proof.proofFacts,
                proof: callAndProof.proof.data,
              }
            : {}),
        });
        console.log(`[Transfer] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, execute]
  );

  const swap = useCallback(
    (fromToken: string, toToken: string, amount: string) =>
      execute("Swap", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress) throw new Error("Not ready");
        if (!config.ekubo) throw new Error("Ekubo config not set");
        const rawAmount = scaleAmount(fromToken, amount);

        const { executorAddress, poolFee, tickSpacing, extension, skipAhead } = config.ekubo;

        console.log(`[Swap] ${rawAmount} ${fromToken} -> ${toToken}`);

        // Order tokens for pool key (token0 < token1 by numeric value)
        const fromBigInt = BigInt(fromToken);
        const toBigInt = BigInt(toToken);
        const token0 = fromBigInt < toBigInt ? fromToken : toToken;
        const token1 = fromBigInt < toBigInt ? toToken : fromToken;

        // sqrt_ratio_limit for Ekubo Core (router auto-resolves 0 but we
        // pass explicit values for safety):
        // Selling token0 → price decreases → min_sqrt_ratio
        // Selling token1 → price increases → max_sqrt_ratio
        const sellingToken0 = fromBigInt < toBigInt;
        const MIN_SQRT_RATIO = 18446748437148339061n;
        const MAX_SQRT_RATIO = 6277100124014505937173498667991355959230n;
        const sqrtRatioLimit = sellingToken0 ? MIN_SQRT_RATIO : MAX_SQRT_RATIO;
        const sqrtRatioLimitLow = sqrtRatioLimit & ((1n << 128n) - 1n);
        const sqrtRatioLimitHigh = sqrtRatioLimit >> 128n;

        const provingBlockId = (await provider.getBlockNumber()) - 10;
        const { callAndProof } = await transfers
          .build({
            autoSetup: true,
            autoSelectNotes: "all",
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .with(fromToken)
          .withdraw({ recipient: executorAddress, amount: rawAmount })
          .surplusTo(activeAddress, false)
          .with(toToken)
          .transfer({ recipient: activeAddress, amount: Open, depositor: executorAddress })
          .done()
          .invoke((args) => {
            const openNote = args.openNotes[0];
            if (!openNote) {
              throw new Error("Expected one open note for swap invocation");
            }
            const calldata = [
              fromToken,
              toToken,
              rawAmount,
              openNote.noteId,
              token0,
              token1,
              poolFee,
              tickSpacing,
              extension,
              sqrtRatioLimitLow,
              sqrtRatioLimitHigh,
              skipAhead,
            ];
            console.log("[Swap] invoke calldata:", calldata.map(String));
            return { contractAddress: executorAddress, calldata };
          })
          .execute({ provingBlockId });
        console.log("[Swap] callAndProof built, submitting pool tx...");

        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: POOL_RESOURCE_BOUNDS,
          ...(callAndProof.proof.proofFacts?.length
            ? {
                proofFacts: callAndProof.proof.proofFacts,
                proof: callAndProof.proof.data,
              }
            : {}),
        });
        console.log(`[Swap] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, config.ekubo, execute]
  );

  return { status, register, mint, deposit, withdraw, transfer, swap };
}
