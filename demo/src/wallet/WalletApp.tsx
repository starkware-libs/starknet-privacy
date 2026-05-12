import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Account } from "starknet";
import { createEmptyRegistry } from "starknet-sdk";
import {
  loadConfig,
  initPaymasterForwarder,
  initFeeConfig,
  type AccountConfig,
} from "../config.ts";
import { createProvider, createTransfers } from "../starknet.ts";
import { useAccounts } from "../hooks/useAccounts.ts";
import { usePrivateState } from "../hooks/usePrivateState.ts";
import { useHistory } from "../hooks/useHistory.ts";
import { useTransactions } from "../hooks/useTransactions.ts";
import { useTransactionBuilder } from "../hooks/useTransactionBuilder.ts";
import { usePendingStored } from "../hooks/usePendingStored.ts";
import { useLastTxBlockNumber } from "../hooks/useLastTxBlock.ts";
import { useServiceHealth } from "../hooks/useServiceHealth.ts";
import { isMainnet, isSendCapable, withViewingKey } from "../session.ts";
import { formatChainId } from "../format.ts";

import { Icon } from "./components/Icon.tsx";
import { WhaleLogo } from "./components/WhaleLogo.tsx";
import { Onboarding } from "./screens/Onboarding.tsx";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { SendModal } from "./screens/SendModal.tsx";
import { ReceiveModal } from "./screens/ReceiveModal.tsx";
import { DepositModal } from "./screens/DepositModal.tsx";
import { WithdrawModal } from "./screens/WithdrawModal.tsx";
import { ActivityScreen } from "./screens/ActivityScreen.tsx";
import { AuditScreen } from "./screens/AuditScreen.tsx";
import { OtcModal } from "./screens/OtcModal.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { Toast } from "./screens/Toast.tsx";
import { useStoredBool, useStoredString } from "./state.ts";
import { useContacts } from "./contacts.ts";
import { useAutoRefresh } from "./useAutoRefresh.ts";
import {
  ExtensionAccount,
  createRelayerAccount,
  useExtensionWallet,
} from "./wallet-extension/index.ts";

// Polling cadence for the background discovery sweep. 20s balances "see new
// notes from friends within the same minute" against OHTTP/proving relay
// cost. The post-tx refresh in useTransactions.onSettled is separate and
// always fires; this only catches passive incoming notes.
const AUTO_REFRESH_MS = 20_000;

const config = loadConfig();
const isMainnetChain = isMainnet(config.chainId);

export type WalletView = "home" | "activity" | "audit" | "settings";
export type WalletAction =
  | { kind: "send" }
  | { kind: "receive" }
  | { kind: "deposit" }
  | { kind: "withdraw" }
  | { kind: "otc" }
  | null;

