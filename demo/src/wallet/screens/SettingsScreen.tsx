import { useState } from "react";
import type { AccountConfig, TokenConfig } from "../../config.ts";
import type { TokenBalance } from "../../hooks/usePrivateState.ts";
import { Icon } from "../components/Icon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import type { Contact } from "../contacts.ts";
import type { ExtensionState } from "../wallet-extension/index.ts";

type Props = {
  activeAccount: AccountConfig;
  accounts: AccountConfig[];
  chainLabel: string;
  poolAddress: string;
  isMainnet: boolean;

  ohttpEnabled: boolean;
  onToggleOhttp: (value: boolean) => void;

  paymasterAvailable: boolean;
  paymasterEnabled: boolean;
  onTogglePaymaster: (value: boolean) => void;
  paymasterTokens: TokenBalance[];
  tokens: TokenConfig[];
  paymasterFeeToken: string | undefined;
  onSelectFeeToken: (address: string) => void;

  deferredApplyEnabled: boolean;
  onToggleDeferredApply: (value: boolean) => void;

  onImportAccounts: (raw: string) => string | null;

  contacts: Contact[];
  onAddContact: (name: string, address: string) => string | null;
  onRemoveContact: (address: string) => void;
  onUpdateContact: (originalAddress: string, name: string, address: string) => string | null;

  extensionState: ExtensionState;
  onConnectExtension: () => void;
  onDisconnectExtension: () => void;
};

