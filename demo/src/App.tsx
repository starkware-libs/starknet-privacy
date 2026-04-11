import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEmptyRegistry } from "starknet-sdk";
import { formatChainId } from "./format.ts";
import { loadConfig, initPaymasterForwarder } from "./config.ts";
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
import { DefiPanel } from "./components/DefiPanel.tsx";
import { useTokenMetadata } from "./hooks/useTokenMetadata.ts";
import "./App.css";

const config = loadConfig();

export function App() {
  const [classHash, setClassHash] = useState(config.poolClassHash);
  const [paymasterForwarderAddress, setPaymasterForwarderAddress] = useState<string | undefined>();

  useEffect(() => {
    initPaymasterForwarder(config).then(() => {
      setPaymasterForwarderAddress(config.paymasterForwarderAddress);
    });
  }, []);
  const [paymasterEnabled, setPaymasterEnabled] = useState(() => {
    const stored = localStorage.getItem("paymasterEnabled");
    return stored !== null ? stored === "true" : true;
  });

  const togglePaymaster = useCallback((enabled: boolean) => {
    setPaymasterEnabled(enabled);
    localStorage.setItem("paymasterEnabled", String(enabled));
  }, []);

  const [ohttpEnabled, setOhttpEnabled] = useState(() => {
    const stored = localStorage.getItem("ohttpEnabled");
    return stored !== null ? stored === "true" : true;
  });

  const toggleOhttp = useCallback((enabled: boolean) => {
    setOhttpEnabled(enabled);
    localStorage.setItem("ohttpEnabled", String(enabled));
  }, []);

  const { accounts, activeIndex, activeAccount, setActiveIndex, importAccounts } =
    useAccounts();

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  const { activeAddress: poolAddress, search, selectPool, addPool, searchPools, stopSearch, closeSearch } =
    usePoolSelector(provider, config.poolAddress, classHash);

  const configWithClassHash = useMemo(
    () => ({ ...config, poolClassHash: classHash }),
    [classHash],
  );

  const effectiveConfig = useMemo(
    () => ({
      ...config,
      ...(paymasterEnabled ? {} : { paymasterUrl: undefined }),
      ohttpEnabled,
      paymasterForwarderAddress,
    }),
    [paymasterEnabled, ohttpEnabled, paymasterForwarderAddress],
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
    return createTransfers(provider, account, activeAccount, poolAddress, effectiveConfig);
  }, [provider, account, activeAccount, poolAddress, effectiveConfig]);

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

  const { state, loading, error, refresh, refreshBalances } = usePrivateState(
    provider,
    transfers,
    activeAccount,
    accounts,
    poolAddress,
    effectiveConfig,
    registry.current,
  );

  const {
    transactions: historyTransactions,
    loading: historyLoading,
    error: historyError,
    historyComplete,
    fetchMore: fetchHistory,
    refreshLatest: refreshHistoryLatest,
  } = useHistory(provider, poolAddress, effectiveConfig, activeAccount, accounts, registry.current);

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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { status, register, mint, deposit, withdraw, transfer, swap, vesuSupply, vesuWithdraw } = useTransactions(
    provider,
    transfers,
    activeAccount?.address,
    poolAddress,
    effectiveConfig,
    accounts,
    refreshAll,
    refreshBalances,
  );

  const { status: builderStatus, executeBatch } = useTransactionBuilder(
    provider,
    transfers,
    activeAccount?.address,
    poolAddress,
    effectiveConfig,
    accounts,
    refreshAll,
  );

  const serviceHealth = useServiceHealth(provider, effectiveConfig);

  const [activeView, setActiveView] = useState<"actions" | "builder" | "defi">("actions");

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
          <StatusBar status={activeView === "builder" ? builderStatus : status} />
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
                {(config.ekubo || config.vesu) && (
                  <button
                    className={activeView === "defi" ? "active" : ""}
                    onClick={() => setActiveView("defi")}
                  >
                    DeFi
                  </button>
                )}
              </div>
              {activeView === "actions" && (
                <ActionPanel
                  pending={status.pending}
                  pendingAction={status.action}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  tokens={config.tokens}
                  onRegister={register}
                  onMint={mint}
                  onDeposit={deposit}
                  onWithdraw={withdraw}
                  onTransfer={transfer}
                />
              )}
              {activeView === "builder" && (
                <TransactionBuilder
                  pending={builderStatus.pending}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  tokens={config.tokens}
                  onExecute={executeBatch}
                />
              )}
              {activeView === "defi" && (
                <DefiPanel
                  pending={status.pending}
                  pendingAction={status.action}
                  tokens={config.tokens}
                  swapTokens={config.ekubo?.swapTokens}
                  provider={provider}
                  ekubo={config.ekubo}
                  vesu={config.vesu}
                  onSwap={swap}
                  onVesuSupply={vesuSupply}
                  onVesuWithdraw={vesuWithdraw}
                />
              )}
              <div className="config-island">
                <h3>Config</h3>
                <label className="builder-checkbox">
                  <input
                    type="checkbox"
                    checked={ohttpEnabled}
                    onChange={(e) => toggleOhttp(e.target.checked)}
                  />
                  OHTTP
                  {config.backendIndexerUrl && <span className="chip">relay</span>}
                </label>
                {config.paymasterUrl && (
                  <label className="builder-checkbox">
                    <input
                      type="checkbox"
                      checked={paymasterEnabled}
                      onChange={(e) => togglePaymaster(e.target.checked)}
                    />
                    Paymaster
                    {config.paymasterFeeToken && (
                      <span className="chip">
                        {config.tokens.find((t) => t.address === config.paymasterFeeToken)?.name ?? "?"}
                      </span>
                    )}
                  </label>
                )}
              </div>
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
