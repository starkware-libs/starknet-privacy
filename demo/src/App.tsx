import { useEffect, useMemo } from "react";
import { formatChainId, truncateAddress } from "./format.ts";
import { loadConfig } from "./config.ts";
import { createProvider, createAccount, createTransfers } from "./starknet.ts";
import { useAccounts } from "./hooks/useAccounts.ts";
import { usePrivateState } from "./hooks/usePrivateState.ts";
import { useTransactions } from "./hooks/useTransactions.ts";
import { AccountSelector } from "./components/AccountSelector.tsx";
import { InfoPanel } from "./components/InfoPanel.tsx";
import { ActionPanel } from "./components/ActionPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import "./App.css";

const config = loadConfig();

export function App() {
  const { accounts, activeIndex, activeAccount, setActiveIndex, addAccount } =
    useAccounts(config.accounts);

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  const account = useMemo(() => {
    if (!activeAccount) return undefined;
    return createAccount(provider, activeAccount.address, activeAccount.privateKey);
  }, [provider, activeAccount]);

  const transfers = useMemo(() => {
    if (!account || !activeAccount) return undefined;
    return createTransfers(provider, account, activeAccount, config);
  }, [provider, account, activeAccount]);

  const { state, loading, error, refresh } = usePrivateState(
    provider,
    transfers,
    activeAccount,
    config,
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const { status, mint, deposit, withdraw, transfer } = useTransactions(
    provider,
    transfers,
    activeAccount?.address,
    config,
    refresh,
  );

  return (
    <div className="app">
      <h1>Privacy Pool Explorer</h1>
      <div className="subtitle">
        Chain: <code>{formatChainId(config.chainId)}</code> | Pool: <code>{truncateAddress(config.poolAddress)}</code>
      </div>
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
          otherAccounts={accounts.filter((_, i) => i !== activeIndex)}
          onMint={mint}
          onDeposit={deposit}
          onWithdraw={withdraw}
          onTransfer={transfer}
        />
      </div>
    </div>
  );
}
