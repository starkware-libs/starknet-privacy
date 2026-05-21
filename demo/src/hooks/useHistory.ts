import { useState, useCallback, useRef, useEffect } from "react";
import {
  classifyTransaction,
  type ClassifyOptions,
  type PrivateRegistry,
  type HistoryCursor,
  type HistoryAction,
  type HistoryTransaction,
} from "@starkware-libs/starknet-privacy-sdk";
import type { RpcProvider } from "starknet";
import type { AppConfig, AccountConfig } from "../config.ts";
import { createDiscoveryProvider } from "../starknet.ts";
import { formatTokenAmount, truncateAddress } from "../format.ts";

export type ActionDisplay = {
  type: HistoryAction["type"];
  label: string;
  chipClass: string;
  chipLabel?: string;
  noteCount?: number;
  isFee?: boolean;
};

export type BalanceUpdate = {
  tokenName: string;
  amount: bigint; // positive = incoming, negative = outgoing
  decimals: number;
};

export type TransactionDisplay = {
  blockNumber: number;
  timestamp: number | null;
  transactionHash: string;
  fullTransactionHash: string;
  actions: ActionDisplay[];
  balanceUpdates: BalanceUpdate[];
};

function formatActionLabel(
  action: HistoryAction,
  nameByAddress: Map<bigint, string>,
  tokenNameByAddress: Map<bigint, string>,
  tokenDecimalsByAddress: Map<bigint, number>,
  executorNames: Map<bigint, string>
): { label: string; chipClass: string; chipLabel?: string; isFee?: boolean } {
  const tokenName = (token: bigint) =>
    tokenNameByAddress.get(token) ?? truncateAddress(token.toString(16));
  const resolveName = (address: bigint) =>
    nameByAddress.get(address) ?? truncateAddress(address.toString(16));
  const fmtAmount = (amount: bigint, token: bigint) =>
    formatTokenAmount(amount, tokenDecimalsByAddress.get(token) ?? 0);

  switch (action.type) {
    case "deposit":
      return {
        label: `Deposited ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)}`,
        chipClass: "chip-ok",
      };
    case "withdrawal":
      return {
        label: `Withdrew ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)} to ${resolveName(action.toAddress)}`,
        chipClass: "chip-no",
      };
    case "fee":
      return {
        label: `Withdrew ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)} to paymaster`,
        chipClass: "chip",
        isFee: true,
      };
    case "transferSent": {
      const name =
        nameByAddress.get(action.toAddress) ?? truncateAddress(action.toAddress.toString(16));
      return {
        label: `Sent ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)} to ${name}`,
        chipClass: "chip-no",
      };
    }
    case "transferReceived": {
      const name =
        nameByAddress.get(action.fromAddress) ?? truncateAddress(action.fromAddress.toString(16));
      return {
        label: `Received ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)} from ${name}`,
        chipClass: "chip-ok",
      };
    }
    case "swap": {
      const executorLabel =
        executorNames.get(action.executor) ?? truncateAddress(action.executor.toString(16));
      const sentParts = action.sent.map(
        (leg) => `${fmtAmount(leg.amount, leg.token)} ${tokenName(leg.token)}`
      );
      const receivedParts = action.received.map(
        (leg) => `${fmtAmount(leg.amount, leg.token)} ${tokenName(leg.token)}`
      );
      return {
        label: `Swapped ${sentParts.join(", ")} for ${receivedParts.join(", ")} via ${executorLabel}`,
        chipClass: "chip-swap",
        chipLabel: executorNames.has(action.executor) ? executorLabel : undefined,
      };
    }
    case "transferSelf":
      return {
        label: `Reorganized ${fmtAmount(action.amount, action.token)} ${tokenName(action.token)}`,
        chipClass: "chip",
      };
    case "register":
      return {
        label: "Registered with the privacy pool",
        chipClass: "chip",
      };
  }
}

