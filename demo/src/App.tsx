import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEmptyRegistry } from "starknet-sdk";
import { formatChainId } from "./format.ts";
import { loadConfig } from "./config.ts";
import { createProvider, createAccount, createTransfers } from "./starknet.ts";
import { useAccounts } from "./hooks/useAccounts.ts";
import { usePoolSelector } from "./hooks/usePoolSelector.ts";
import { useDeployPool } from "./hooks/useDeployPool.ts";
import { usePrivateState } from "./hooks/usePrivateState.ts";
import { useHistory } from "./hooks/useHistory.ts";
import { useTransactions } from "./hooks/useTransactions.ts";
import { AccountSelector } from "./components/AccountSelector.tsx";
import { PoolSelector } from "./components/PoolSelector.tsx";
import { InfoPanel } from "./components/InfoPanel.tsx";
import { ActionPanel } from "./components/ActionPanel.tsx";
import { TransactionBuilder } from "./components/TransactionBuilder.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ServiceHealthBar } from "./components/ServiceHealthBar.tsx";
import { useTransactionBuilder } from "./hooks/useTransactionBuilder.ts";
import { useServiceHealth } from "./hooks/useServiceHealth.ts";
import { useTokenMetadata } from "./hooks/useTokenMetadata.ts";
import "./App.css";

const config = loadConfig();

export function App() {
  const [classHash, setClassHash] = useState(config.poolClassHash);

  const { accounts, activeIndex, activeAccount, setActiveIndex, importAccounts } =
    useAccounts();

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  const { activeAddress: poolAddress, search, selectPool, addPool, searchPools, stopSearch, closeSearch } =
    usePoolSelector(provider, config.poolAddress, classHash);

  const configWithClassHash = useMemo(
    () => ({ ...config, poolClassHash: classHash }),
    [classHash],
  );

  const { deploying, deployError, deploy } = useDeployPool(provider, configWithClassHash, accounts);

  const handleDeploy = useCallback(async () => {
    try {
      const result = await deploy();
      addPool({ address: result.address, blockNumber: 0, isDefault: false });
    } catch {
      // Error is already captured in deployError state
    }
  }, [deploy, addPool]);

  const account = useMemo(() => {
    if (!activeAccount) return undefined;
    return createAccount(provider, activeAccount.address, activeAccount.privateKey);
  }, [provider, activeAccount]);

  const transfers = useMemo(() => {
    if (!account || !activeAccount) return undefined;
    return createTransfers(provider, account, activeAccount, poolAddress, config);
  }, [provider, account, activeAccount, poolAddress]);

  const registry = useRef(createEmptyRegistry());

  // Reset registry in-place when account or pool changes so discovery starts
  // fresh. Mutating the existing object (rather than replacing it) ensures that
  // callbacks captured during this render cycle see the cleared state.
  useEffect(() => {
    const reg = registry.current;
    reg.cursor = undefined;
    reg.channels = createEmptyRegistry().channels;
    reg.notes = createEmptyRegistry().notes;
  }, [activeAccount, poolAddress]);

  const tokenAddresses = useMemo(() => [config.tokenAddress], []);
  const tokenMetadata = useTokenMetadata(provider, tokenAddresses);

  const { state, loading, error, refresh, refreshBalances } = usePrivateState(
    provider,
    transfers,
    activeAccount,
    accounts,
    poolAddress,
    config,
    registry.current,
    tokenMetadata,
  );

  const {
    transactions: historyTransactions,
    loading: historyLoading,
    error: historyError,
    historyComplete,
    fetchMore: fetchHistory,
    refreshLatest: refreshHistoryLatest,
  } = useHistory(provider, poolAddress, config, activeAccount, accounts, registry.current, tokenMetadata);

  const refreshAll = useCallback(async () => {
    // Reset cursors so refresh does a full re-sync — incremental discovery
    // only returns new notes, so stale cursors would yield empty results
    // after a transaction that consumed/created notes.
    const reg = registry.current;
    reg.cursor = undefined;
    reg.channels = createEmptyRegistry().channels;
    reg.notes = createEmptyRegistry().notes;
    await refresh();
    refreshHistoryLatest();
  }, [refresh, refreshHistoryLatest]);

  const metadataReady = tokenMetadata.size > 0;

  useEffect(() => {
    if (metadataReady) refresh();
  }, [refresh, metadataReady]);

  const { status, register, mint, deposit, withdraw, transfer } = useTransactions(
    provider,
    transfers,
    activeAccount?.address,
    poolAddress,
    config,
    accounts,
    refreshAll,
    refreshBalances,
  );

  const tokenDecimals = tokenMetadata.get(config.tokenAddress)?.decimals ?? 0;

  const { status: builderStatus, executeBatch } = useTransactionBuilder(
    provider,
    transfers,
    activeAccount?.address,
    poolAddress,
    config,
    accounts,
    refreshAll,
    tokenDecimals,
  );

  const serviceHealth = useServiceHealth(provider, config);

  const [activeView, setActiveView] = useState<"actions" | "builder">("actions");

  return (
    <div className="app">
      <h1>Privacy Pool Explorer</h1>
      <div className="subtitle">
        Chain: <code>{formatChainId(config.chainId)}</code>
        <ServiceHealthBar health={serviceHealth} />
      </div>
      <PoolSelector
        activeAddress={poolAddress}
        search={search}
        deploying={deploying}
        deployError={deployError}
        classHash={classHash}
        onSelect={selectPool}
        onSearch={searchPools}
        onStopSearch={stopSearch}
        onCloseSearch={closeSearch}
        onDeploy={handleDeploy}
        onClassHashChange={setClassHash}
      />
      <AccountSelector
        accounts={accounts}
        activeIndex={activeIndex}
        onSelect={setActiveIndex}
        onSave={importAccounts}
      />
      {activeAccount && (
        <>
          <StatusBar status={activeView === "actions" ? status : builderStatus} />
          <div className="main-layout">
            <InfoPanel
              state={state}
              loading={loading}
              error={error}
              onRefresh={refreshAll}
              historyTransactions={historyTransactions}
              explorerUrl={config.explorerUrl}
              historyLoading={historyLoading}
              historyError={historyError}
              historyComplete={historyComplete}
              onFetchHistory={fetchHistory}
            />
            <div className="action-panel">
              <div className="view-toggle">
                <button
                  className={activeView === "actions" ? "active" : ""}
                  onClick={() => setActiveView("actions")}
                >
                  Actions
                </button>
                <button
                  className={activeView === "builder" ? "active" : ""}
                  onClick={() => setActiveView("builder")}
                >
                  Builder
                </button>
              </div>
              {activeView === "actions" ? (
                <ActionPanel
                  pending={status.pending}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  tokenDecimals={tokenDecimals}
                  onRegister={register}
                  onMint={mint}
                  onDeposit={deposit}
                  onWithdraw={withdraw}
                  onTransfer={transfer}
                />
              ) : (
                <TransactionBuilder
                  pending={builderStatus.pending}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  onExecute={executeBatch}
                />
              )}
            </div>
          </div>
        </>
      )}
      <footer className="app-footer">
        Built by Starkware &middot; Docs{" "}
        <a href="https://github.com/starkware-libs/starknet-privacy" target="_blank" rel="noreferrer">
          github.com/starkware-libs/starknet-privacy
        </a>
      </footer>
    </div>
  );
}
