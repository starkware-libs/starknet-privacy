import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcProvider } from "starknet";
import type { Note } from "starknet-sdk";
import type { AccountConfig, AppConfig, TokenConfig } from "../../config.ts";
import { createDiscoveryProvider } from "../../starknet.ts";
import { formatTokenAmount } from "../../format.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { Icon } from "../components/Icon.tsx";
import { TokenAvatar } from "../components/TokenAvatar.tsx";
import type { Contact } from "../contacts.ts";
import { verifyNote, type VerificationResult } from "../audit-verify.ts";

type Props = {
  provider: RpcProvider | undefined;
  activeAccount: AccountConfig;
  accounts: AccountConfig[];
  contacts: Contact[];
  poolAddress: string;
  otcExecutorAddress: string | undefined;
  tokens: TokenConfig[];
  config: AppConfig;
  explorerUrl?: string;
};

// One row in the reconstructed ledger. Everything here is derived from the
// SDK's decrypted note plus the token config — no on-chain RPC required for
// the base row. Verification (the on-chain anchor) is layered on per-row.
type AuditRow = {
  // Stable key for React + de-dup. note_id is unique per pool.
  key: string;
  noteId: bigint;
  noteIdHex: string;
  tokenAddress: string;
  tokenName: string;
  decimals: number;
  rawAmount: bigint;
  humanAmount: string;
  sender: bigint;
  senderHex: string;
  senderName: string | null;
  /** witness.r — the deterministic salt the sender used. For OTC notes this
   * is the trade_id; for plain transfers it's a random per-note value. */
  salt: bigint;
  saltHex: string;
  block: number | null;
  open: boolean;
};

