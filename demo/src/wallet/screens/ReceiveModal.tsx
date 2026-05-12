import type { AccountConfig } from "../../config.ts";
import { Modal } from "../components/Modal.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { Icon } from "../components/Icon.tsx";

type Props = {
  open: boolean;
  onClose: () => void;
  account: AccountConfig;
  chainLabel: string;
};

export function ReceiveModal({ open, onClose, account, chainLabel }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="Receive privately">
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <QrCode value={account.address} size={196} />

        <div style={{ width: "100%" }}>
          <div className="field-label">Your address</div>
          <div
            className="mono"
            style={{
              padding: "12px 14px",
              background: "rgba(0,0,0,0.25)",
              border: "1px solid var(--card-border)",
              borderRadius: 12,
              fontSize: 12,
              wordBreak: "break-all",
              marginTop: 6,
              marginBottom: 8,
            }}
          >
            {account.address}
          </div>
          <div className="row" style={{ justifyContent: "center", gap: 8 }}>
            <CopyButton value={account.address} label="Copy address" />
          </div>
        </div>

        <div
          style={{
            background: "var(--accent-grad-soft)",
            borderRadius: 12,
            padding: 14,
            fontSize: 12,
            color: "var(--text-dim)",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            width: "100%",
          }}
        >
          <Icon.Shield size={14} />
          <div>
            Anyone with this address on <strong>{chainLabel}</strong> can send you
            shielded tokens. The sender, recipient, and amount stay encrypted on chain.
            They never see your balance — and you never see theirs.
          </div>
        </div>
      </div>
    </Modal>
  );
}
