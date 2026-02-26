import { useCallback, useEffect, useMemo, useState } from "react";
import { formatChainId } from "./format.ts";
import { loadConfig } from "./config.ts";
import { createProvider, createAccount, createTransfers } from "./starknet.ts";
import { useAccounts } from "./hooks/useAccounts.ts";
import { usePoolSelector } from "./hooks/usePoolSelector.ts";
import { useDeployPool } from "./hooks/useDeployPool.ts";
import { usePrivateState } from "./hooks/usePrivateState.ts";
import { useTransactions } from "./hooks/useTransactions.ts";
import { AccountSelector } from "./components/AccountSelector.tsx";
import { PoolSelector } from "./components/PoolSelector.tsx";
import { InfoPanel } from "./components/InfoPanel.tsx";
import { ActionPanel } from "./components/ActionPanel.tsx";
import { TransactionBuilder } from "./components/TransactionBuilder.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { useTransactionBuilder } from "./hooks/useTransactionBuilder.ts";
import "./App.css";

const config = loadConfig();

export function App() {
  const [classHash, setClassHash] = useState(config.poolClassHash);
  const [editingClassHash, setEditingClassHash] = useState(false);
  const [classHashDraft, setClassHashDraft] = useState("");

  const { accounts, activeIndex, activeAccount, setActiveIndex } =
    useAccounts(config.accounts);

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  const { pools, activePool, selectPool, addPool, loading: poolsLoading } =
    usePoolSelector(provider, config.poolAddress, classHash);

  const configWithClassHash = useMemo(
    () => ({ ...config, poolClassHash: classHash }),
    [classHash],
  );

  const { deploying, deployError, deploy } = useDeployPool(provider, configWithClassHash);

  const handleDeploy = useCallback(async () => {
    try {
      const result = await deploy();
      addPool({ address: result.address, isDefault: false });
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
    return createTransfers(provider, account, activeAccount, activePool.address, config);
  }, [provider, account, activeAccount, activePool.address]);

  const { state, loading, error, refresh } = usePrivateState(
    provider,
    transfers,
    activeAccount,
    activePool.address,
    config,
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { status, register, mint, deposit, withdraw, transfer } = useTransactions(
    provider,
    transfers,
    activeAccount?.address,
    activePool.address,
    config,
    refresh,
  );

  const { status: builderStatus, executeBatch } = useTransactionBuilder(
    provider,
    transfers,
    activeAccount?.address,
    activePool.address,
    config,
    refresh,
  );

  const [activeView, setActiveView] = useState<"actions" | "builder">("actions");

  return (
    <div className="app">
      <h1>Privacy Pool Explorer</h1>
      <div className="subtitle">
        Chain: <code>{formatChainId(config.chainId)}</code> | Pool class:{" "}
        {editingClassHash ? (
          <span className="class-hash-edit">
            <input
              value={classHashDraft}
              onChange={(event) => setClassHashDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setClassHash(classHashDraft);
                  setEditingClassHash(false);
                }
                if (event.key === "Escape") {
                  setEditingClassHash(false);
                }
              }}
              autoFocus
            />
            <button
              onClick={() => {
                setClassHash(classHashDraft);
                setEditingClassHash(false);
              }}
            >
              Apply
            </button>
          </span>
        ) : (
          <code
            onDoubleClick={() => {
              setClassHashDraft(classHash);
              setEditingClassHash(true);
            }}
            title="Double-click to edit"
          >
            {classHash}
          </code>
        )}
      </div>
      <PoolSelector
        pools={pools}
        activePool={activePool}
        loading={poolsLoading}
        deploying={deploying}
        deployError={deployError}
        onSelect={selectPool}
        onDeploy={handleDeploy}
      />
      <AccountSelector
        accounts={accounts}
        activeIndex={activeIndex}
        onSelect={setActiveIndex}
      />
      <StatusBar status={activeView === "actions" ? status : builderStatus} />
      <div className="main-layout">
        <InfoPanel
          state={state}
          loading={loading}
          error={error}
          onRefresh={refresh}
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
              otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
              onRegister={register}
              onMint={mint}
              onDeposit={deposit}
              onWithdraw={withdraw}
              onTransfer={transfer}
            />
          ) : (
            <TransactionBuilder
              pending={builderStatus.pending}
              activeAddress={activeAccount!.address}
              otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
              onExecute={executeBatch}
            />
          )}
        </div>
      </div>
    </div>
  );
}
