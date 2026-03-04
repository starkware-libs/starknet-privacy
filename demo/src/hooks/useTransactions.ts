import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AppConfig } from "../config.ts";
import {
  ERC20_RESOURCE_BOUNDS,
  POOL_RESOURCE_BOUNDS,
} from "../starknet.ts";

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
  onSuccess: () => void,
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
    const accountConfig = config.accounts.find(
      (a) => a.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return new Account({
      provider,
      address: accountConfig.address,
      signer: accountConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAddress, config.accounts]);

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
    [onSuccess],
  );

  const register = useCallback(
    () =>
      execute("Register", async () => {
        if (!userAccount || !transfers || !provider)
          throw new Error("Not ready");

        console.log("[Register] registering account in privacy pool...");

        const provingBlockId = await provider.getBlockNumber() - 10;
        const { callAndProof } = await transfers
          .build()
          .register()
          .execute({ provingBlockId });
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
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, execute],
  );

  const mint = useCallback(
    (amount: bigint) =>
      execute("Mint", async () => {
        if (!adminAccount || !activeAddress || !provider)
          throw new Error("Not ready");
        console.log(`[Mint] amount=${amount} to=${activeAddress}`);
        const tx = await adminAccount.execute(
          {
            contractAddress: config.tokenAddress,
            entrypoint: "permissionedMint",
            calldata: [activeAddress, amount.toString(), "0"],
          },
          { resourceBounds: ERC20_RESOURCE_BOUNDS },
        );
        console.log(`[Mint] tx submitted: ${tx.transaction_hash}`);
        await provider.waitForTransaction(tx.transaction_hash);
        return tx.transaction_hash;
      }),
    [adminAccount, activeAddress, provider, config.tokenAddress, execute],
  );

  const deposit = useCallback(
    (amount: bigint) =>
      execute("Deposit", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        console.log(`[Deposit] amount=${amount} recipient=${activeAddress}`);

        // Approve pool to spend tokens
        const approveTx = await userAccount.execute(
          {
            contractAddress: config.tokenAddress,
            entrypoint: "approve",
            calldata: [poolAddress, amount.toString(), "0"],
          },
          { resourceBounds: ERC20_RESOURCE_BOUNDS },
        );
        console.log(`[Deposit] approve tx: ${approveTx.transaction_hash}`);
        await provider.waitForTransaction(approveTx.transaction_hash);

        // Build and execute deposit
        const provingBlockId = await provider.getBlockNumber() - 10;
        const { callAndProof } = await transfers
          .build({
            autoRegister: true,
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
          })
          .with(config.tokenAddress, (t) =>
            t.deposit({ amount, recipient: activeAddress }),
          )
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
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  const withdraw = useCallback(
    (amount: bigint) =>
      execute("Withdraw", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        console.log(`[Withdraw] amount=${amount} recipient=${activeAddress}`);

        const provingBlockId = await provider.getBlockNumber() - 10;
        const { callAndProof } = await transfers
          .build({
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(config.tokenAddress, (t) =>
            t.withdraw({ amount, recipient: activeAddress }),
          )
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
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  const transfer = useCallback(
    (recipient: string, amount: bigint) =>
      execute("Transfer", async () => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        console.log(`[Transfer] amount=${amount} recipient=${recipient}`);

        const provingBlockId = await provider.getBlockNumber() - 10;
        const { callAndProof } = await transfers
          .build({
            autoSetup: true,
            autoDiscover: { notes: "refresh", channels: "refresh" },
            autoSelectNotes: "naive",
          })
          .surplusTo(activeAddress)
          .with(config.tokenAddress, (t) =>
            t.transfer({ recipient, amount }),
          )
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
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        return executeTx.transaction_hash;
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  return { status, register, mint, deposit, withdraw, transfer };
}
