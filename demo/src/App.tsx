import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Account } from "starknet";
import { createEmptyRegistry } from "@starkware-libs/starknet-privacy-sdk";
import { formatChainId } from "./format.ts";
import {
  loadConfig,
  initPaymasterForwarder,
  initFeeConfig,
  type AccountConfig,
} from "./config.ts";
import { createProvider, createTransfers } from "./starknet.ts";
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
import { useLastTxBlockNumber } from "./hooks/useLastTxBlock.ts";
import { useServiceHealth } from "./hooks/useServiceHealth.ts";
import { DefiPanel } from "./components/DefiPanel.tsx";
import { isMainnet, isSendCapable, withViewingKey } from "./session.ts";
import "./App.css";

const config = loadConfig();
const isMainnetChain = isMainnet(config.chainId);

export function App() {
  const [classHash, setClassHash] = useState(config.poolClassHash);
  const [paymasterForwarderAddress, setPaymasterForwarderAddress] = useState<string | undefined>();
  const [feeAmount, setFeeAmount] = useState<bigint | undefined>();
  const [feeCollectorAddress, setFeeCollectorAddress] = useState<string | undefined>();

  useEffect(() => {
    void initPaymasterForwarder(config).then(() => {
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

  const [feeToken, setFeeToken] = useState<string | undefined>(() => {
    const stored = localStorage.getItem("paymasterFeeToken");
    return stored ?? config.paymasterFeeToken;
  });

  const selectFeeToken = useCallback((address: string) => {
    setFeeToken(address);
    localStorage.setItem("paymasterFeeToken", address);
  }, []);

  const isValidFeeToken = useCallback(
    (address: string | undefined, balances: { address: string; private: bigint }[]) => {
      if (!address) return false;
      const target = BigInt(address);
      return balances.some((tb) => BigInt(tb.address) === target && tb.private > 0n);
    },
    []
  );

  // OHTTP is mandatory on mainnet — without the relay layer a passive
  // observer of the discovery / proving backend correlates the viewer's
  // address with their encrypted notes, defeating the pool's privacy.
  // Testnet/devnet keep the toggle for debugging.
  const [ohttpEnabled, setOhttpEnabled] = useState(() => {
    if (isMainnetChain) return true;
    const stored = localStorage.getItem("ohttpEnabled");
    return stored !== null ? stored === "true" : true;
  });

  const toggleOhttp = useCallback((enabled: boolean) => {
    if (isMainnetChain) return;
    setOhttpEnabled(enabled);
    localStorage.setItem("ohttpEnabled", String(enabled));
  }, []);

  // On mainnet, accounts live in memory only — no localStorage, no URL
  // sharing. Reload clears state. Testnet persists for developer convenience.
  const {
    accounts: rawAccounts,
    activeIndex,
    activeAccount: rawActiveAccount,
    setActiveIndex,
    importAccounts,
  } = useAccounts(!isMainnetChain);

  const provider = useMemo(() => createProvider(config.rpcUrl), []);
  const sendCapable = isSendCapable(rawActiveAccount);

  useEffect(() => {
    void initFeeConfig(config, provider).then(() => {
      setFeeAmount(config.feeAmount);
      setFeeCollectorAddress(config.feeCollectorAddress);
    });
  }, [provider]);

  const {
    activeAddress: poolAddress,
    search,
    selectPool,
    addPool,
    searchPools,
    stopSearch,
    closeSearch,
  } = usePoolSelector(provider, config.poolAddress, classHash);

  // Fill in `viewingKey` deterministically from the account's private key
  // when it's absent (see `deriveViewingKey`). Depends on poolAddress, so
  // switching pools re-derives. Accounts that have neither a privateKey
  // nor a viewingKey are dropped as unusable.
  const accounts = useMemo(
    () =>
      rawAccounts
        .map((account) => withViewingKey(account, config.chainId, poolAddress))
        .filter((account): account is AccountConfig => account !== undefined),
    [rawAccounts, poolAddress]
  );
  const activeAccount = accounts[activeIndex];

  const configWithClassHash = useMemo(() => ({ ...config, poolClassHash: classHash }), [classHash]);

  const effectiveConfig = useMemo(
    () => ({
      ...config,
      paymasterFeeToken: feeToken,
      ...(paymasterEnabled ? {} : { paymasterUrl: undefined }),
      ohttpEnabled,
      paymasterForwarderAddress,
      feeAmount,
      feeCollectorAddress,
    }),
    [
      paymasterEnabled,
      ohttpEnabled,
      paymasterForwarderAddress,
      feeToken,
      feeAmount,
      feeCollectorAddress,
    ]
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

  const userAccount = useMemo(() => {
    if (!provider || !activeAccount?.privateKey) return undefined;
    return new Account({
      provider,
      address: activeAccount.address,
      signer: activeAccount.privateKey,
      cairoVersion: "1",
    });
  }, [provider, activeAccount]);

  const adminAccount = useMemo(() => {
    if (!provider || isMainnetChain) return undefined;
    const admin = accounts.find((a) => a.admin);
    if (!admin?.privateKey) return undefined;
    return new Account({
      provider,
      address: admin.address,
      signer: admin.privateKey,
      cairoVersion: "1",
    });
  }, [provider, accounts]);

  const transfers = useMemo(() => {
    if (!userAccount || !activeAccount?.viewingKey) return undefined;
    return createTransfers(
      provider,
      userAccount,
      BigInt(activeAccount.viewingKey),
      poolAddress,
      effectiveConfig
    );
  }, [provider, userAccount, activeAccount, poolAddress, effectiveConfig]);

  const registry = useRef(createEmptyRegistry());

  useEffect(() => {
    const reg = registry.current;
    reg.cursor = undefined;
    reg.channels = createEmptyRegistry().channels;
    reg.notes = createEmptyRegistry().notes;
  }, [activeAccount, poolAddress]);

  const { state, loading, error, refresh, refreshBalances } = usePrivateState(
    provider,
    activeAccount,
    accounts,
    poolAddress,
    effectiveConfig,
    registry.current
  );

  useEffect(() => {
    if (isValidFeeToken(feeToken, state.tokenBalances)) return;
    const firstWithBalance = state.tokenBalances.find((tb) => tb.private > 0n);
    if (firstWithBalance) selectFeeToken(firstWithBalance.address);
  }, [feeToken, state.tokenBalances, isValidFeeToken, selectFeeToken]);

  // Paymaster requires a private note to pay the fee from. If the account has
  // no private balance, drop paymasterUrl so transactions fall back to normal
  // signing instead of failing in the fee-withdraw step.
  const txConfig = useMemo(() => {
    const hasPrivateBalance = state.tokenBalances.some((tb) => tb.private > 0n);
    if (hasPrivateBalance) return effectiveConfig;
    return { ...effectiveConfig, paymasterUrl: undefined };
  }, [effectiveConfig, state.tokenBalances]);

  const {
    transactions: historyTransactions,
    loading: historyLoading,
    error: historyError,
    historyComplete,
    fetchMore: fetchHistory,
    refreshLatest: refreshHistoryLatest,
  } = useHistory(provider, poolAddress, effectiveConfig, activeAccount, accounts, registry.current);

  const { lastTxBlockNumberRef, updateLastTxBlockNumber } = useLastTxBlockNumber(
    activeAccount?.address,
    historyTransactions
  );

  const refreshAll = useCallback(async () => {
    const reg = registry.current;
    reg.cursor = undefined;
    reg.channels = createEmptyRegistry().channels;
    reg.notes = createEmptyRegistry().notes;
    await refresh();
    void refreshHistoryLatest();
  }, [refresh, refreshHistoryLatest]);

  useEffect(() => {
    const reg = registry.current;
    reg.cursor = undefined;
    reg.channels = createEmptyRegistry().channels;
    reg.notes = createEmptyRegistry().notes;
    void refresh();
  }, [refresh]);

  const {
    status,
    register,
    mint,
    deposit,
    withdraw,
    transfer,
    swap,
    avnuSwap,
    vesuSupply,
    vesuWithdraw,
  } = useTransactions(
      provider,
      transfers,
      userAccount,
      adminAccount,
      activeAccount?.address,
      poolAddress,
      txConfig,
      refreshAll,
      refreshBalances,
      lastTxBlockNumberRef,
      updateLastTxBlockNumber
    );

  const { status: builderStatus, executeBatch } = useTransactionBuilder(
    provider,
    transfers,
    userAccount,
    activeAccount?.address,
    poolAddress,
    txConfig,
    refreshAll,
    lastTxBlockNumberRef,
    updateLastTxBlockNumber
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
      {isMainnetChain && (
        <div
          style={{
            background: "#7a1e1e",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 4,
            margin: "8px 0",
            fontWeight: 600,
          }}
        >
          MAINNET — real funds. Keys you paste stay in this tab only (not saved, not shared, cleared
          on reload). Use a throwaway account for testing. For read-only access, paste JSON without
          a <code>privateKey</code> field.
        </div>
      )}
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
                  sendCapable={sendCapable}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  tokens={config.tokens}
                  tokenBalances={state.tokenBalances}
                  onRegister={register}
                  onMint={isMainnetChain ? undefined : mint}
                  onDeposit={deposit}
                  onWithdraw={withdraw}
                  onTransfer={transfer}
                />
              )}
              {activeView === "builder" && (
                <TransactionBuilder
                  pending={builderStatus.pending}
                  sendCapable={sendCapable}
                  activeAddress={activeAccount.address}
                  otherAccounts={accounts.filter((_, index) => index !== activeIndex)}
                  tokens={config.tokens}
                  tokenBalances={state.tokenBalances}
                  onExecute={executeBatch}
                />
              )}
              {activeView === "defi" && (
                <DefiPanel
                  pending={status.pending}
                  pendingAction={status.action}
                  sendCapable={sendCapable}
                  tokens={config.tokens}
                  tokenBalances={state.tokenBalances}
                  swapTokens={config.ekubo?.swapTokens}
                  provider={provider}
                  ekubo={config.ekubo}
                  vesu={config.vesu}
                  paymasterAvailable={Boolean(txConfig.paymasterUrl)}
                  onSwap={swap}
                  onAvnuSwap={avnuSwap}
                  onVesuSupply={vesuSupply}
                  onVesuWithdraw={vesuWithdraw}
                />
              )}
              <div className="config-island">
                <h3>Config</h3>
                <label
                  className="builder-checkbox"
                  title={isMainnetChain ? "OHTTP is enforced on mainnet" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={ohttpEnabled}
                    onChange={(e) => toggleOhttp(e.target.checked)}
                    disabled={isMainnetChain}
                  />
                  OHTTP
                  {config.backendIndexerUrl && <span className="chip">relay</span>}
                  {isMainnetChain && <span className="chip">enforced</span>}
                </label>
                {config.paymasterUrl && (() => {
                  const tokensWithBalance = state.tokenBalances.filter((tb) => tb.private > 0n);
                  const hasPrivateBalance = tokensWithBalance.length > 0;
                  return (
                    <label className="builder-checkbox">
                      <input
                        type="checkbox"
                        checked={paymasterEnabled && hasPrivateBalance}
                        onChange={(e) => togglePaymaster(e.target.checked)}
                        disabled={!hasPrivateBalance}
                      />
                      Paymaster
                      {hasPrivateBalance ? (
                        <select
                          value={feeToken ?? ""}
                          onChange={(e) => selectFeeToken(e.target.value)}
                          disabled={!paymasterEnabled}
                        >
                          {tokensWithBalance.map((tb) => {
                            const name =
                              config.tokens.find((t) => BigInt(t.address) === BigInt(tb.address))
                                ?.name ?? "?";
                            return (
                              <option key={tb.address} value={tb.address}>
                                {name}
                              </option>
                            );
                          })}
                        </select>
                      ) : (
                        <span className="chip">no private balance</span>
                      )}
                    </label>
                  );
                })()}
              </div>
            </div>
          </div>
        </>
      )}
      <footer className="app-footer">
        Built by Starkware &middot; Docs{" "}
        <a
          href="https://github.com/starkware-libs/starknet-privacy"
          target="_blank"
          rel="noreferrer"
        >
          github.com/starkware-libs/starknet-privacy
        </a>
      </footer>
    </div>
  );
}
