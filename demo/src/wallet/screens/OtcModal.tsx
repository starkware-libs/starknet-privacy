import { useEffect, useMemo, useState } from "react";
import type { Account, RpcProvider } from "starknet";
import type { AccountConfig, TokenConfig } from "../../config.ts";
import { createPOTCService } from "../../potc/index.ts";
import { Modal } from "../components/Modal.tsx";
import { Icon } from "../components/Icon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { useTradeState } from "../otc-state.ts";
import { decodeTradeCard, encodeTradeCard } from "../otc-share.ts";
import type { Contact } from "../contacts.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  account: Account | undefined;
  provider: RpcProvider | undefined;
  viewingKey: bigint | undefined;
  poolAddress: string;
  otcExecutorAddress: string;
  proverUrl: string | undefined;
  indexerUrl: string;
  tokens: TokenConfig[];
  accounts: AccountConfig[];
  contacts: Contact[];
  activeAccount: AccountConfig;
  explorerUrl?: string;
};

type Status =
  | { kind: "idle" }
  | { kind: "pending"; step: string }
  | { kind: "success"; txHash: string }
  | { kind: "error"; message: string };

export function OtcModal({
  open,
  onClose,
  account,
  provider,
  viewingKey,
  poolAddress,
  otcExecutorAddress,
  proverUrl,
  indexerUrl,
  tokens,
  accounts,
  contacts,
  activeAccount,
  explorerUrl,
}: Props) {
  const [tradeId, setTradeId] = useState("");
  const tradeState = useTradeState(provider, otcExecutorAddress, tradeId);
  const isSecondLeg = tradeState.phase === "second";

  const [offerToken, setOfferToken] = useState(tokens[0]?.address ?? "");
  const [offerAmount, setOfferAmount] = useState("");
  const [askToken, setAskToken] = useState(tokens[1]?.address ?? tokens[0]?.address ?? "");
  const [askAmount, setAskAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Reset when reopened — stale state from a previous trade would mislead
  // the user (especially the second-leg banner if they reuse the trade_id).
  useEffect(() => {
    if (!open) return;
    setStatus({ kind: "idle" });
  }, [open]);

  // Counterparty roster: own accounts (minus self/admin) + contacts. Same
  // dedupe rule the Send modal uses — accounts beat contacts on collision.
  const knownParties = useMemo(() => {
    const result: { name: string; address: string; origin: "account" | "contact" }[] = [];
    const seen = new Set<bigint>();
    try {
      seen.add(BigInt(activeAccount.address));
    } catch {
      // shouldn't happen
    }
    for (const entry of accounts) {
      if (entry.admin) continue;
      try {
        const key = BigInt(entry.address);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ name: entry.name, address: entry.address, origin: "account" });
      } catch {
        // skip
      }
    }
    for (const contact of contacts) {
      try {
        const key = BigInt(contact.address);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ name: contact.name, address: contact.address, origin: "contact" });
      } catch {
        // skip
      }
    }
    return result;
  }, [accounts, contacts, activeAccount.address]);

  // Resolve "Bob" → 0x... using the same rules as SendModal — case-insensitive
  // name match against the known-parties roster, else treat as a raw address.
  function resolveCounterparty(input: string): { address: string; party?: typeof knownParties[number] } {
    const trimmed = input.trim();
    if (!trimmed) return { address: "" };
    const byName = knownParties.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (byName) return { address: byName.address, party: byName };
    try {
      const asBigInt = BigInt(trimmed);
      const byAddress = knownParties.find((p) => {
        try {
          return BigInt(p.address) === asBigInt;
        } catch {
          return false;
        }
      });
      return { address: trimmed, party: byAddress };
    } catch {
      return { address: trimmed };
    }
  }

  const resolved = resolveCounterparty(counterparty);

  const decimalsByToken = useMemo(
    () => new Map(tokens.map((t) => [t.address, t.decimals])),
    [tokens]
  );

  function scaleToRaw(token: string, human: string): bigint {
    const decimals = decimalsByToken.get(token) ?? 18;
    const [whole = "0", fracRaw = ""] = human.split(".");
    const frac = fracRaw.padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  }

  const ready = Boolean(account && provider && viewingKey && proverUrl);
  const disabled =
    status.kind === "pending" ||
    !ready ||
    !tradeId ||
    !offerToken ||
    !offerAmount ||
    !counterparty ||
    !askToken ||
    !askAmount ||
    offerToken === askToken;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!account || !provider || !viewingKey || !proverUrl) return;
    setStatus({ kind: "pending", step: "Build proof" });
    try {
      const service = createPOTCService({
        account,
        provider,
        viewingKey,
        proverUrl,
        discoveryUrl: indexerUrl,
        poolAddress: BigInt(poolAddress),
        executorAddress: BigInt(otcExecutorAddress),
      });
      const proof = await service.buildProof({
        tradeId: BigInt(tradeId),
        offerToken: BigInt(offerToken),
        offerAmount: scaleToRaw(offerToken, offerAmount),
        counterparty: BigInt(resolved.address),
        askToken: BigInt(askToken),
        askAmount: scaleToRaw(askToken, askAmount),
      });
      setStatus({ kind: "pending", step: "Submit join_trade" });
      const txHash = await service.submitProof(BigInt(tradeId), proof);
      setStatus({ kind: "success", txHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  // --- Copy / Paste card ---

  const [copied, setCopied] = useState(false);
  function copyCard() {
    const offerTokenName = tokens.find((t) => t.address === offerToken)?.name;
    const askTokenName = tokens.find((t) => t.address === askToken)?.name;
    const card = encodeTradeCard({
      tradeId,
      myAddress: activeAccount.address,
      myName: activeAccount.name,
      myOffer: { token: offerToken, tokenName: offerTokenName, amount: offerAmount },
      myAsk: { token: askToken, tokenName: askTokenName, amount: askAmount },
    });
    void navigator.clipboard.writeText(card);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  const canCopy = Boolean(tradeId && offerToken && offerAmount && askToken && askAmount);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedFrom, setPastedFrom] = useState<{ name?: string; address: string } | null>(null);

  function applyPaste() {
    const result = decodeTradeCard(pasteText);
    if ("error" in result) {
      setPasteError(result.error);
      return;
    }
    // Resolve token addresses to ones we actually know about. If the
    // counterparty references a token we don't have configured, surface that
    // as an error rather than silently picking the first token (a subtle bug
    // that'd produce a successful-looking but wrong trade).
    const offerTokenMatch = tokens.find(
      (t) => safeBigIntEq(t.address, result.offer.token)
    );
    const askTokenMatch = tokens.find(
      (t) => safeBigIntEq(t.address, result.ask.token)
    );
    if (!offerTokenMatch) {
      setPasteError(`Offer token ${shortAddr(result.offer.token)} is not in your token list`);
      return;
    }
    if (!askTokenMatch) {
      setPasteError(`Ask token ${shortAddr(result.ask.token)} is not in your token list`);
      return;
    }
    setTradeId(result.tradeId);
    setOfferToken(offerTokenMatch.address);
    setOfferAmount(result.offer.amount);
    setAskToken(askTokenMatch.address);
    setAskAmount(result.ask.amount);
    setCounterparty(result.from.name ?? result.from.address);
    setPastedFrom(result.from);
    setPasteError(null);
    setPasteOpen(false);
    setPasteText("");
  }

  // --- Render ---

  if (status.kind === "success") {
    return (
      <Modal open={open} onClose={onClose} title={isSecondLeg ? "Trade settled" : "Leg submitted"}>
        <SuccessView
          isSecondLeg={isSecondLeg}
          txHash={status.txHash}
          explorerUrl={explorerUrl}
          onDone={onClose}
        />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="OTC trade">
      {/* Paste-from-counterparty toolbar */}
      <div className="row" style={{ marginBottom: 14, gap: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setPasteOpen(!pasteOpen);
            setPasteError(null);
          }}
        >
          <Icon.Plus size={13} />
          {pasteOpen ? "Hide paste" : "Paste from counterparty"}
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={copyCard}
          disabled={!canCopy}
          title={
            canCopy
              ? "Copy a JSON card for your counterparty — they paste it to fill the opposite legs"
              : "Fill in the trade details first"
          }
        >
          {copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
          {copied ? "Copied" : "Copy for counterparty"}
        </button>
      </div>

      {pasteOpen && (
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
          <div className="field-label" style={{ marginBottom: 0 }}>
            Paste counterparty's card
          </div>
          <textarea
            className="field-textarea"
            value={pasteText}
            onChange={(event) => {
              setPasteText(event.target.value);
              setPasteError(null);
            }}
            placeholder='{ "kind": "veil-otc-trade", "version": 1, "tradeId": "0x…", … }'
            rows={5}
          />
          {pasteError && <div className="field-error">{pasteError}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                setPasteOpen(false);
                setPasteText("");
                setPasteError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={applyPaste}
              disabled={!pasteText.trim()}
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {pastedFrom && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            padding: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderColor: "rgba(33, 212, 253, 0.32)",
            background: "rgba(33, 212, 253, 0.06)",
          }}
        >
          <Icon.Shield size={14} />
          <div style={{ fontSize: 12 }}>
            Filled from <strong>{pastedFrom.name ?? "counterparty"}</strong>
            's card. They'll see the mirror of these legs on their side.
          </div>
        </div>
      )}

      {isSecondLeg && (
        <div
          style={{
            marginBottom: 14,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: 14,
            borderRadius: 14,
            borderColor: "rgba(124, 92, 255, 0.45)",
            background:
              "linear-gradient(135deg, rgba(124, 92, 255, 0.14), rgba(33, 212, 253, 0.10))",
            boxShadow:
              "inset 0 0 0 1px rgba(124, 92, 255, 0.35)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "var(--accent-grad)",
              display: "grid",
              placeItems: "center",
              color: "#fff",
              flexShrink: 0,
            }}
          >
            <Icon.Sparkle size={14} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
              You're firing this trade
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.4 }}>
              Your counterparty already submitted. Submitting yours will atomically
              settle both sides in a single transaction.
            </div>
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">
            Trade ID
            <TradePhaseChip phase={tradeState.phase} />
          </label>
          <input
            type="text"
            className="field-input mono"
            style={{ fontSize: 13 }}
            value={tradeId}
            onChange={(event) => setTradeId(event.target.value)}
            placeholder="0x… or decimal"
          />
        </div>

        <LegRow
          heading="You offer"
          tone="up"
          tokens={tokens}
          token={offerToken}
          onToken={setOfferToken}
          amount={offerAmount}
          onAmount={setOfferAmount}
        />
        <LegRow
          heading="You receive"
          tone="down"
          tokens={tokens}
          token={askToken}
          onToken={setAskToken}
          amount={askAmount}
          onAmount={setAskAmount}
        />

        <div className="field" style={{ margin: 0 }}>
          <label className="field-label">Counterparty</label>
          {knownParties.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {knownParties.slice(0, 6).map((party) => {
                const selected =
                  resolved.party && party.address === resolved.party.address;
                return (
                  <button
                    key={`${party.origin}:${party.address}`}
                    type="button"
                    className="chip"
                    onClick={() => setCounterparty(party.name)}
                    style={{
                      cursor: "pointer",
                      border: "none",
                      background: selected ? "var(--accent-grad-soft)" : undefined,
                      color: selected ? "var(--text)" : undefined,
                      boxShadow: selected
                        ? "inset 0 0 0 1px var(--card-border-strong)"
                        : undefined,
                    }}
                    title={party.address}
                  >
                    {party.origin === "contact" && <Icon.Wallet size={11} />}
                    {party.name}
                  </button>
                );
              })}
            </div>
          )}
          <input
            type="text"
            className="field-input"
            value={counterparty}
            onChange={(event) => setCounterparty(event.target.value)}
            placeholder="Name (e.g. Bob) or 0x…"
            list="otc-modal-counterparty-options"
          />
          <datalist id="otc-modal-counterparty-options">
            {knownParties.map((entry) => (
              <option key={entry.address} value={entry.name}>
                {entry.address}
              </option>
            ))}
          </datalist>
          {counterparty.trim() && resolved.party && counterparty.trim() !== resolved.party.name && (
            <span style={{ fontSize: 12, color: "var(--accent-3)" }}>
              ↳ {resolved.party.name}
            </span>
          )}
        </div>

        <button className="btn btn-primary btn-block" disabled={disabled}>
          {status.kind === "pending" ? (
            <>
              <span className="spinner" />
              {status.step}
            </>
          ) : isSecondLeg ? (
            <>
              <Icon.Sparkle size={15} />
              Fire trade — settle both legs
            </>
          ) : (
            <>
              <Icon.Handshake size={15} />
              Submit your leg
            </>
          )}
        </button>

        {status.kind === "error" && (
          <OtcErrorBanner message={status.message} />
        )}

        {!ready && (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            Connect an account and ensure the proving service URL is configured.
          </p>
        )}
      </form>
    </Modal>
  );
}

function LegRow({
  heading,
  tone,
  tokens,
  token,
  onToken,
  amount,
  onAmount,
}: {
  heading: string;
  tone: "up" | "down";
  tokens: TokenConfig[];
  token: string;
  onToken: (address: string) => void;
  amount: string;
  onAmount: (value: string) => void;
}) {
  const accent =
    tone === "up"
      ? "rgba(248, 113, 113, 0.32)"
      : "rgba(52, 211, 153, 0.32)";
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        border: `1px solid ${accent}`,
        background: tone === "up" ? "rgba(248, 113, 113, 0.04)" : "rgba(52, 211, 153, 0.04)",
      }}
    >
      <div className="field-label" style={{ marginBottom: 10 }}>
        {heading}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <select
          className="field-select"
          style={{ width: 110, fontSize: 14, padding: "10px 30px 10px 12px" }}
          value={token}
          onChange={(event) => onToken(event.target.value)}
        >
          {tokens.map((tokenConfig) => (
            <option key={tokenConfig.address} value={tokenConfig.address}>
              {tokenConfig.name}
            </option>
          ))}
        </select>
        <input
          className="field-input tabular"
          style={{ flex: 1, fontSize: 18, fontWeight: 600 }}
          value={amount}
          onChange={(event) => onAmount(event.target.value)}
          placeholder="0.0"
          inputMode="decimal"
        />
      </div>
    </div>
  );
}

