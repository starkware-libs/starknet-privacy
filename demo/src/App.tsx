import { useCallback, useEffect, useMemo } from "react";
import { formatChainId, truncateAddress } from "./format.ts";
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
import { StatusBar } from "./components/StatusBar.tsx";
import "./App.css";

const config = loadConfig();

export function App() {
  const { accounts, activeIndex, activeAccount, setActiveIndex, addAccount } =
    useAccounts(config.accounts);

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  const { pools, activePool, selectPool, addPool, loading: poolsLoading } =
    usePoolSelector(provider, config.poolAddress, config.poolClassHash);

  const { deploying, deployError, deploy } = useDeployPool(provider, config);

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

  const { status, mint, deposit, withdraw, transfer } = useTransactions(
    provider,
    transfers,
    activeAccount?.address,
    activePool.address,
    config,
    refresh,
  );

  return (
    <div className="app">
      <h1>Privacy Pool Explorer</h1>
      <div className="subtitle">
        Chain: <code>{formatChainId(config.chainId)}</code> | Pool class: <code>{truncateAddress(config.poolClassHash)}</code>
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
        onAdd={addAccount}
      />
      <StatusBar status={status} />
      <div className="main-layout">
        <InfoPanel
          state={state}
          loading={loading}
          error={error}
          onRefresh={refresh}
        />
        <ActionPanel
          pending={status.pending}
          otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
          onMint={mint}
          onDeposit={deposit}
          onWithdraw={withdraw}
          onTransfer={transfer}
        />
      </div>
    </div>
  );
}
