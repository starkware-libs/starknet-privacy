import { useMemo, useState, type FormEvent } from "react";
import type { Account, RpcProvider } from "starknet";
import type { AccountConfig, TokenConfig } from "../config.ts";
import { createPOTCService } from "../potc/index.ts";

type Props = {
  account: Account | undefined;
  provider: RpcProvider | undefined;
  viewingKey: bigint | undefined;
  poolAddress: string;
  otcExecutorAddress: string;
  proverUrl: string | undefined;
  indexerUrl: string;
  tokens: TokenConfig[];
  // Known accounts — used to populate the counterparty autocomplete by name.
  // Admin accounts and the active account are filtered out inside the panel.
  accounts: AccountConfig[];
  activeAddress: string | undefined;
};

type Status =
  | { kind: "idle" }
  | { kind: "pending"; step: string }
  | { kind: "success"; txHash: string }
  | { kind: "error"; message: string };

export function OtcPanel({
  account,
  provider,
  viewingKey,
  poolAddress,
  otcExecutorAddress,
  proverUrl,
  indexerUrl,
  tokens,
  accounts,
  activeAddress,
}: Props) {
  const [tradeId, setTradeId] = useState("");
  const [offerToken, setOfferToken] = useState(tokens[0]?.address ?? "");
  const [offerAmount, setOfferAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [askToken, setAskToken] = useState(tokens[1]?.address ?? "");
  const [askAmount, setAskAmount] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const decimalsByToken = useMemo(
    () => new Map(tokens.map((t) => [t.address, t.decimals])),
    [tokens],
  );

  // Counterparty candidates: known non-admin accounts other than the one
  // currently signing. Compared as BigInt so 0x0..1 and 0x1 match.
  const counterpartyOptions = useMemo(() => {
    const activeAsBigInt = activeAddress ? BigInt(activeAddress) : undefined;
    return accounts.filter((entry) => {
      if (entry.admin) return false;
      try {
        return activeAsBigInt === undefined || BigInt(entry.address) !== activeAsBigInt;
      } catch {
        return true;
      }
    });
  }, [accounts, activeAddress]);

  // If the user typed a name that matches a known account, resolve to its
  // address before submitting. Comparison is case-insensitive and trimmed.
  function resolveCounterparty(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return trimmed;
    const match = counterpartyOptions.find(
      (entry) => entry.name.toLowerCase() === trimmed.toLowerCase(),
    );
    return match?.address ?? trimmed;
  }

  const resolvedCounterparty = resolveCounterparty(counterparty);
  const counterpartyLabel = counterpartyOptions.find(
    (entry) => entry.address === resolvedCounterparty,
  )?.name;

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

  function scaleToRaw(token: string, human: string): bigint {
    const decimals = decimalsByToken.get(token) ?? 18;
    const [whole = "0", fracRaw = ""] = human.split(".");
    const frac = fracRaw.padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  }

  async function onSubmit(event: FormEvent) {
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
        counterparty: BigInt(resolvedCounterparty),
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

  return (
    <form onSubmit={onSubmit} className="action-form">
      <h2>OTC Trade</h2>
      <p className="pending-stored-hint">
        Atomic peer-to-peer swap via <code>OtcSettlement.join_trade</code>. Each side
        submits their leg with a shared <code>trade_id</code>; the contract stores both
        legs and applies them in a single transaction once the second party joins.
      </p>

      <label className="builder-row">
        <span>Trade ID (felt252)</span>
        <input
          type="text"
          value={tradeId}
          onChange={(e) => setTradeId(e.target.value)}
          placeholder="0x… or decimal"
        />
      </label>

      <fieldset className="otc-fieldset">
        <legend>Offer (you give)</legend>
        <div className="otc-row">
          <label className="builder-row">
            <span>Token</span>
            <select value={offerToken} onChange={(e) => setOfferToken(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="builder-row">
            <span>Amount</span>
            <input
              type="text"
              inputMode="decimal"
              value={offerAmount}
              onChange={(e) => setOfferAmount(e.target.value)}
              placeholder="0.0"
            />
          </label>
        </div>
      </fieldset>

      <label className="builder-row">
        <span>Counterparty</span>
        <input
          type="text"
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          placeholder="Name (e.g. Bob) or 0x…"
          list="otc-counterparty-options"
        />
        <datalist id="otc-counterparty-options">
          {counterpartyOptions.map((entry) => (
            <option key={entry.address} value={entry.name}>
              {entry.address}
            </option>
          ))}
        </datalist>
        {counterpartyLabel && counterparty.trim() !== counterpartyLabel && (
          <span className="pending-stored-hint">
            → {counterpartyLabel} ({resolvedCounterparty.slice(0, 10)}…)
          </span>
        )}
      </label>

      <fieldset className="otc-fieldset">
        <legend>Ask (you receive)</legend>
        <div className="otc-row">
          <label className="builder-row">
            <span>Token</span>
            <select value={askToken} onChange={(e) => setAskToken(e.target.value)}>
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="builder-row">
            <span>Amount</span>
            <input
              type="text"
              inputMode="decimal"
              value={askAmount}
              onChange={(e) => setAskAmount(e.target.value)}
              placeholder="0.0"
            />
          </label>
        </div>
        <p className="pending-stored-hint">
          Ask side is off-chain agreement only — verify the counterparty's leg uses the
          same <code>trade_id</code> and matches what you expect before submitting.
        </p>
      </fieldset>

      <button type="submit" className="pool-action-button" disabled={disabled}>
        {status.kind === "pending" ? `${status.step}…` : "Submit leg"}
      </button>

      {status.kind === "success" && (
        <p className="pool-price">
          Tx submitted: <code>{status.txHash}</code>
        </p>
      )}
      {status.kind === "error" && (
        <p className="error" style={{ marginTop: 8 }}>
          {status.message}
        </p>
      )}
      {!ready && (
        <p className="pending-stored-hint">
          Connect an account and ensure the proving service URL is configured.
        </p>
      )}
    </form>
  );
}