function TradePhaseChip({
  phase,
}: {
  phase: "idle" | "loading" | "fresh" | "second" | "error";
}) {
  if (phase === "idle") return null;
  if (phase === "loading") {
    return (
      <span className="chip" style={{ marginLeft: 8 }}>
        <span className="spinner" style={{ width: 9, height: 9 }} />
        checking
      </span>
    );
  }
  if (phase === "fresh") {
    return (
      <span className="chip" style={{ marginLeft: 8 }}>
        first leg
      </span>
    );
  }
  if (phase === "second") {
    return (
      <span
        className="chip"
        style={{
          marginLeft: 8,
          background: "var(--accent-grad-soft)",
          color: "var(--text)",
          boxShadow: "inset 0 0 0 1px rgba(124, 92, 255, 0.45)",
        }}
      >
        <Icon.Sparkle size={10} />
        second leg
      </span>
    );
  }
  return (
    <span className="chip chip-warn" style={{ marginLeft: 8 }}>
      lookup failed
    </span>
  );
}

function SuccessView({
  isSecondLeg,
  txHash,
  explorerUrl,
  onDone,
}: {
  isSecondLeg: boolean;
  txHash: string;
  explorerUrl?: string;
  onDone: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "8px 4px" }}>
      <SuccessCheck />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
          {isSecondLeg ? "Trade settled" : "Your leg is in"}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 320 }}>
          {isSecondLeg
            ? "Both legs applied atomically. Balances will update on the next refresh."
            : "Waiting for your counterparty to submit their leg. The trade fires the moment they do."}
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", textAlign: "center" }}>
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

