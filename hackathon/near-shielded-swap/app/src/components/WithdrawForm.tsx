import { useMemo, useRef, useState } from "react";
import { ShieldCheck, Loader2, AlertCircle, Undo2, ExternalLink } from "lucide-react";
import type { Quote, Token } from "../types";
import { SOURCE_TOKEN, DESTINATION_TOKENS } from "../mocks/tokens";
import { fromBaseUnits } from "../lib/oneclick";
import { formatAmount, formatUsd } from "../lib/format";
import { shapeForChain } from "../lib/addresses";
import { newSwapId, refundMailbox } from "../lib/anonymizer";
import {
  ANONYMIZER_ADDRESS,
  CHAIN,
  RECEIVER_CLASS_HASH,
  truncateAddress,
} from "../lib/chain";
import { useQuote } from "../hooks/useQuote";
import { useWallet } from "../hooks/useWallet";
import { useWithdrawSubmit } from "../hooks/useWithdrawSubmit";
import { AmountInput } from "./AmountInput";
import { TokenSelector } from "./TokenSelector";
import { SettingsMenu } from "./SettingsMenu";
import { QuoteDetails } from "./QuoteDetails";

const DEFAULT_TO: Token = DESTINATION_TOKENS[0]!;

export function WithdrawForm() {
  const fromToken = SOURCE_TOKEN;
  const { status: walletStatus } = useWallet();
  const [toToken, setToToken] = useState<Token>(DEFAULT_TO);
  const [fromAmount, setFromAmount] = useState<string>("");
  const [destinationAddress, setDestinationAddress] = useState<string>("");
  const [slippageBps, setSlippageBps] = useState<number>(50);

  const parsedAmount = useMemo(() => {
    const n = Number.parseFloat(fromAmount);
    return Number.isFinite(n) ? n : 0;
  }, [fromAmount]);

  // One swap_id per mount. Anchors the deterministic refund mailbox the
  // 1Click quote is keyed against. Pool's refund open note is bound 1:1 to it.
  const sessionUser =
    walletStatus.kind === "connected" ? walletStatus.address : "0x1";
  const swapIdRef = useRef<string | null>(null);
  if (swapIdRef.current === null) {
    swapIdRef.current = newSwapId(sessionUser, Date.now());
  }
  const swapId = swapIdRef.current;

  const refundMbx = useMemo(
    () =>
      refundMailbox(
        {
          anonymizerAddress: ANONYMIZER_ADDRESS,
          receiverClassHash: RECEIVER_CLASS_HASH,
        },
        swapId,
      ),
    [swapId],
  );

  const quoteState = useQuote({
    from: fromToken,
    to: toToken,
    amount: parsedAmount,
    slippageBps,
    refundTo: refundMbx,
  });

  const quote: Quote | null = useMemo(() => {
    if (quoteState.kind !== "ready") return null;
    const q = quoteState.quote;
    const outAmount = fromBaseUnits(q.amountOut, toToken.decimals);
    return {
      inAmount: parsedAmount,
      outAmount,
      inUsd: q.amountInUsd,
      outUsd: q.amountOutUsd,
      rate: q.rate,
      networkFeeUsd: Math.max(0, q.amountInUsd - q.amountOutUsd),
      slippageBps: q.slippageBps,
      routeLabel: q.routeLabel,
      deadlineSeconds: 150,
    };
  }, [quoteState, parsedAmount, toToken.decimals]);

  const shieldedBalance = fromToken.shieldedBalance ?? 0;
  const overBalance = parsedAmount > shieldedBalance;
  const addressShape = shapeForChain(toToken.chainTag);
  const addressError = addressShape.validate(destinationAddress);
  const addressMissing = destinationAddress.trim().length === 0;

  const submitDriver = useWithdrawSubmit({
    fromToken,
    toToken,
    fromAmount: parsedAmount,
    destinationAddress,
    slippageBps,
    swapId,
  });

  type CtaState =
    | "empty"
    | "loading"
    | "overdraw"
    | "unsupported"
    | "error"
    | "address-needed"
    | "address-invalid"
    | "ready"
    | "submitting"
    | "awaiting-signature"
    | "sent"
    | "submit-error";

  const ctaFromSubmit: CtaState | null =
    submitDriver.state.kind === "quoting" || submitDriver.state.kind === "composing"
      ? "submitting"
      : submitDriver.state.kind === "awaiting-signature"
        ? "awaiting-signature"
        : submitDriver.state.kind === "sent"
          ? "sent"
          : submitDriver.state.kind === "error"
            ? "submit-error"
            : null;

  const ctaState: CtaState =
    ctaFromSubmit ??
    (!parsedAmount
      ? "empty"
      : overBalance
        ? "overdraw"
        : quoteState.kind === "loading"
          ? "loading"
          : quoteState.kind === "unsupported"
            ? "unsupported"
            : quoteState.kind === "error"
              ? "error"
              : quoteState.kind === "ready"
                ? addressMissing
                  ? "address-needed"
                  : addressError
                    ? "address-invalid"
                    : "ready"
                : "empty");

  const outputDisplay =
    quote != null
      ? formatAmount(quote.outAmount, 8)
      : quoteState.kind === "loading"
        ? "—"
        : "";

  return (
    <>
      <div className="mb-3 flex items-center justify-end">
        <SettingsMenu slippageBps={slippageBps} onChange={setSlippageBps} />
      </div>
      <div className="space-y-2">
        <ShieldedSourcePanel
          token={fromToken}
          amount={fromAmount}
          onAmount={setFromAmount}
          usd={parsedAmount * fromToken.usdPrice}
          balance={shieldedBalance}
          onMax={() =>
            setFromAmount(shieldedBalance > 0 ? String(shieldedBalance) : "")
          }
        />

        <RouteDivider />

        <PublicDestPanel
          token={toToken}
          onSelectToken={setToToken}
          amount={outputDisplay}
          usd={quote?.outUsd ?? 0}
          loading={quoteState.kind === "loading"}
        />

        <DestinationAddressInput
          chainName={toToken.chain}
          placeholder={addressShape.placeholder}
          hint={addressShape.hint}
          value={destinationAddress}
          onChange={setDestinationAddress}
          error={destinationAddress.trim() ? addressError : null}
        />

        <RefundSafetyNote refundMailbox={refundMbx} />
      </div>

      {quote ? (
        <div className="mt-3">
          <QuoteDetails
            quote={quote}
            fromToken={fromToken}
            toToken={toToken}
          />
        </div>
      ) : null}

      <button
        type="button"
        disabled={ctaState !== "ready" && ctaState !== "submit-error" && ctaState !== "sent"}
        onClick={() => {
          if (ctaState === "submit-error" || ctaState === "sent") {
            submitDriver.reset();
            return;
          }
          if (ctaState === "ready") {
            void submitDriver.submit();
          }
        }}
        className={`mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold tracking-tight transition focus-ring ${
          ctaState === "ready"
            ? "bg-accent text-accent-foreground shadow-accent hover:bg-accent-hover"
            : ctaState === "sent"
              ? "bg-accent/15 text-accent"
              : ctaState === "overdraw" ||
                  ctaState === "error" ||
                  ctaState === "submit-error" ||
                  ctaState === "address-invalid"
                ? "bg-danger/10 text-danger"
                : "bg-surface-muted text-foreground-subtle"
        }`}
      >
        {ctaState === "loading" ||
        ctaState === "submitting" ||
        ctaState === "awaiting-signature" ? (
          <Loader2 size={16} className="animate-spin" />
        ) : null}
        {ctaCopy(ctaState, fromToken.symbol, toToken.symbol, toToken.chain)}
      </button>
      {quoteState.kind === "error" ? (
        <p className="mt-2 text-center text-xs text-danger/80">
          {quoteState.message}
        </p>
      ) : null}
      {submitDriver.state.kind === "error" ? (
        <p className="mt-2 text-center text-xs text-danger/80">
          {submitDriver.state.message}
        </p>
      ) : null}
      {submitDriver.state.kind === "sent" ? (
        <a
          className="mt-2 flex items-center justify-center gap-1 text-center text-xs text-accent/90 hover:text-accent"
          href={`${CHAIN.explorerBase}/tx/${submitDriver.state.txHash}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span className="font-mono">{truncateAddress(submitDriver.state.txHash, 10, 6)}</span>
          <ExternalLink size={11} />
        </a>
      ) : null}
    </>
  );
}

function ctaCopy(
  state:
    | "empty"
    | "loading"
    | "overdraw"
    | "unsupported"
    | "error"
    | "address-needed"
    | "address-invalid"
    | "ready"
    | "submitting"
    | "awaiting-signature"
    | "sent"
    | "submit-error",
  fromSymbol: string,
  toSymbol: string,
  toChain: string,
): string {
  switch (state) {
    case "empty":
      return "Enter an amount";
    case "loading":
      return "Fetching quote…";
    case "overdraw":
      return `Insufficient shielded ${fromSymbol}`;
    case "unsupported":
      return `${fromSymbol} → ${toSymbol} not supported by NEAR Intents`;
    case "error":
      return "Quote unavailable";
    case "address-needed":
      return `Add ${toChain} destination address`;
    case "address-invalid":
      return `Invalid ${toChain} address`;
    case "ready":
      return "Review withdraw";
    case "submitting":
      return "Composing pool transaction…";
    case "awaiting-signature":
      return "Waiting for wallet signature…";
    case "sent":
      return "Withdraw submitted — tap to reset";
    case "submit-error":
      return "Submission failed — tap to retry";
  }
}

function ShieldedSourcePanel({
  token,
  amount,
  onAmount,
  usd,
  balance,
  onMax,
}: {
  token: Token;
  amount: string;
  onAmount: (v: string) => void;
  usd: number;
  balance: number;
  onMax: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4 transition focus-within:border-border-strong">
      <div className="mb-2 flex items-center justify-between text-xs text-foreground-muted">
        <span className="inline-flex items-center gap-1.5">
          From
          <span className="inline-flex items-center gap-1 rounded-pill bg-pool-ink px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">
            <ShieldCheck size={9} />
            Shielded
          </span>
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono tabular-nums text-foreground-muted">
            {balance.toLocaleString("en-US", { maximumFractionDigits: 4 })}{" "}
            {token.symbol}
          </span>
          <button
            type="button"
            onClick={onMax}
            className="rounded-pill border border-border bg-surface-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent transition hover:border-accent/40 hover:bg-accent/10"
          >
            Max
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <AmountInput value={amount} onChange={onAmount} />
        </div>
        <TokenSelector token={token} locked />
      </div>
      <div className="mt-2 text-xs text-foreground-subtle">
        <span className="font-mono tabular-nums">{formatUsd(usd)}</span>
      </div>
    </div>
  );
}

function PublicDestPanel({
  token,
  onSelectToken,
  amount,
  usd,
  loading,
}: {
  token: Token;
  onSelectToken: (t: Token) => void;
  amount: string;
  usd: number;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4 transition focus-within:border-border-strong">
      <div className="mb-2 flex items-center justify-between text-xs text-foreground-muted">
        <span>To</span>
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground-muted">
          public · {token.chain}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <AmountInput value={amount} readOnly />
          {loading ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 right-12 animate-shimmer rounded-md bg-[linear-gradient(110deg,transparent_35%,rgba(255,255,255,0.06)_50%,transparent_65%)] bg-[length:200%_100%]"
            />
          ) : null}
        </div>
        <TokenSelector token={token} onSelect={onSelectToken} />
      </div>
      <div className="mt-2 text-xs text-foreground-subtle">
        <span className="font-mono tabular-nums">{formatUsd(usd)}</span>
      </div>
    </div>
  );
}

function DestinationAddressInput({
  chainName,
  placeholder,
  hint,
  value,
  onChange,
  error,
}: {
  chainName: string;
  placeholder: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  return (
    <div
      className={`rounded-2xl border bg-surface/50 p-4 transition focus-within:border-border-strong ${
        error ? "border-danger/40" : "border-border"
      }`}
    >
      <div className="mb-2 flex items-center justify-between text-xs text-foreground-muted">
        <span>{chainName} destination address</span>
        {error ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-danger">
            <AlertCircle size={11} />
            {error}
          </span>
        ) : null}
      </div>
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent font-mono text-sm tabular-nums tracking-tight text-foreground placeholder:text-foreground-subtle/70 focus:outline-none"
      />
      {!error ? (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-foreground-subtle">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function RouteDivider() {
  return (
    <div className="relative flex items-center justify-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-pill border border-border bg-surface-elevated px-2.5 py-0.5 text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
        via NEAR Intents · 1Click
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function RefundSafetyNote({ refundMailbox }: { refundMailbox: string }) {
  return (
    <div className="rounded-2xl border border-border bg-pool-ink/30 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Undo2 size={11} />
        </span>
        <div className="text-[11px] leading-relaxed text-foreground-muted">
          <div className="font-medium text-foreground">
            Refund-safe via the anonymizer
          </div>
          <p className="mt-0.5">
            If NEAR Intents fails to settle, STRK lands at your per-swap refund
            mailbox{" "}
            <span className="font-mono text-foreground-subtle">
              {truncateAddress(refundMailbox, 8, 6)}
            </span>{" "}
            and anyone can call <code className="text-accent">recover()</code>{" "}
            to credit it back to your shielded balance as a fresh note. No
            public on-chain landing.
          </p>
        </div>
      </div>
    </div>
  );
}
