export function formatAmount(value: number, maxDecimals = 6): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return value
    .toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
    .replace(/\.?0+$/, "");
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  const opts: Intl.NumberFormatOptions =
    value < 0.01
      ? { style: "currency", currency: "USD", maximumFractionDigits: 4 }
      : { style: "currency", currency: "USD", maximumFractionDigits: 2 };
  return value.toLocaleString("en-US", opts);
}

export function formatRelative(unixSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor((now / 1000) - unixSeconds));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