function computeBalanceUpdates(
  actions: HistoryAction[],
  viewerAddress: bigint,
  tokenNameByAddress: Map<bigint, string>,
  tokenDecimalsByAddress: Map<bigint, number>
): BalanceUpdate[] {
  const netByToken = new Map<bigint, bigint>();

  for (const action of actions) {
    switch (action.type) {
      case "deposit":
        break;
      case "withdrawal":
        if (action.toAddress !== viewerAddress) {
          netByToken.set(action.token, (netByToken.get(action.token) ?? 0n) - action.amount);
        }
        break;
      case "fee":
        netByToken.set(action.token, (netByToken.get(action.token) ?? 0n) - action.amount);
        break;
      case "transferSent":
        netByToken.set(action.token, (netByToken.get(action.token) ?? 0n) - action.amount);
        break;
      case "transferReceived":
        netByToken.set(action.token, (netByToken.get(action.token) ?? 0n) + action.amount);
        break;
      case "swap":
        for (const leg of action.sent) {
          netByToken.set(leg.token, (netByToken.get(leg.token) ?? 0n) - leg.amount);
        }
        for (const leg of action.received) {
          netByToken.set(leg.token, (netByToken.get(leg.token) ?? 0n) + leg.amount);
        }
        break;
      case "transferSelf":
        break;
      case "register":
        break;
    }
  }

  const resolveTokenName = (token: bigint): string =>
    tokenNameByAddress.get(token) ?? truncateAddress(token.toString(16));

  return Array.from(netByToken.entries()).map(([token, amount]) => ({
    tokenName: resolveTokenName(token),
    amount,
    decimals: tokenDecimalsByAddress.get(token) ?? 0,
  }));
}

function buildDisplayMaps(
  account: AccountConfig,
  allAccounts: AccountConfig[],
  config: AppConfig
): {
  nameByAddress: Map<bigint, string>;
  tokenNameByAddress: Map<bigint, string>;
  tokenDecimalsByAddress: Map<bigint, number>;
  executorNames: Map<bigint, string>;
} {
  const nameByAddress = new Map<bigint, string>();
  for (const acc of allAccounts) {
    const accAddress = BigInt(acc.address);
    nameByAddress.set(
      accAddress,
      accAddress === BigInt(account.address) ? "self" : acc.name.toLowerCase()
    );
  }
  const tokenNameByAddress = new Map<bigint, string>();
  const tokenDecimalsByAddress = new Map<bigint, number>();
  for (const token of config.tokens) {
    const addr = BigInt(token.address);
    tokenNameByAddress.set(addr, token.name);
    tokenDecimalsByAddress.set(addr, token.decimals);
  }
  const executorNames = new Map<bigint, string>();
  if (config.ekubo) {
    executorNames.set(BigInt(config.ekubo.executorAddress), "ekubo swap");
  }
  if (config.vesu) {
    executorNames.set(BigInt(config.vesu.anonymizerAddress), "vesu swap");
  }
  return { nameByAddress, tokenNameByAddress, tokenDecimalsByAddress, executorNames };
}

const ACTION_ORDER: Record<string, number> = {
  register: 0,
  deposit: 1,
  transferReceived: 2,
  transferSelf: 3,
  transferSent: 4,
  swap: 5,
  withdrawal: 6,
  fee: 7,
};

function toDisplayTransactions(
  rawTransactions: HistoryTransaction[],
  viewerAddress: bigint,
  nameByAddress: Map<bigint, string>,
  tokenNameByAddress: Map<bigint, string>,
  tokenDecimalsByAddress: Map<bigint, number>,
  executorNames: Map<bigint, string>,
  paymasterForwarderAddress: bigint | undefined
): TransactionDisplay[] {
  const classifyOptions: ClassifyOptions | undefined = paymasterForwarderAddress
    ? { feeRecipients: [paymasterForwarderAddress] }
    : undefined;
  return rawTransactions.map((transaction) => {
    const classified = classifyTransaction(transaction, classifyOptions);
    const actions: ActionDisplay[] = classified.actions
      .map((action) => {
        const { label, chipClass, chipLabel, isFee } = formatActionLabel(
          action,
          nameByAddress,
          tokenNameByAddress,
          tokenDecimalsByAddress,
          executorNames
        );
        const noteCount = "noteCount" in action ? action.noteCount : undefined;
        return { type: action.type, label, chipClass, chipLabel, noteCount, isFee };
      })
      .sort((a, b) => (ACTION_ORDER[a.type] ?? 99) - (ACTION_ORDER[b.type] ?? 99));
    const balanceUpdates = computeBalanceUpdates(
      classified.actions,
      viewerAddress,
      tokenNameByAddress,
      tokenDecimalsByAddress
    );
    return {
      blockNumber: classified.blockNumber,
      timestamp: null,
      transactionHash: truncateAddress(classified.transactionHash.toString(16)),
      fullTransactionHash: `0x${classified.transactionHash.toString(16)}`,
      actions,
      balanceUpdates,
    };
  });
}

