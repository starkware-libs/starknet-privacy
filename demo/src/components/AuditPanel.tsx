import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account, RpcProvider } from "starknet";
import type { AppConfig, TokenConfig } from "../config.ts";
import {
  reconstructAuditTrail,
  verifyAsOtc,
  type AuditEntry,
  type OtcVerification,
} from "../audit/reconstruct.ts";

type Props = {
  account: Account | undefined;
  provider: RpcProvider | undefined;
  viewingKey: bigint | undefined;
  config: AppConfig;
};

type RowState =
  | { kind: "unverified" }
  | { kind: "verifying" }
  | { kind: "verified"; result: OtcVerification | undefined }
  | { kind: "error"; message: string };

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function shortenHex(value: string, head: number = 6, tail: number = 4): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}

function formatAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const factor = 10n ** BigInt(decimals);
  const whole = amount / factor;
  const frac = amount % factor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export function AuditPanel({ account, provider, viewingKey, config }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [rowStates, setRowStates] = useState<Map<string, RowState>>(new Map());
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const tokenInfoByAddress = useMemo(() => {
    const map = new Map<string, TokenConfig>();
    for (const t of config.tokens) map.set(BigInt(t.address).toString(16), t);
    return map;
  }, [config.tokens]);

  const ready = Boolean(account && provider && viewingKey);

  const loadTrail = useCallback(async () => {
    if (!account || !provider || viewingKey === undefined) return;
    setStatus({ kind: "loading" });
    try {
      const trail = await reconstructAuditTrail({
        account,
        provider,
        viewingKey,
        proverUrl: config.provingServiceUrl ?? "",
        discoveryUrl: config.indexerUrl,
        poolAddress: config.poolAddress,
        otcExecutorAddress: config.otcExecutorAddress ?? "",
        chainId: config.chainId,
      });
      setEntries(trail);
      setRowStates(new Map());
      setStatus({ kind: "ready" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [account, provider, viewingKey, config]);

  // Auto-load once the panel has everything it needs.
  useEffect(() => {
    if (ready && status.kind === "idle") {
      void loadTrail();
    }
  }, [ready, status.kind, loadTrail]);

  async function verifyRow(entry: AuditEntry): Promise<void> {
    if (!provider || !config.otcExecutorAddress) return;
    setRowStates((prev) => new Map(prev).set(entry.noteId, { kind: "verifying" }));
    try {
      const result = await verifyAsOtc(
        provider,
        config.poolAddress,
        config.otcExecutorAddress,
        entry.noteId,
      );
      setRowStates((prev) =>
        new Map(prev).set(entry.noteId, { kind: "verified", result }),
      );
    } catch (err) {
      setRowStates((prev) =>
        new Map(prev).set(entry.noteId, {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  function exportJson(): void {
    const payload = entries.map((entry) => {
      const tokenInfo = tokenInfoByAddress.get(BigInt(entry.token).toString(16));
      const verification = rowStates.get(entry.noteId);
      const isOtc =
        verification?.kind === "verified" ? verification.result?.isOtc : undefined;
      const txHash =
        verification?.kind === "verified" ? verification.result?.txHash : undefined;
      const tradeId =
        verification?.kind === "verified" ? verification.result?.tradeId : undefined;
      return {
        token_address: entry.token,
        token_name: tokenInfo?.name ?? null,
        decimals: tokenInfo?.decimals ?? null,
        amount_raw: entry.amount.toString(),
        amount_human:
          tokenInfo !== undefined
            ? formatAmount(entry.amount, tokenInfo.decimals)
            : null,
        sender: entry.sender,
        salt_hex: "0x" + entry.salt.toString(16),
        note_id: entry.noteId,
        block_number: entry.blockNumber ?? null,
        on_chain_verified_otc: isOtc ?? null,
        settlement_tx: txHash ?? null,
        trade_id_from_tx: tradeId ?? null,
      };
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `privacy-audit-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="action-form">
      <h2>Audit Trail</h2>
      <p className="pending-stored-hint">
        Reconstructed live from on-chain data using your viewing key — nothing is
        read from local storage. Each row is a note you received. Click{" "}
        <em>Verify</em> on a row to fetch its creating tx and confirm it was an
        OTC settlement (recovers the trade_id from the join_trade calldata).
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className="pool-action-button"
          onClick={() => void loadTrail()}
          disabled={!ready || status.kind === "loading"}
        >
          {status.kind === "loading" ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          className="pool-action-button"
          onClick={exportJson}
          disabled={entries.length === 0}
        >
          Export JSON
        </button>
      </div>

      {!ready && (
        <p className="pending-stored-hint">
          Connect an account with a viewing key to generate an audit trail.
        </p>
      )}
      {status.kind === "error" && <p className="error">{status.message}</p>}

      {status.kind === "ready" && entries.length === 0 && (
        <p className="pending-stored-hint">No received notes found.</p>
      )}

      {entries.length > 0 && (
        <table className="audit-table" style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th align="left">Token</th>
              <th align="right">Amount</th>
              <th align="left">From</th>
              <th align="left">Salt / trade_id</th>
              <th align="left">Block</th>
              <th align="left">On-chain verify</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const tokenInfo = tokenInfoByAddress.get(
                BigInt(entry.token).toString(16),
              );
              const rowState =
                rowStates.get(entry.noteId) ?? { kind: "unverified" as const };
              const explorerBase = config.explorerUrl ?? "";
              return (
                <tr key={entry.noteId}>
                  <td>{tokenInfo?.name ?? shortenHex(entry.token)}</td>
                  <td align="right">
                    {tokenInfo
                      ? formatAmount(entry.amount, tokenInfo.decimals)
                      : entry.amount.toString()}
                  </td>
                  <td>
                    <code>{shortenHex(entry.sender)}</code>
                  </td>
                  <td>
                    <code>{shortenHex("0x" + entry.salt.toString(16))}</code>
                  </td>
                  <td>{entry.blockNumber ?? "—"}</td>
                  <td>
                    {rowState.kind === "unverified" && (
                      <button
                        type="button"
                        className="pool-action-button"
                        style={{ padding: "2px 8px", fontSize: 12 }}
                        onClick={() => void verifyRow(entry)}
                        disabled={!config.otcExecutorAddress}
                      >
                        Verify
                      </button>
                    )}
                    {rowState.kind === "verifying" && <span>Verifying…</span>}
                    {rowState.kind === "verified" && rowState.result && (
                      <span>
                        {rowState.result.isOtc ? "✓ OTC" : "Plain transfer"}{" "}
                        {explorerBase && (
                          <a
                            href={`${explorerBase}/tx/${rowState.result.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {shortenHex(rowState.result.txHash)}
                          </a>
                        )}
                        {rowState.result.tradeId && (
                          <>
                            {" "}
                            <code>
                              trade_id={shortenHex(rowState.result.tradeId)}
                            </code>
                          </>
                        )}
                      </span>
                    )}
                    {rowState.kind === "verified" && !rowState.result && (
                      <span>No event found</span>
                    )}
                    {rowState.kind === "error" && (
                      <span className="error">{rowState.message}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
