import { useState, useCallback, useMemo } from "react";
import { Account, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AccountConfig, AppConfig } from "../config.ts";

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

export type TransactionStatus = {
  pending: boolean;
  lastTxHash: string | null;
  lastError: string | null;
  proofSizeBytes: number | null;
};

export function useTransactions(
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
  });

  const adminAccount = useMemo(() => {
    if (!provider) return undefined;
    const admin = accounts.find((a) => a.admin);
    if (!admin) return undefined;
    return new Account({
      provider,
      address: admin.address,
      signer: admin.privateKey,
      cairoVersion: "1",
    });
  }, [provider, accounts]);

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    // Find the private key for active address from config
    const accountConfig = accounts.find(
      (a) => a.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return new Account({
      provider,
      address: accountConfig.address,
      signer: accountConfig.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAddress, accounts]);

  const execute = useCallback(
    async (action: string, fn: () => Promise<{ txHash: string; proofSizeBytes?: number }>) => {
      console.log(`[${action}] starting...`);
      setStatus({ pending: true, lastTxHash: null, lastError: null, proofSizeBytes: null });
      try {
        const result = await fn();
        console.log(`[${action}] confirmed: ${result.txHash}`);
        setStatus({
          pending: false,
          lastTxHash: result.txHash,
          lastError: null,
          proofSizeBytes: result.proofSizeBytes ?? null,
        });
        onSuccess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${action}] failed:`, err);
        setStatus({ pending: false, lastTxHash: null, lastError: `${action}: ${message}`, proofSizeBytes: null });
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
        const proofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const registerFee = await userAccount.estimateInvokeFee(callAndProof.call, proofDetails);
        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: registerFee.resourceBounds,
          ...proofDetails,
        });
        console.log(`[Register] tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, execute],
  );

  const mint = useCallback(
    (amount: bigint) =>
      execute("Mint", async () => {
        if (!adminAccount || !activeAddress || !provider)
          throw new Error("Not ready");
        console.log(`[Mint] amount=${amount} to=${activeAddress}`);
        const mintCall = {
          contractAddress: config.tokenAddress,
          entrypoint: "permissionedMint",
          calldata: [activeAddress, amount.toString(), "0"],
        };
        const mintFee = await adminAccount.estimateInvokeFee(mintCall);
        const tx = await adminAccount.execute(mintCall, {
          resourceBounds: mintFee.resourceBounds,
        });
        console.log(`[Mint] tx submitted: ${tx.transaction_hash}`);
        await provider.waitForTransaction(tx.transaction_hash);
        return { txHash: tx.transaction_hash };
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
        const approveCall = {
          contractAddress: config.tokenAddress,
          entrypoint: "approve",
          calldata: [poolAddress, amount.toString(), "0"],
        };
        const approveFee = await userAccount.estimateInvokeFee(approveCall);
        const approveTx = await userAccount.execute(approveCall, {
          resourceBounds: approveFee.resourceBounds,
        });
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
        const depositProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const depositFee = await userAccount.estimateInvokeFee(callAndProof.call, depositProofDetails);
        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: depositFee.resourceBounds,
          ...depositProofDetails,
        });
        console.log(`[Deposit] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
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
        const withdrawProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const withdrawFee = await userAccount.estimateInvokeFee(callAndProof.call, withdrawProofDetails);
        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: withdrawFee.resourceBounds,
          ...withdrawProofDetails,
        });
        console.log(`[Withdraw] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
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
        const transferProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const transferFee = await userAccount.estimateInvokeFee(callAndProof.call, transferProofDetails);
        const executeTx = await userAccount.execute(callAndProof.call, {
          resourceBounds: transferFee.resourceBounds,
          ...transferProofDetails,
        });
        console.log(`[Transfer] pool tx: ${executeTx.transaction_hash}`);
        const receipt = await provider.waitForTransaction(
          executeTx.transaction_hash,
        );
        if (!receipt.isSuccess()) {
          throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        }
        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  return { status, register, mint, deposit, withdraw, transfer };
}