export function WalletApp() {
  const [paymasterForwarderAddress, setPaymasterForwarderAddress] = useState<string | undefined>();
  const [feeAmount, setFeeAmount] = useState<bigint | undefined>();
  const [feeCollectorAddress, setFeeCollectorAddress] = useState<string | undefined>();

  useEffect(() => {
    void initPaymasterForwarder(config).then(() => {
      setPaymasterForwarderAddress(config.paymasterForwarderAddress);
    });
  }, []);

  const [paymasterEnabled, setPaymasterEnabled] = useStoredBool("paymaster", true);
  const [feeToken, setFeeToken] = useStoredString("feeToken", config.paymasterFeeToken);
  const [ohttpEnabled, setOhttpEnabledRaw] = useStoredBool("ohttp", true);
  const ohttpEffective = isMainnetChain ? true : ohttpEnabled;
  const setOhttpEnabled = isMainnetChain ? () => {} : setOhttpEnabledRaw;
  const [deferredApplyEnabled, setDeferredApplyEnabled] = useStoredBool("deferredApply", false);
  const [balancesHidden, setBalancesHidden] = useStoredBool("balancesHidden", false);

  // Persist accounts off-chain like the original demo; mainnet stays in
  // memory to avoid leaking signing keys across reloads.
  const {
    accounts: rawAccounts,
    activeIndex,
    setActiveIndex,
    importAccounts,
  } = useAccounts(!isMainnetChain);

  const provider = useMemo(() => createProvider(config.rpcUrl), []);

  useEffect(() => {
    void initFeeConfig(config, provider).then(() => {
      setFeeAmount(config.feeAmount);
      setFeeCollectorAddress(config.feeCollectorAddress);
    });
  }, [provider]);

  const poolAddress = config.poolAddress;

  // viewing-key fill-in identical to App.tsx — drives a usable account list.
  const accounts = useMemo(
    () =>
      rawAccounts
        .map((account) => withViewingKey(account, config.chainId, poolAddress))
        .filter((account): account is AccountConfig => account !== undefined),
    [rawAccounts, poolAddress]
  );

  // Wallet-extension state. When connected + viewing-key derived, we inject
  // a synthetic AccountConfig at index -1 (rendered as the active account).
  // Existing JSON-imported accounts are unaffected — they remain in `accounts`
  // and can still be the active account when no extension is connected.
  const ext = useExtensionWallet(poolAddress);

  // CRITICAL: the synthetic AccountConfig MUST be memoized. Without this it
  // gets a fresh object reference on every render, which cascades through
  // `activeAccount` → `userAccount` → `transfers` → the discovery refresh
  // callback's identity → the `useEffect` that invokes refresh. Each auto-
  // refresh tick already re-renders this component (via lastRefreshAt), so
  // a non-memoized config would cause every tick to fire a *fresh* discovery
  // sweep, exhausting browser sockets with OHTTP key fetches.
  const extensionAccountConfig = useMemo<AccountConfig | undefined>(() => {
    if (ext.state.kind !== "ready") return undefined;
    return {
      name: shortenWalletLabel(ext.state.wallet.walletName, ext.state.wallet.address),
      address: ext.state.wallet.address,
      viewingKey: "0x" + ext.state.viewingKey.toString(16),
    };
  }, [ext.state]);

  // If an extension is connected, it takes priority over JSON-imported
  // accounts. Otherwise fall back to the existing active-index logic.
  const activeAccount = useMemo<AccountConfig | undefined>(
    () => extensionAccountConfig ?? accounts[activeIndex],
    [extensionAccountConfig, accounts, activeIndex]
  );
  // An extension-connected account is send-capable even without a privateKey
  // on the AccountConfig — signing goes through the wallet.
  const sendCapable = ext.state.kind === "ready" || isSendCapable(activeAccount);

  const effectiveConfig = useMemo(
    () => ({
      ...config,
      paymasterFeeToken: feeToken,
      ...(paymasterEnabled ? {} : { paymasterUrl: undefined }),
      ohttpEnabled: ohttpEffective,
      paymasterForwarderAddress,
      feeAmount,
      feeCollectorAddress,
    }),
    [
      paymasterEnabled,
      ohttpEffective,
      paymasterForwarderAddress,
      feeToken,
      feeAmount,
      feeCollectorAddress,
    ]
  );

  // Address + privateKey extracted up-front so this useMemo's deps are
  // primitive scalars (not the AccountConfig object whose ref might churn).
  // Same for the wallet-ext branch — depend on `ext.state` (stable per
  // useState transition), not on a derived object.
  const userAddress = activeAccount?.address;
  const userPrivateKey = activeAccount?.privateKey;
  const userAccount = useMemo(() => {
    if (!provider) return undefined;
    // Wallet-extension path: sign via the wallet, submit via Charlie. The
    // ExtensionAccount is API-compatible with starknet.js's Account, so all
    // downstream code (SDK, OTC service, modals) treats it identically.
    if (ext.state.kind === "ready") {
      const relayer = createRelayerAccount(provider);
      return new ExtensionAccount(
        provider,
        ext.state.wallet.address,
        ext.state.wallet,
        relayer,
        ext.state.proofPrivateKey
      );
    }
    // JSON-imported private-key path — unchanged.
    if (!userAddress || !userPrivateKey) return undefined;
    return new Account({
      provider,
      address: userAddress,
      signer: userPrivateKey,
      cairoVersion: "1",
    });
  }, [provider, userAddress, userPrivateKey, ext.state]);

  const adminAccount = useMemo(() => {
    if (!provider || isMainnetChain) return undefined;
    const admin = accounts.find((entry) => entry.admin);
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
    const isValid = (address: string | undefined) => {
      if (!address) return false;
      const target = BigInt(address);
      return state.tokenBalances.some(
        (tb) => BigInt(tb.address) === target && tb.private > 0n
      );
    };
    if (isValid(feeToken)) return;
    const firstWithBalance = state.tokenBalances.find((tb) => tb.private > 0n);
    if (firstWithBalance) setFeeToken(firstWithBalance.address);
  }, [feeToken, state.tokenBalances, setFeeToken]);

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
    entries: pendingStored,
    add: addPendingStored,
    remove: removePendingStored,
  } = usePendingStored();

  const {
    status,
    register,
    mint,
    deposit,
    withdraw,
    transfer,
    applyStored,
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
    updateLastTxBlockNumber,
    deferredApplyEnabled,
    addPendingStored,
    removePendingStored
  );

  // builder isn't surfaced as a UI tab in the wallet — but we keep the hook
  // active because useTransactionBuilder internally wires shared timeline
  // state. Calling it pulls in the helper without exposing a tab.
  useTransactionBuilder(
    provider,
    transfers,
    userAccount,
    activeAccount?.address,
    poolAddress,
    txConfig,
    refreshAll,
    lastTxBlockNumberRef,
    updateLastTxBlockNumber,
    deferredApplyEnabled,
    addPendingStored
  );

  const serviceHealth = useServiceHealth(provider, effectiveConfig);
  const contactsStore = useContacts();

  const { lastRefreshAt } = useAutoRefresh({
    intervalMs: AUTO_REFRESH_MS,
    paused: status.pending || !activeAccount?.viewingKey,
    refresh: refreshAll,
  });

  const [view, setView] = useState<WalletView>("home");
  const [action, setAction] = useState<WalletAction>(null);

  // Modal lifecycle is now owned by each action modal: they show their own
  // success view after a tx settles and the user clicks "Done" to close.
  // That replaces the previous auto-close-on-success behavior, which
  // dismissed the modal before the user had a chance to see what happened.

  // Onboarding shows until *either* an extension is connected with a viewing
  // key derived OR the user has pasted a JSON account. Connecting / deriving
  // states still render the splash so the spinner is visible.
  if (!activeAccount) {
    return (
      <Onboarding
        isMainnet={isMainnetChain}
        chainLabel={formatChainId(config.chainId)}
        onImport={importAccounts}
        extensionState={ext.state}
        onConnectExtension={() => void ext.connect()}
      />
    );
  }
  // From here, TS narrows `activeAccount` to `AccountConfig` via the guard
  // above — no re-bind needed.

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <WhaleLogo fill />
          </div>
          <div className="brand-text">
            <span className="brand-text-name">Veil</span>
            <span className="brand-text-tag">For whales</span>
          </div>
        </div>
        <nav className="nav">
          <NavButton
            label="Home"
            icon={<Icon.Home />}
            active={view === "home"}
            onClick={() => setView("home")}
          />
          <NavButton
            label="Activity"
            icon={<Icon.Activity />}
            active={view === "activity"}
            onClick={() => setView("activity")}
          />
          {activeAccount.viewingKey && (
            <NavButton
              label="Audit"
              icon={<Icon.Shield />}
              active={view === "audit"}
              onClick={() => setView("audit")}
            />
          )}
          <NavButton
            label="Settings"
            icon={<Icon.Settings />}
            active={view === "settings"}
            onClick={() => setView("settings")}
          />
        </nav>
        <div className="sidebar-foot">
          <HealthBar health={serviceHealth} />
          <div>
            <span className="muted">Network</span>{" "}
            <span className="dim">{formatChainId(config.chainId)}</span>
          </div>
          <div>
            <span className="muted">Pool</span>{" "}
            <span className="mono dim">{shortAddr(poolAddress)}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {view === "home" && (
          <HomeScreen
            activeAccount={activeAccount}
            accounts={accounts}
            activeIndex={activeIndex}
            onSelectAccount={setActiveIndex}
            onOpenImport={() => {
              const raw = window.prompt(
                "Paste a JSON array of accounts (name, address, privateKey, viewingKey?)"
              );
              if (raw) importAccounts(raw);
            }}
            state={state}
            tokens={config.tokens}
            loading={loading}
            error={error}
            onRefresh={refreshAll}
            lastRefreshAt={lastRefreshAt}
            sendCapable={sendCapable}
            isMainnet={isMainnetChain}
            balancesHidden={balancesHidden}
            onToggleHidden={() => setBalancesHidden(!balancesHidden)}
            pendingStored={pendingStored.filter(
              (entry) => BigInt(entry.ownerAddress) === BigInt(activeAccount.address)
            )}
            onApplyStored={applyStored}
            onDiscardStored={removePendingStored}
            status={status}
            onRegister={register}
            onMint={isMainnetChain ? undefined : mint}
            explorerUrl={config.explorerUrl}
            otcAvailable={Boolean(config.otcExecutorAddress)}
            historyTransactions={historyTransactions}
            onAction={setAction}
          />
        )}
        {view === "activity" && (
          <ActivityScreen
            transactions={historyTransactions}
            explorerUrl={config.explorerUrl}
            loading={historyLoading}
            error={historyError}
            historyComplete={historyComplete}
            onFetchMore={fetchHistory}
          />
        )}
        {view === "audit" && (
          <AuditScreen
            provider={provider}
            activeAccount={activeAccount}
            accounts={accounts}
            contacts={contactsStore.contacts}
            poolAddress={poolAddress}
            otcExecutorAddress={config.otcExecutorAddress}
            tokens={config.tokens}
            config={effectiveConfig}
            explorerUrl={config.explorerUrl}
          />
        )}
        {view === "settings" && (
          <SettingsScreen
            activeAccount={activeAccount}
            accounts={accounts}
            chainLabel={formatChainId(config.chainId)}
            poolAddress={poolAddress}
            isMainnet={isMainnetChain}
            ohttpEnabled={ohttpEffective}
            onToggleOhttp={setOhttpEnabled}
            paymasterAvailable={Boolean(config.paymasterUrl)}
            paymasterEnabled={paymasterEnabled}
            onTogglePaymaster={setPaymasterEnabled}
            paymasterTokens={state.tokenBalances}
            tokens={config.tokens}
            paymasterFeeToken={feeToken}
            onSelectFeeToken={(address) => setFeeToken(address)}
            deferredApplyEnabled={deferredApplyEnabled}
            onToggleDeferredApply={setDeferredApplyEnabled}
            onImportAccounts={importAccounts}
            contacts={contactsStore.contacts}
            onAddContact={contactsStore.add}
            onRemoveContact={contactsStore.remove}
            onUpdateContact={contactsStore.update}
            extensionState={ext.state}
            onConnectExtension={() => void ext.connect()}
            onDisconnectExtension={() => void ext.disconnect()}
          />
        )}
      </main>

      {action?.kind === "send" && (
        <SendModal
          open
          onClose={() => setAction(null)}
          activeAccount={activeAccount}
          accounts={accounts.filter((_, index) => index !== activeIndex)}
          contacts={contactsStore.contacts}
          tokens={config.tokens}
          balances={state.tokenBalances}
          status={status}
          explorerUrl={config.explorerUrl}
          onTransfer={transfer}
        />
      )}
      {action?.kind === "receive" && (
        <ReceiveModal
          open
          onClose={() => setAction(null)}
          account={activeAccount}
          chainLabel={formatChainId(config.chainId)}
        />
      )}
      {action?.kind === "deposit" && (
        <DepositModal
          open
          onClose={() => setAction(null)}
          tokens={config.tokens}
          balances={state.tokenBalances}
          status={status}
          explorerUrl={config.explorerUrl}
          onDeposit={deposit}
        />
      )}
      {action?.kind === "otc" && config.otcExecutorAddress && (
        <OtcModal
          open
          onClose={() => setAction(null)}
          account={userAccount}
          provider={provider}
          viewingKey={
            activeAccount.viewingKey ? BigInt(activeAccount.viewingKey) : undefined
          }
          poolAddress={poolAddress}
          otcExecutorAddress={config.otcExecutorAddress}
          proverUrl={config.provingServiceUrl}
          indexerUrl={config.indexerUrl}
          tokens={config.tokens}
          accounts={accounts}
          contacts={contactsStore.contacts}
          activeAccount={activeAccount}
          explorerUrl={config.explorerUrl}
        />
      )}
      {action?.kind === "withdraw" && (
        <WithdrawModal
          open
          onClose={() => setAction(null)}
          tokens={config.tokens}
          balances={state.tokenBalances}
          status={status}
          explorerUrl={config.explorerUrl}
          onWithdraw={withdraw}
        />
      )}

      <Toast status={status} explorerUrl={config.explorerUrl} />
    </div>
  );
}

function NavButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      {label}
    </button>
  );
}

function HealthBar({
  health,
}: {
  health: ReturnType<typeof useServiceHealth>;
}) {
  const subsystems: { label: string; status: string }[] = [
    { label: "RPC", status: health.rpc.status },
    { label: "Discovery", status: health.discovery.status },
  ];
  if (health.proving) subsystems.push({ label: "Prover", status: health.proving.status });
  const cls = (status: string) =>
    status === "healthy" ? "ok" : status === "unhealthy" ? "fail" : status === "checking" ? "warn" : "";
  return (
    <div>
      {subsystems.map((entry) => (
        <span key={entry.label} title={`${entry.label}: ${entry.status}`}>
          <span className={`health-dot ${cls(entry.status)}`} />
          {entry.label}{" "}
        </span>
      ))}
    </div>
  );
}

function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

function shortenWalletLabel(walletName: string, address: string): string {
  const tail = address.slice(-4);
  return `${walletName} · …${tail}`;
}