// Animated SVG check. CSS is in styles.css under `.success-check-*`.
function SuccessCheck() {
  return (
    <div className="success-check-wrap">
      <svg className="success-check" width={72} height={72} viewBox="0 0 72 72">
        <circle className="success-check-circle" cx={36} cy={36} r={32} />
        <path className="success-check-tick" d="M22 37 l10 10 l18 -22" />
      </svg>
    </div>
  );
}

function shortAddr(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function safeBigIntEq(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

// Pretty error banner for failed OTC submissions. Pulls the *useful* line out
// of the raw error (Starknet errors are often nested with JSON noise and a
// human cause at the bottom). The full original message is still available
// via tooltip + an "expand" toggle for debugging.
function OtcErrorBanner({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeOtcError(message);
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        border: "1px solid rgba(248, 113, 113, 0.4)",
        background: "rgba(248, 113, 113, 0.08)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          color: "var(--danger)",
        }}
      >
        <Icon.X size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
            Trade failed
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {summary}
          </div>
        </div>
      </div>
      {summary !== message && (
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          style={{ marginTop: 8, fontSize: 11 }}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Hide raw error" : "Show raw error"}
        </button>
      )}
      {expanded && (
        <pre
          style={{
            marginTop: 8,
            marginBottom: 0,
            padding: 10,
            background: "rgba(0,0,0,0.3)",
            borderRadius: 8,
            fontSize: 10.5,
            lineHeight: 1.5,
            color: "var(--text-muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflowY: "auto",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
          }}
        >
          {message}
        </pre>
      )}
    </div>
  );
}

