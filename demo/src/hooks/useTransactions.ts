import { useState, useCallback, useMemo } from "react";
import { TransactionFinalityStatus, type RpcProvider } from "starknet";
import type { PrivateTransfersInterface } from "starknet-sdk";
import type { AccountConfig, AppConfig } from "../config.ts";
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

export type TransactionStatus = {
  pending: boolean;
  lastTxHash: string | null;
  lastError: string | null;
  proofSizeBytes: number | null;
  timeline: Timeline | null;
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
    timeline: null,
  });

  const adminAccount = useMemo(() => {
    if (!provider) return undefined;
    const admin = accounts.find((a) => a.admin);
    if (!admin) return undefined;
    return createAccount(provider, admin);
  }, [provider, accounts]);

  const userAccount = useMemo(() => {
    if (!provider || !activeAddress) return undefined;
    const accountConfig = accounts.find(
      (a) => a.address === activeAddress,
    );
    if (!accountConfig) return undefined;
    return createAccount(provider, accountConfig);
  }, [provider, activeAddress, accounts]);

  const execute = useCallback(
    async (action: string, fn: (tl: Timeline) => Promise<{ txHash: string; proofSizeBytes?: number }>) => {
      const timeline = new Timeline();
      setStatus({ pending: true, lastTxHash: null, lastError: null, proofSizeBytes: null, timeline: null });
      try {
        const result = await timeline.step(action, () => fn(timeline));
        setStatus({
          pending: false,
          lastTxHash: result.txHash,
          lastError: null,
          proofSizeBytes: result.proofSizeBytes ?? null,
          timeline,
        });
        onSuccess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${action}] failed:`, err);
        setStatus({ pending: false, lastTxHash: null, lastError: `${action}: ${message}`, proofSizeBytes: null, timeline });
      }
    },
    [onSuccess],
  );

  const register = useCallback(
    () =>
      execute("Register", async (tl) => {
        if (!userAccount || !transfers || !provider)
          throw new Error("Not ready");

        const provingBlockId = await tl.step("Get block number",
          () => provider.getBlockNumber(),
        ) - 10;

        const { callAndProof } = await tl.step("SDK build + prove", () =>
          transfers.build().register().execute({ provingBlockId }),
        );

        const proofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const executeTx = await tl.step("Estimate + submit", () =>
          userAccount.execute(callAndProof.call, {
            tip: 0n,
            ...proofDetails,
          }),
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(executeTx.transaction_hash, WAIT_OPTIONS),
        ).then((receipt) => {
          if (!receipt.isSuccess())
            throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        });

        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, execute],
  );

  const mint = useCallback(
    (amount: bigint) =>
      execute("Mint", async (tl) => {
        if (!adminAccount || !activeAddress || !provider)
          throw new Error("Not ready");

        const mintCall = {
          contractAddress: config.tokenAddress,
          entrypoint: "permissionedMint",
          calldata: [activeAddress, amount.toString(), "0"],
        };

        const tx = await tl.step("Estimate + submit", () =>
          adminAccount.execute(mintCall, { tip: 0n }),
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(tx.transaction_hash, WAIT_OPTIONS),
        );

        return { txHash: tx.transaction_hash };
      }),
    [adminAccount, activeAddress, provider, config.tokenAddress, execute],
  );

  const deposit = useCallback(
    (amount: bigint) =>
      execute("Deposit", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        await tl.step("Approve", async () => {
          const approveCall = {
            contractAddress: config.tokenAddress,
            entrypoint: "approve",
            calldata: [poolAddress, amount.toString(), "0"],
          };
          const approveTx = await tl.step("Estimate + submit", () =>
            userAccount.execute(approveCall, { tip: 0n }),
          );
          await tl.step("Wait for receipt", () =>
            provider.waitForTransaction(approveTx.transaction_hash, WAIT_OPTIONS),
          );
        });

        const provingBlockId = await tl.step("Get block number",
          () => provider.getBlockNumber(),
        ) - 10;

        const { callAndProof } = await tl.step("SDK build + prove", () =>
          transfers
            .build({
              autoRegister: true,
              autoSetup: true,
              autoDiscover: { notes: "refresh", channels: "refresh" },
            })
            .with(config.tokenAddress, (t) =>
              t.deposit({ amount, recipient: activeAddress }),
            )
            .execute({ provingBlockId }),
        );

        const depositProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const executeTx = await tl.step("Estimate + submit", () =>
          userAccount.execute(callAndProof.call, {
            tip: 0n,
            ...depositProofDetails,
          }),
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(executeTx.transaction_hash, WAIT_OPTIONS),
        ).then((receipt) => {
          if (!receipt.isSuccess())
            throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        });

        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, activeAddress, config, poolAddress, execute],
  );

  const withdraw = useCallback(
    (amount: bigint) =>
      execute("Withdraw", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        const provingBlockId = await tl.step("Get block number",
          () => provider.getBlockNumber(),
        ) - 10;

        const { callAndProof } = await tl.step("SDK build + prove", () =>
          transfers
            .build({
              autoDiscover: { notes: "refresh", channels: "refresh" },
              autoSelectNotes: "naive",
            })
            .surplusTo(activeAddress)
            .with(config.tokenAddress, (t) =>
              t.withdraw({ amount, recipient: activeAddress }),
            )
            .execute({ provingBlockId }),
        );

        const withdrawProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const executeTx = await tl.step("Estimate + submit", () =>
          userAccount.execute(callAndProof.call, {
            tip: 0n,
            ...withdrawProofDetails,
          }),
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(executeTx.transaction_hash, WAIT_OPTIONS),
        ).then((receipt) => {
          if (!receipt.isSuccess())
            throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        });

        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  const transfer = useCallback(
    (recipient: string, amount: bigint) =>
      execute("Transfer", async (tl) => {
        if (!userAccount || !transfers || !provider || !activeAddress)
          throw new Error("Not ready");

        const provingBlockId = await tl.step("Get block number",
          () => provider.getBlockNumber(),
        ) - 10;

        const { callAndProof } = await tl.step("SDK build + prove", () =>
          transfers
            .build({
              autoSetup: true,
              autoDiscover: { notes: "refresh", channels: "refresh" },
              autoSelectNotes: "naive",
            })
            .surplusTo(activeAddress)
            .with(config.tokenAddress, (t) =>
              t.transfer({ recipient, amount }),
            )
            .execute({ provingBlockId }),
        );

        const transferProofDetails = callAndProof.proof.proofFacts?.length
          ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
          : {};

        const executeTx = await tl.step("Estimate + submit", () =>
          userAccount.execute(callAndProof.call, {
            tip: 0n,
            ...transferProofDetails,
          }),
        );

        await tl.step("Wait for receipt", () =>
          provider.waitForTransaction(executeTx.transaction_hash, WAIT_OPTIONS),
        ).then((receipt) => {
          if (!receipt.isSuccess())
            throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
        });

        const proofSizeBytes = callAndProof.proof.data
          ? base64ByteLength(callAndProof.proof.data)
          : undefined;
        return { txHash: executeTx.transaction_hash, proofSizeBytes };
      }),
    [userAccount, transfers, provider, activeAddress, config, execute],
  );

  return { status, register, mint, deposit, withdraw, transfer };
}