async function resolveTimestamps(
  provider: RpcProvider,
  transactions: TransactionDisplay[]
): Promise<TransactionDisplay[]> {
  const blockNumbers = [...new Set(transactions.map((tx) => tx.blockNumber))];
  const entries = await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await provider.getBlock(blockNumber);
      return [blockNumber, block.timestamp] as const;
    })
  );
  const timestampByBlock = new Map(entries);
  return transactions.map((tx) => ({
    ...tx,
    timestamp: timestampByBlock.get(tx.blockNumber) ?? null,
  }));
}

export function useHistory(
  provider: RpcProvider | undefined,
  poolAddress: string,
  config: AppConfig,
  account: AccountConfig | undefined,
  allAccounts: AccountConfig[],
  registry: PrivateRegistry
) {
  const [transactions, setTransactions] = useState<TransactionDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyComplete, setHistoryComplete] = useState(false);

  const historyCursorRef = useRef<HistoryCursor | undefined>(undefined);
  const blockRefValue = useRef<string | undefined>(undefined);
  const loadingRef = useRef(false);

  const autoFetchedRef = useRef(false);

  // Reset on account/pool change
  useEffect(() => {
    setTransactions([]);
    setError(null);
    setHistoryComplete(false);
    historyCursorRef.current = undefined;
    blockRefValue.current = undefined;
    autoFetchedRef.current = false;
  }, [account, poolAddress]);

  const fetchMore = useCallback(async () => {
    if (!account || loadingRef.current) return;

    if (!registry.cursor || !registry.channels) {
      setError("Refresh state first to populate discovery cursors");
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const indexer = createDiscoveryProvider(config, poolAddress);
      const page = await indexer.fetchHistory(
        BigInt(account.address),
        registry.cursor,
        { channels: registry.channels },
        {
          maxTransactions: 5,
          historyCursor: historyCursorRef.current,
          blockRef: blockRefValue.current,
        }
      );

      historyCursorRef.current = page.cursor;
      blockRefValue.current = page.blockRef;
      setHistoryComplete(page.cursor.historyComplete);

      const { nameByAddress, tokenNameByAddress, tokenDecimalsByAddress, executorNames } =
        buildDisplayMaps(account, allAccounts, config);
      let newTransactions = toDisplayTransactions(
        page.transactions,
        BigInt(account.address),
        nameByAddress,
        tokenNameByAddress,
        tokenDecimalsByAddress,
        executorNames,
        config.paymasterForwarderAddress ? BigInt(config.paymasterForwarderAddress) : undefined
      );
      if (provider) {
        newTransactions = await resolveTimestamps(provider, newTransactions);
      }

      setTransactions((previous) => [...previous, ...newTransactions]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [account, registry, config, poolAddress, allAccounts]);

  // Fetch the latest transaction (no pagination cursor) and prepend if new.
  // Intended to be called after state refresh so cursors are up to date.
  // Retries once after a delay if the indexer hasn't caught up yet.
  const refreshLatest = useCallback(async () => {
    if (!account || loadingRef.current) return;
    if (!registry.cursor || !registry.channels) return;

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const indexer = createDiscoveryProvider(config, poolAddress);
      const page = await indexer.fetchHistory(
        BigInt(account.address),
        registry.cursor,
        { channels: registry.channels },
        { maxTransactions: 1, blockIdentifier: "pre_confirmed" },
      );

      if (page.transactions.length === 0) return;

      const { nameByAddress, tokenNameByAddress, tokenDecimalsByAddress, executorNames } =
        buildDisplayMaps(account, allAccounts, config);
      const freshTransactions = toDisplayTransactions(
        page.transactions,
        BigInt(account.address),
        nameByAddress,
        tokenNameByAddress,
        tokenDecimalsByAddress,
        executorNames,
        config.paymasterForwarderAddress ? BigInt(config.paymasterForwarderAddress) : undefined
      ).map((tx) => ({ ...tx, timestamp: Math.floor(Date.now() / 1000) }));

      setTransactions((previous) => {
        const existingHashes = new Set(previous.map((tx) => tx.transactionHash));
        const newOnly = freshTransactions.filter((tx) => !existingHashes.has(tx.transactionHash));
        if (newOnly.length === 0) return previous;
        return [...newOnly, ...previous];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [account, registry, config, poolAddress, allAccounts]);

  // Auto-fetch first page when cursors become available
  useEffect(() => {
    if (autoFetchedRef.current) return;
    if (!registry.cursor || !registry.channels) return;
    autoFetchedRef.current = true;
    fetchMore();
  }, [registry.cursor, registry.channels, fetchMore]);

  return {
    transactions,
    loading,
    error,
    historyComplete,
    fetchMore,
    refreshLatest,
  };
}