// Distill a multi-line / nested-JSON Starknet error into a short, accountable
// sentence. Heuristics by what we actually see in practice:
//  - "User abort"/"reject" → user cancelled
//  - "EXPECTED_NOTE_NOT_FOUND" / "INVALID_FIRST_ACTIONS" / etc. → known assert
//  - "Proof generation failed" → prover issue
//  - "Insufficient balance" / "not enough" → balance
//  - Everything else → "Submission rejected — show details for the raw error."
function summarizeOtcError(message: string): string {
  if (!message) return "Unknown error — try again or check the prover service.";
  const lower = message.toLowerCase();

  if (/reject|deni|user.?abort|cancel/.test(lower)) {
    return "You cancelled the signing prompt. No transaction was sent.";
  }
  if (lower.includes("expected_note_not_found")) {
    return "Your counterparty's leg doesn't match what was agreed (token, amount, or trade id). Confirm the details and retry.";
  }
  if (
    lower.includes("invalid_first_actions") ||
    lower.includes("invalid_second_actions")
  ) {
    return "The stored actions for this trade are invalid. The trade id may already be settled.";
  }
  if (lower.includes("no incoming channel")) {
    return "You haven't received any prior transfer from this counterparty. Ask them to send you a setup transfer first.";
  }
  if (/insufficient|not enough|balance.*too.*low/.test(lower)) {
    return "Insufficient private balance for the offered token.";
  }
  if (/proof|prov(er|ing)/.test(lower)) {
    return "Proof generation failed. Check the proving service is reachable and retry.";
  }
  if (lower.includes("nonce")) {
    return "Account nonce mismatch — likely a stale tx. Refresh and retry.";
  }
  if (/network|fetch|timeout/.test(lower)) {
    return "Network error reaching the pool or proving service. Retry in a moment.";
  }
  // Fall back to the FIRST non-empty line of the raw message — usually the
  // most useful single line. Caps at 160 chars so the banner stays compact.
  const firstLine = message.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? message;
  return firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;
}
