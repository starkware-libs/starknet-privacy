import { useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { WhaleLogo } from "../components/WhaleLogo.tsx";
import type { ExtensionState } from "../wallet-extension/index.ts";

type Props = {
  isMainnet: boolean;
  chainLabel: string;
  onImport: (raw: string) => string | null;
  extensionState: ExtensionState;
  onConnectExtension: () => void;
};

export function Onboarding({
  isMainnet,
  chainLabel,
  onImport,
  extensionState,
  onConnectExtension,
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function onSave() {
    const result = onImport(text);
    if (result) setError(result);
  }

  return (
    <div className="splash">
      <div className="splash-card">
        <div className="splash-logo">
          <WhaleLogo fill />
        </div>
        <h1 className="splash-title">
          Welcome to <span className="brand-word">Veil</span>
        </h1>
        <p className="splash-slogan">For whales</p>
        <p className="splash-sub">
          Private balances and transfers on Starknet {chainLabel}.
        </p>

        <div className="splash-points">
          <Point icon={<Icon.Shield />} title="Shielded balances">
            Tokens you deposit are held inside the privacy pool. Senders, recipients
            and amounts are encrypted.
          </Point>
          <Point icon={<Icon.Send />} title="Private transfers">
            Move shielded tokens between accounts and trade peer-to-peer without
            leaking activity on chain.
          </Point>
          <Point icon={<Icon.Lock />} title="Your keys stay in your wallet">
            Argent X signs each transaction; this app never sees your private key.
            Your viewing key is derived once and stays local.
          </Point>
        </div>

        <button
          className="btn btn-primary btn-block"
          onClick={onConnectExtension}
          disabled={extensionState.kind === "connecting" || extensionState.kind === "deriving"}
        >
          {extensionState.kind === "connecting" ? (
            <>
              <span className="spinner" /> Connecting…
            </>
          ) : extensionState.kind === "deriving" ? (
            <>
              <span className="spinner" /> Sign in your wallet…
            </>
          ) : (
            <>
              <Icon.Wallet size={16} />
              Connect Argent X
            </>
          )}
        </button>

        {extensionState.kind === "error" && (
          <p
            className="splash-sub"
            style={{
              marginTop: 12,
              marginBottom: 0,
              color: "var(--danger)",
              fontSize: 12,
            }}
          >
            {extensionState.message}
          </p>
        )}

        <button
          type="button"
          className="btn btn-quiet btn-sm"
          style={{ marginTop: 14 }}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? "Hide advanced" : "Advanced: paste a key directly"}
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 14 }}>
            <div className="field">
              <label className="field-label">Import account JSON</label>
              <textarea
                className="field-textarea"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
                placeholder='[{"name":"Me","address":"0x...","privateKey":"0x..."}]'
                rows={5}
              />
              {error && <span className="field-error">{error}</span>}
            </div>

            <button className="btn btn-ghost btn-block" disabled={!text.trim()} onClick={onSave}>
              <Icon.Wallet size={16} />
              Import & unlock
            </button>
          </div>
        )}

        {isMainnet && (
          <p className="splash-sub" style={{ marginTop: 18, marginBottom: 0 }}>
            <strong style={{ color: "var(--warning)" }}>Mainnet</strong> — keys you paste stay
            in this tab only. They are not saved to localStorage and clear on reload. Use a
            throwaway account.
          </p>
        )}
      </div>
    </div>
  );
}

function Point({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="splash-point">
      <div className="splash-point-icon">{icon}</div>
      <div>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}
