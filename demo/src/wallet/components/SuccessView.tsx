import { CopyButton } from "./CopyButton.tsx";

// Shared success surface used by every action modal. The animation lives in
// styles.css under `.success-check-*` — circle draws first, then the tick.
// Callers control the headline, the subtitle, and what happens on "Done".

type Props = {
  title: string;
  /** A short line of context — usually the amount + recipient / asset summary. */
  subtitle?: string;
  txHash: string;
  explorerUrl?: string;
  onDone: () => void;
};

export function SuccessView({ title, subtitle, txHash, explorerUrl, onDone }: Props) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: "8px 4px",
      }}
    >
      <SuccessCheck />
      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: subtitle ? 6 : 0 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.45 }}>{subtitle}</div>
        )}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          wordBreak: "break-all",
          textAlign: "center",
        }}
      >
        {txHash.slice(0, 14)}…{txHash.slice(-10)}
        <CopyButton value={txHash} inline />
      </div>
      <div className="row" style={{ gap: 8 }}>
        {explorerUrl && (
          <a
            className="btn btn-ghost btn-sm"
            href={`${explorerUrl.replace(/\/$/, "")}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View on explorer ↗
          </a>
        )}
        <button className="btn btn-primary btn-sm" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function SuccessCheck() {
  return (
    <div className="success-check-wrap">
      <svg className="success-check" width={72} height={72} viewBox="0 0 72 72" aria-hidden>
        <circle className="success-check-circle" cx={36} cy={36} r={32} />
        <path className="success-check-tick" d="M22 37 l10 10 l18 -22" />
      </svg>
    </div>
  );
}
