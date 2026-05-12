import { useMemo, useState } from "react";
import type { AccountConfig, TokenConfig } from "../../config.ts";
import type { TokenBalance } from "../../hooks/usePrivateState.ts";
import type { TransactionStatus } from "../../hooks/useTransactions.ts";
import { formatAmount, formatTokenAmount } from "../../format.ts";
import { Modal } from "../components/Modal.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { Icon } from "../components/Icon.tsx";
import { SuccessView } from "../components/SuccessView.tsx";
import type { Contact } from "../contacts.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  activeAccount: AccountConfig;
  accounts: AccountConfig[]; // other accounts only
  contacts: Contact[];
  tokens: TokenConfig[];
  balances: TokenBalance[];
  status: TransactionStatus;
  explorerUrl?: string;
  onTransfer: (token: string, recipient: string, amount: string) => void;
};

type Party = {
  name: string;
  address: string;
  origin: "self" | "account" | "contact";
};

export function SendModal({
  open,
  onClose,
  activeAccount,
  accounts,
  contacts,
  tokens,
  balances,
  status,
  explorerUrl,
  onTransfer,
}: Props) {
  // `armed` flips true the moment the user submits — the success view is
  // gated on this so a stale status from a previous (different) tx doesn't
  // hijack a freshly-opened Send modal.
  const [armed, setArmed] = useState(false);
  // Default to the first token that actually has a private balance, so the
  // "Send" form opens on something the user can immediately send.
  const defaultToken =
    balances.find((tb) => tb.private > 0n)?.address ?? tokens[0]?.address ?? "";
  const [token, setToken] = useState(defaultToken);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const decimals = useMemo(
    () => tokens.find((entry) => entry.address === token)?.decimals ?? 18,
    [token, tokens]
  );

  const privateBalance = balances.find(
    (tb) => BigInt(tb.address) === BigInt(token || "0x0")
  )?.private ?? 0n;

  function onMax() {
    setAmount(formatAmount(privateBalance, decimals));
  }

  // Build a deduped roster of named parties: self → other accounts → contacts.
  // Accounts win over contacts when they share the same address (the account
  // entry carries the signing capability and is the more authoritative name).
  const parties: Party[] = useMemo(() => {
    const result: Party[] = [
      { name: "Self", address: activeAccount.address, origin: "self" },
    ];
    const seen = new Set<bigint>();
    try {
      seen.add(BigInt(activeAccount.address));
    } catch {
      // Should never throw — addresses are validated upstream — but guard
      // against any malformed entry rather than crash the modal.
    }
    for (const account of accounts) {
      try {
        const key = BigInt(account.address);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ name: account.name, address: account.address, origin: "account" });
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
  }, [activeAccount.address, accounts, contacts]);

  // Resolve whatever's in the recipient field. Three cases:
  //   1. Exact case-insensitive name match → use the party's address.
  //   2. Anything that parses as hex → keep verbatim (might still match a
  //      known party by address, surface the friendly name as confirmation).
  //   3. Neither → treat as invalid; submit stays disabled.
  const resolved = useMemo((): { address: string; party?: Party; valid: boolean } => {
    const trimmed = recipient.trim();
    if (!trimmed) return { address: "", valid: false };
    const byName = parties.find(
      (party) => party.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (byName) return { address: byName.address, party: byName, valid: true };
    try {
      const asBigInt = BigInt(trimmed);
      const byAddress = parties.find((party) => {
        try {
          return BigInt(party.address) === asBigInt;
        } catch {
          return false;
        }
      });
      return { address: trimmed, party: byAddress, valid: true };
    } catch {
      return { address: trimmed, valid: false };
    }
  }, [recipient, parties]);

  function onSubmit() {
    if (!resolved.valid || !amount) return;
    setArmed(true);
    onTransfer(token, resolved.address, amount);
  }

  const succeeded = armed && !status.pending && Boolean(status.lastTxHash) && !status.lastError;
  if (succeeded && status.lastTxHash) {
    const tokenName = tokens.find((t) => t.address === token)?.name ?? "";
    const recipientName = resolved.party?.name ?? "the recipient";
    return (
      <Modal open={open} onClose={onClose} title="Sent">
        <SuccessView
          title="Transfer complete"
          subtitle={`${amount} ${tokenName} → ${recipientName}. Senders, recipients and amounts stay encrypted on chain.`}
          txHash={status.lastTxHash}
          explorerUrl={explorerUrl}
          onDone={onClose}
        />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Send privately">
      <div className="field">
        <label className="field-label">Asset</label>
        <AmountInput
          amount={amount}
          onAmount={setAmount}
          token={token}
          onToken={setToken}
          tokens={tokens}
          onMax={onMax}
          disabled={status.pending}
        />
        <div className="row" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          <span>
            Available:{" "}
            <span className="tabular" style={{ color: "var(--text-dim)" }}>
              {formatTokenAmount(privateBalance, decimals)}
            </span>
          </span>
        </div>
      </div>

      <div className="field">
        <label className="field-label">Recipient</label>
        {parties.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {parties.slice(0, 12).map((party) => {
              const selected =
                resolved.party && party.address === resolved.party.address;
              return (
                <button
                  key={`${party.origin}:${party.address}`}
                  type="button"
                  className="chip"
                  onClick={() => setRecipient(party.name)}
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
                  {party.origin === "self" && <Icon.Sparkle size={11} />}
                  {party.origin === "contact" && <Icon.Wallet size={11} />}
                  {party.name}
                </button>
              );
            })}
          </div>
        )}
        <input
          className="field-input"
          style={{ fontSize: 14 }}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          placeholder="Name (e.g. Bob) or 0x… address"
          list="send-party-options"
          disabled={status.pending}
        />
        <datalist id="send-party-options">
          {parties.map((party) => (
            <option key={`${party.origin}:${party.address}`} value={party.name}>
              {party.address}
            </option>
          ))}
        </datalist>
        {recipient.trim() && (
          <RecipientHint resolved={resolved} input={recipient} />
        )}
      </div>

      <button
        className="btn btn-primary btn-block"
        onClick={onSubmit}
        disabled={status.pending || !resolved.valid || !amount}
      >
        {status.pending ? (
          <>
            <span className="spinner" />
            {status.action ?? "Sending"}
          </>
        ) : (
          <>
            <Icon.Send size={15} />
            Send {amount && token ? `${amount} ${tokens.find((t) => t.address === token)?.name ?? ""}` : ""}
            {resolved.party ? ` to ${resolved.party.name}` : ""}
          </>
        )}
      </button>

      <p className="muted center" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        Senders, recipients and amounts are encrypted on chain.
      </p>
    </Modal>
  );
}

function RecipientHint({
  resolved,
  input,
}: {
  resolved: { address: string; party?: Party; valid: boolean };
  input: string;
}) {
  if (!resolved.valid) {
    return (
      <span className="field-error">
        Not a known name or hex address. Add it under Settings → Contacts.
      </span>
    );
  }
  if (resolved.party) {
    // If the user typed the name, show the resolved address. If they pasted
    // an address that matches a known party, show the friendly name instead.
    const typedName = input.trim().toLowerCase() === resolved.party.name.toLowerCase();
    if (typedName) {
      return (
        <span style={{ fontSize: 12, color: "var(--accent-3)" }} className="mono">
          ↳ {resolved.party.address.slice(0, 10)}…{resolved.party.address.slice(-6)}
        </span>
      );
    }
    return (
      <span style={{ fontSize: 12, color: "var(--accent-3)" }}>
        ↳ {resolved.party.name}{" "}
        <span className="muted">
          ({resolved.party.origin === "contact"
            ? "contact"
            : resolved.party.origin === "self"
              ? "yourself"
              : "your account"})
        </span>
      </span>
    );
  }
  return (
    <span className="muted" style={{ fontSize: 12 }}>
      Sending to an address not in your contacts. Double-check it.
    </span>
  );
}