export function AuditScreen({
  provider,
  activeAccount,
  accounts,
  contacts,
  poolAddress,
  otcExecutorAddress,
  tokens,
  config,
  explorerUrl,
}: Props) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row verification state, keyed by noteIdHex. Lives only in memory —
  // a tab reload wipes it, by design. The whole point of this screen is
  // "nothing persists", so reload = re-prove.
  const [verifications, setVerifications] = useState<Map<string, VerificationResult>>(
    new Map()
  );
  const [verifyingKeys, setVerifyingKeys] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const reload = useCallback(async () => {
    if (!provider || !activeAccount.viewingKey) return;
    setLoading(true);
    setError(null);
    try {
      const indexer = createDiscoveryProvider(config, poolAddress);
      const tokenBigInts = tokens.map((token) => BigInt(token.address));
      // No cursor — explicit fresh sweep so the "reconstructed live" claim
      // actually holds. Discovery cost is small for an audit-grade flow.
      const result = await indexer.discoverNotes(
        BigInt(activeAccount.address),
        BigInt(activeAccount.viewingKey),
        { tokens: tokenBigInts, blockIdentifier: "pre_confirmed" }
      );
      const tokenByAddress = new Map<bigint, TokenConfig>();
      for (const token of tokens) tokenByAddress.set(BigInt(token.address), token);
      const nameByAddress = new Map<bigint, string>();
      for (const account of accounts) {
        if (account.admin) continue;
        try {
          nameByAddress.set(BigInt(account.address), account.name);
        } catch {
          // skip
        }
      }
      for (const contact of contacts) {
        try {
          const key = BigInt(contact.address);
          if (!nameByAddress.has(key)) nameByAddress.set(key, contact.name);
        } catch {
          // skip
        }
      }

      const flattened: AuditRow[] = [];
      for (const [tokenAddrBigInt, notes] of result.notes) {
        const tokenConfig = tokenByAddress.get(tokenAddrBigInt);
        if (!tokenConfig) continue;
        for (const note of notes as Note[]) {
          const noteIdBigInt = toBigInt(note.id);
          const senderBigInt = toBigInt(note.sender);
          const witness = note.witness as { r: bigint; channelKey: bigint; nonce: number };
          const saltBigInt = witness.r;
          // `note.created` is `BlockNumber` from the SDK — usually a number
          // but can be a tag string like "pre_confirmed" when the note has
          // just landed. Coerce to a number; non-numeric tags become null.
          const createdBlock = typeof note.created === "number" ? note.created : null;
          flattened.push({
            key: noteIdBigInt.toString(16),
            noteId: noteIdBigInt,
            noteIdHex: "0x" + noteIdBigInt.toString(16),
            tokenAddress: tokenConfig.address,
            tokenName: tokenConfig.name,
            decimals: tokenConfig.decimals,
            rawAmount: note.amount,
            humanAmount: formatTokenAmount(note.amount, tokenConfig.decimals),
            sender: senderBigInt,
            senderHex: "0x" + senderBigInt.toString(16),
            senderName: nameByAddress.get(senderBigInt) ?? null,
            salt: saltBigInt,
            saltHex: "0x" + saltBigInt.toString(16),
            block: createdBlock,
            open: note.open ?? false,
          });
        }
      }
      flattened.sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
      setRows(flattened);
      // Don't drop the verifications map: a re-fetch shouldn't invalidate
      // verifications that are still valid (note_id is content-addressed).
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [provider, activeAccount, accounts, contacts, poolAddress, tokens, config]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const verifyOne = useCallback(
    async (row: AuditRow) => {
      if (!provider || !otcExecutorAddress) return;
      setVerifyingKeys((previous) => {
        const next = new Set(previous);
        next.add(row.key);
        return next;
      });
      const result = await verifyNote(
        provider,
        poolAddress,
        otcExecutorAddress,
        row.noteId,
        row.salt,
        row.block
      );
      setVerifications((previous) => {
        const next = new Map(previous);
        next.set(row.key, result);
        return next;
      });
      setVerifyingKeys((previous) => {
        const next = new Set(previous);
        next.delete(row.key);
        return next;
      });
    },
    [provider, poolAddress, otcExecutorAddress]
  );

  // Verify-all: run unverified rows N at a time so a 50-row audit doesn't
  // blast the RPC. Each row writes its result into the same state map.
  const verifyAll = useCallback(async () => {
    if (!provider || !otcExecutorAddress) return;
    const todo = rows.filter((row) => !verifications.has(row.key));
    if (todo.length === 0) return;
    setBulkProgress({ done: 0, total: todo.length });
    const concurrency = 4;
    let completed = 0;
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) {
        const index = cursor++;
        const row = todo[index];
        const result = await verifyNote(
          provider!,
          poolAddress,
          otcExecutorAddress!,
          row.noteId,
          row.salt,
          row.block
        );
        setVerifications((previous) => {
          const next = new Map(previous);
          next.set(row.key, result);
          return next;
        });
        completed += 1;
        setBulkProgress({ done: completed, total: todo.length });
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    setBulkProgress(null);
  }, [provider, otcExecutorAddress, poolAddress, rows, verifications]);

  const exportJson = useCallback(() => {
    const payload = {
      generatedAt: new Date().toISOString(),
      account: {
        address: activeAccount.address,
        name: activeAccount.name,
      },
      poolAddress,
      otcExecutorAddress: otcExecutorAddress ?? null,
      rows: rows.map((row) => {
        const verification = verifications.get(row.key);
        return {
          noteId: row.noteIdHex,
          token: {
            address: row.tokenAddress,
            name: row.tokenName,
            decimals: row.decimals,
          },
          amount: {
            raw: row.rawAmount.toString(),
            human: row.humanAmount,
          },
          sender: {
            address: row.senderHex,
            name: row.senderName ?? null,
          },
          salt: row.saltHex,
          block: row.block,
          verification: verification ? serializeVerification(verification) : null,
        };
      }),
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    const shortAddr = activeAccount.address.slice(0, 6) + activeAccount.address.slice(-4);
    link.download = `veil-audit-${shortAddr}-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [activeAccount, poolAddress, otcExecutorAddress, rows, verifications]);

  const verifiedCount = useMemo(
    () => Array.from(verifications.values()).filter((v) => v.kind !== "error").length,
    [verifications]
  );

  return (
    <>
      <div className="top-bar">
        <div>
          <h1 className="page-title">Audit trail</h1>
          <p className="page-sub">
            Reconstructed live from your viewing key — nothing on this page is stored on
            this device. Share an accountant's link, export, or verify each row against
            chain state.
          </p>
        </div>
        <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
          {bulkProgress && (
            <span className="chip">
              <span className="spinner" /> {bulkProgress.done}/{bulkProgress.total}
            </span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void reload()}
            disabled={loading}
          >
            <Icon.Refresh size={14} />
            {loading ? "Refetching" : "Re-fetch from chain"}
          </button>
          {otcExecutorAddress && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void verifyAll()}
              disabled={loading || bulkProgress !== null || rows.length === 0}
              title="Verify every row against on-chain events"
            >
              <Icon.Shield size={14} />
              Verify all
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={exportJson}
            disabled={rows.length === 0}
          >
            <Icon.ArrowDownLeft size={14} />
            Export JSON
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            borderColor: "rgba(248, 113, 113, 0.32)",
            background: "rgba(248, 113, 113, 0.06)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid rgba(255,255,255,0.04)",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <span className="card-title" style={{ margin: 0 }}>
            Incoming notes ({rows.length})
          </span>
          {verifications.size > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              {verifiedCount}/{verifications.size} verified
            </span>
          )}
        </div>

        {loading && rows.length === 0 && (
          <div className="empty" style={{ margin: 18 }}>
            <span className="spinner" /> Reconstructing from chain…
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="empty" style={{ margin: 18 }}>
            No incoming notes yet. Once you receive a private transfer or OTC trade,
            the row will show up here — reconstructed straight from chain.
          </div>
        )}

        {rows.length > 0 && (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Amount</th>
                  <th>From</th>
                  <th>Salt (trade id)</th>
                  <th>Block</th>
                  <th>Verify</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const verification = verifications.get(row.key);
                  const verifying = verifyingKeys.has(row.key);
                  return (
                    <tr key={row.key}>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <TokenAvatar name={row.tokenName} size={26} />
                          <span style={{ fontWeight: 600 }}>{row.tokenName}</span>
                        </div>
                      </td>
                      <td className="tabular">
                        {row.humanAmount}
                        {row.open && (
                          <span className="chip" style={{ marginLeft: 6 }}>
                            open
                          </span>
                        )}
                      </td>
                      <td>
                        {row.senderName ? (
                          <span style={{ fontWeight: 600 }}>{row.senderName}</span>
                        ) : (
                          <span className="mono" style={{ fontSize: 11 }}>
                            {row.senderHex.slice(0, 8)}…{row.senderHex.slice(-4)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="mono" style={{ fontSize: 11 }}>
                          {row.saltHex.slice(0, 8)}…{row.saltHex.slice(-4)}
                        </span>
                        <CopyButton value={row.saltHex} inline />
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {row.block != null ? `#${row.block}` : "—"}
                      </td>
                      <td>
                        <VerifyCell
                          state={verification}
                          verifying={verifying}
                          disabled={!otcExecutorAddress}
                          onVerify={() => void verifyOne(row)}
                          explorerUrl={explorerUrl}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function VerifyCell({
  state,
  verifying,
  disabled,
  onVerify,
  explorerUrl,
}: {
  state: VerificationResult | undefined;
  verifying: boolean;
  disabled: boolean;
  onVerify: () => void;
  explorerUrl?: string;
}) {
  if (verifying) {
    return (
      <span className="chip">
        <span className="spinner" /> verifying
      </span>
    );
  }
  if (!state) {
    return (
      <button
        className="btn btn-ghost btn-sm"
        onClick={onVerify}
        disabled={disabled}
        title={
          disabled
            ? "OTC executor address not configured for this pool"
            : "Re-fetch the EncNoteCreated event and recover the trade id from on-chain calldata"
        }
      >
        <Icon.Shield size={13} />
        Verify
      </button>
    );
  }
  if (state.kind === "not-found") {
    return <span className="chip chip-warn">no event found</span>;
  }
  if (state.kind === "error") {
    return (
      <span className="chip chip-bad" title={state.message}>
        error
      </span>
    );
  }
  if (state.kind === "plain") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span className="chip" title="No OTC join_trade call in this tx — note came from a plain transfer or deposit.">
          plain transfer
        </span>
        {explorerUrl && (
          <a
            href={`${explorerUrl.replace(/\/$/, "")}/tx/${state.txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11 }}
          >
            tx ↗
          </a>
        )}
      </span>
    );
  }
  // OK — otc, verified
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="chip chip-ok">
        <Icon.Check size={11} /> join_trade
      </span>
      {explorerUrl && (
        <a
          href={`${explorerUrl.replace(/\/$/, "")}/tx/${state.txHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 11 }}
        >
          tx ↗
        </a>
      )}
    </span>
  );
}

function serializeVerification(verification: VerificationResult) {
  switch (verification.kind) {
    case "otc":
      return {
        kind: "otc" as const,
        txHash: verification.txHash,
        blockNumber: verification.blockNumber,
        tradeId: "0x" + verification.tradeId.toString(16),
      };
    case "plain":
      return {
        kind: "plain" as const,
        txHash: verification.txHash,
        blockNumber: verification.blockNumber,
      };
    case "not-found":
      return { kind: "not-found" as const };
    case "error":
      return { kind: "error" as const, message: verification.message };
  }
}

function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}