export function SettingsScreen({
  activeAccount,
  accounts,
  chainLabel,
  poolAddress,
  isMainnet,

  ohttpEnabled,
  onToggleOhttp,

  paymasterAvailable,
  paymasterEnabled,
  onTogglePaymaster,
  paymasterTokens,
  tokens,
  paymasterFeeToken,
  onSelectFeeToken,

  deferredApplyEnabled,
  onToggleDeferredApply,

  onImportAccounts,

  contacts,
  onAddContact,
  onRemoveContact,
  onUpdateContact,

  extensionState,
  onConnectExtension,
  onDisconnectExtension,
}: Props) {
  const [revealKey, setRevealKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => JSON.stringify(accounts, null, 2));
  const [editError, setEditError] = useState<string | null>(null);

  function onSaveAccounts() {
    const result = onImportAccounts(editText);
    if (result) {
      setEditError(result);
    } else {
      setEditError(null);
      setEditing(false);
    }
  }

  const paymasterTokensWithBalance = paymasterTokens.filter((tb) => tb.private > 0n);

  return (
    <>
      <div className="top-bar">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Network, privacy and account controls.</p>
        </div>
      </div>

      <div className="stack">
        <WalletExtensionCard
          state={extensionState}
          onConnect={onConnectExtension}
          onDisconnect={onDisconnectExtension}
        />

        <div className="card">
          <h3 className="card-title">Account</h3>
          <div className="stack">
            <Row label="Name" value={activeAccount.name} />
            <Row
              label="Address"
              value={activeAccount.address}
              copy
              mono
            />
            <Row
              label="Viewing key"
              value={
                revealKey
                  ? activeAccount.viewingKey ?? ""
                  : "•".repeat(Math.min(64, (activeAccount.viewingKey ?? "").length))
              }
              mono
              copy={revealKey}
              extra={
                <button
                  className="btn-quiet"
                  style={{ padding: 4, borderRadius: 6 }}
                  onClick={() => setRevealKey(!revealKey)}
                  title={revealKey ? "Hide" : "Reveal"}
                >
                  {revealKey ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
                </button>
              }
            />
            <Row
              label="Private key"
              value={
                activeAccount.privateKey
                  ? revealKey
                    ? activeAccount.privateKey
                    : "•".repeat(Math.min(64, activeAccount.privateKey.length))
                  : "—"
              }
              mono
              copy={revealKey && Boolean(activeAccount.privateKey)}
              dim={!activeAccount.privateKey}
            />
          </div>
        </div>

        <ContactsCard
          contacts={contacts}
          onAdd={onAddContact}
          onRemove={onRemoveContact}
          onUpdate={onUpdateContact}
        />

        <div className="card">
          <h3 className="card-title">Privacy</h3>

          <Toggle
            label="OHTTP relay"
            description={
              isMainnet
                ? "Mandatory on mainnet — protects discovery / proving traffic from passive correlation."
                : "Encrypt indexer and prover requests so the relay can't link your address to your queries."
            }
            checked={ohttpEnabled}
            onChange={onToggleOhttp}
            disabled={isMainnet}
            badges={isMainnet ? [{ label: "enforced", tone: "ok" }] : []}
          />

          <Toggle
            label="Deferred apply"
            description="Split each action into store + apply. Lets you build proofs separately and apply later — useful for OTC and stitched flows."
            checked={deferredApplyEnabled}
            onChange={onToggleDeferredApply}
            badges={[{ label: "2-step", tone: "default" }]}
          />

          {paymasterAvailable && (
            <Toggle
              label="Paymaster"
              description={
                deferredApplyEnabled
                  ? "Bypassed when deferred apply is on."
                  : paymasterTokensWithBalance.length === 0
                    ? "Needs a private balance to draw the fee from."
                    : "Sponsor your fee with a shielded token instead of public STRK."
              }
              checked={paymasterEnabled && paymasterTokensWithBalance.length > 0 && !deferredApplyEnabled}
              onChange={onTogglePaymaster}
              disabled={paymasterTokensWithBalance.length === 0 || deferredApplyEnabled}
              badges={deferredApplyEnabled ? [{ label: "bypassed", tone: "warn" }] : []}
            >
              {paymasterTokensWithBalance.length > 0 && (
                <select
                  className="field-select"
                  style={{ marginTop: 10, maxWidth: 200 }}
                  value={paymasterFeeToken ?? ""}
                  onChange={(event) => onSelectFeeToken(event.target.value)}
                  disabled={!paymasterEnabled || deferredApplyEnabled}
                >
                  {paymasterTokensWithBalance.map((tb) => {
                    const name = tokens.find((entry) => BigInt(entry.address) === BigInt(tb.address))?.name ?? "?";
                    return (
                      <option key={tb.address} value={tb.address}>
                        Pay fee in {name}
                      </option>
                    );
                  })}
                </select>
              )}
            </Toggle>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Network</h3>
          <Row label="Chain" value={chainLabel} />
          <Row label="Pool" value={poolAddress} mono copy />
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 14 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Accounts ({accounts.filter((entry) => !entry.admin).length})
            </h3>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(!editing)}>
              {editing ? "Cancel" : "Edit JSON"}
            </button>
          </div>

          {!editing && (
            <div className="stack">
              {accounts
                .filter((entry) => !entry.admin)
                .map((entry) => (
                  <div
                    key={entry.address}
                    className="row"
                    style={{
                      padding: "10px 12px",
                      background: "rgba(255,255,255,0.03)",
                      borderRadius: 12,
                    }}
                  >
                    <div className="acc-avatar" style={{ width: 32, height: 32 }}>
                      {entry.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{entry.name}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {entry.address.slice(0, 10)}…{entry.address.slice(-6)}
                      </div>
                    </div>
                    {!entry.privateKey && <span className="chip">view only</span>}
                  </div>
                ))}
            </div>
          )}

          {editing && (
            <>
              <textarea
                className="field-textarea"
                rows={8}
                value={editText}
                onChange={(event) => {
                  setEditText(event.target.value);
                  setEditError(null);
                }}
              />
              {editError && <div className="field-error" style={{ marginTop: 8 }}>{editError}</div>}
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: 10 }}
                onClick={onSaveAccounts}
              >
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  mono,
  copy,
  dim,
  extra,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
  dim?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
        {label}
      </span>
      <span
        className={mono ? "mono" : ""}
        style={{
          fontSize: 13,
          color: dim ? "var(--text-muted)" : "var(--text)",
          wordBreak: "break-all",
          textAlign: "right",
          maxWidth: 480,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {value}
        {extra}
        {copy && <CopyButton value={value} inline />}
      </span>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  badges,
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  badges?: { label: string; tone: "default" | "ok" | "warn" }[];
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "14px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
            {badges?.map((badge) => (
              <span
                key={badge.label}
                className={`chip ${badge.tone === "ok" ? "chip-ok" : badge.tone === "warn" ? "chip-warn" : ""}`}
              >
                {badge.label}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 520 }}>
            {description}
          </div>
          {children}
        </div>
        <Switch checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        flexShrink: 0,
        background: checked ? "var(--accent-grad)" : "rgba(255,255,255,0.08)",
        position: "relative",
        transition: "background 0.15s",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        boxShadow: checked ? "0 4px 14px -4px rgba(124, 92, 255, 0.6)" : "inset 0 0 0 1px var(--card-border)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.15s",
          boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
        }}
      />
    </button>
  );
}

function ContactsCard({
  contacts,
  onAdd,
  onRemove,
  onUpdate,
}: {
  contacts: Contact[];
  onAdd: (name: string, address: string) => string | null;
  onRemove: (address: string) => void;
  onUpdate: (originalAddress: string, name: string, address: string) => string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");

  function reset() {
    setName("");
    setAddress("");
    setError(null);
    setAdding(false);
  }

  function onSave() {
    const result = onAdd(name, address);
    if (result) {
      setError(result);
      return;
    }
    reset();
  }

  function startEdit(contact: Contact) {
    setEditingAddress(contact.address);
    setEditName(contact.name);
    setEditAddress(contact.address);
    setError(null);
  }

  function saveEdit() {
    if (!editingAddress) return;
    const result = onUpdate(editingAddress, editName, editAddress);
    if (result) {
      setError(result);
      return;
    }
    setEditingAddress(null);
    setError(null);
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 14 }}>
        <h3 className="card-title" style={{ margin: 0 }}>
          Contacts ({contacts.length})
        </h3>
        <div className="spacer" />
        {!adding && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
          >
            <Icon.Plus size={13} />
            Add contact
          </button>
        )}
      </div>

      {adding && (
        <div
          style={{
            marginBottom: 14,
            padding: 14,
            borderRadius: 12,
            background: "rgba(255,255,255,0.03)",
            display: "grid",
            gap: 10,
          }}
        >
          <input
            className="field-input"
            placeholder="Name (e.g. Bob)"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            autoFocus
          />
          <input
            className="field-input mono"
            style={{ fontSize: 13 }}
            placeholder="0x… address"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setError(null);
            }}
          />
          {error && <div className="field-error">{error}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-quiet btn-sm" onClick={reset}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onSave}
              disabled={!name.trim() || !address.trim()}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {contacts.length === 0 && !adding ? (
        <div className="empty">
          No contacts yet. Add one to send by name (e.g. "Bob") instead of pasting an address.
        </div>
      ) : (
        <div className="stack">
          {contacts.map((contact) => {
            const isEditing = editingAddress === contact.address;
            if (isEditing) {
              return (
                <div
                  key={contact.address}
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    background: "rgba(255,255,255,0.03)",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <input
                    className="field-input"
                    value={editName}
                    onChange={(event) => {
                      setEditName(event.target.value);
                      setError(null);
                    }}
                  />
                  <input
                    className="field-input mono"
                    style={{ fontSize: 13 }}
                    value={editAddress}
                    onChange={(event) => {
                      setEditAddress(event.target.value);
                      setError(null);
                    }}
                  />
                  {error && <div className="field-error">{error}</div>}
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-quiet btn-sm"
                      onClick={() => {
                        setEditingAddress(null);
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={saveEdit}>
                      Save
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={contact.address}
                className="row"
                style={{
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.03)",
                  borderRadius: 12,
                }}
              >
                <div className="acc-avatar" style={{ width: 32, height: 32 }}>
                  {contact.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{contact.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {contact.address.slice(0, 12)}…{contact.address.slice(-6)}
                  </div>
                </div>
                <CopyButton value={contact.address} inline />
                <button
                  className="btn-quiet"
                  onClick={() => startEdit(contact)}
                  style={{ padding: "4px 8px", borderRadius: 6, fontSize: 12 }}
                  title="Edit"
                >
                  Edit
                </button>
                <button
                  className="btn-quiet"
                  onClick={() => {
                    if (window.confirm(`Remove ${contact.name}?`)) {
                      onRemove(contact.address);
                    }
                  }}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    display: "inline-grid",
                    placeItems: "center",
                    color: "var(--text-muted)",
                  }}
                  title="Remove"
                >
                  <Icon.X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Top-of-Settings card surfacing the wallet-extension connect flow for users
// who already have a JSON-imported account (and so don't see the splash
// onboarding). Same connect logic; just lives in a persistent place.
function WalletExtensionCard({
  state,
  onConnect,
  onDisconnect,
}: {
  state: ExtensionState;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div
      className="card"
      style={{
        borderColor: state.kind === "ready"
          ? "rgba(52, 211, 153, 0.4)"
          : "rgba(124, 92, 255, 0.32)",
        background: state.kind === "ready"
          ? "rgba(52, 211, 153, 0.06)"
          : "var(--accent-grad-soft)",
      }}
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "var(--accent-grad)",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            flexShrink: 0,
          }}
        >
          <Icon.Wallet size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            Wallet extension
          </div>
          {state.kind === "ready" ? (
            <>
              <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
                Connected as <strong>{state.wallet.walletName}</strong>. Transactions
                are signed by the wallet and submitted by the Charlie relayer — your
                account isn't the on-chain caller.
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, marginTop: 6, color: "var(--text-muted)" }}
              >
                {state.wallet.address.slice(0, 12)}…{state.wallet.address.slice(-6)}
              </div>
            </>
          ) : state.kind === "connecting" ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              <span className="spinner" style={{ marginRight: 6 }} />
              Awaiting wallet connection…
            </div>
          ) : state.kind === "deriving" ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              <span className="spinner" style={{ marginRight: 6 }} />
              Sign the typed-data prompt in your wallet to derive the viewing key.
            </div>
          ) : state.kind === "error" ? (
            <div style={{ fontSize: 12, color: "var(--danger)" }}>{state.message}</div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Connect Argent X (Ready X) so this app never sees your private key.
              Signing happens inside the wallet; the on-chain caller is the relayer,
              not you.
            </div>
          )}
        </div>
        {state.kind === "ready" ? (
          <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={onConnect}
            disabled={state.kind === "connecting" || state.kind === "deriving"}
          >
            <Icon.Wallet size={14} />
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
