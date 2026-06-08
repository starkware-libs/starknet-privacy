import { useCallback, useMemo, useRef, useState } from "react";
import {
  ShieldCheck,
  Loader2,
  ArrowRight,
  CheckCircle2,
  Wallet,
  Plug,
  AlertTriangle,
} from "lucide-react";
import type { Quote, Token } from "../types";
import { SOURCE_TOKEN, DESTINATION_TOKENS } from "../mocks/tokens";
import { fromBaseUnits, toBaseUnits } from "../lib/oneclick";
import { formatAmount, formatUsd } from "../lib/format";
import { newSwapId, outputMailbox } from "../lib/anonymizer";
import {
  ANONYMIZER_ADDRESS,
  RECEIVER_CLASS_HASH,
  truncateAddress,
} from "../lib/chain";
import { useQuote } from "../hooks/useQuote";
import { useWallet } from "../hooks/useWallet";
import { useSourceWallet } from "../hooks/useSourceWallet";
import { useEthSend } from "../hooks/useEthSend";
import { useSolanaSend } from "../hooks/useSolanaSend";
import { useOneClickStatus } from "../hooks/useOneClickStatus";
import { AmountInput } from "./AmountInput";
import { TokenSelector } from "./TokenSelector";
import { SettingsMenu } from "./SettingsMenu";
import { QuoteDetails } from "./QuoteDetails";
import { DepositProgress } from "./DepositProgress";

const DEFAULT_FROM: Token = DESTINATION_TOKENS[0]!;

export function DepositForm() {
  const toToken = SOURCE_TOKEN;
  const { status: walletStatus, identity } = useWallet();
  const [fromToken, setFromToken] = useState<Token>(DEFAULT_FROM);
  const [fromAmount, setFromAmount] = useState<string>("");
  const [slippageBps, setSlippageBps] = useState<number>(50);
  const sourceWallet = useSourceWallet(fromToken.chainTag);

  const parsedAmount = useMemo(() => {
    const n = Number.parseFloat(fromAmount);
    return Number.isFinite(n) ? n : 0;
  }, [fromAmount]);

  const sessionUser =
    walletStatus.kind === "connected" ? walletStatus.address : "0x1";
  const swapIdRef = useRef<string | null>(null);
  if (swapIdRef.current === null) {
    swapIdRef.current = newSwapId(sessionUser, Date.now());
  }
  const swapId = swapIdRef.current;

  // Output mailbox: where NEAR Intents will deliver STRK on Starknet so the
  // anonymizer's `finalize(swap_id)` can sweep it into the user's open note.
  const outputMbx = useMemo(
    () =>
      outputMailbox(
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
    recipient: outputMbx,
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

  const walletConnected = walletStatus.kind === "connected";
  const identityReady = identity.kind === "ready";
  const sourceReady =
    sourceWallet.kind === "copy-paste" || sourceWallet.connected;

  // Send hooks fire one-shot from their idle state. Both stay mounted so the
  // status panel can read the in-flight signature / tx hash / deposit address
  // regardless of which chain the user picked.
  const ethSend = useEthSend();
  const solSend = useSolanaSend();

  const { txReference, depositAddress, sendInFlight, sendError } =
    useMemo(() => {
      if (sourceWallet.kind === "evm") {
        const status = ethSend.status;
        return {
          txReference: status.kind === "sent" ? status.txHash : null,
          depositAddress:
            status.kind === "sent" || status.kind === "awaiting-signature"
              ? status.depositAddress
              : null,
          sendInFlight:
            status.kind === "quoting" || status.kind === "awaiting-signature",
          sendError: status.kind === "error" ? status.message : null,
        };
      }
      if (sourceWallet.kind === "solana") {
        const status = solSend.status;
        return {
          txReference: status.kind === "sent" ? status.signature : null,
          depositAddress:
            status.kind === "sent" || status.kind === "awaiting-signature"
              ? status.depositAddress
              : status.kind === "error"
                ? (status.depositAddress ?? null)
                : null,
          sendInFlight:
            status.kind === "quoting" || status.kind === "awaiting-signature",
          sendError: status.kind === "error" ? status.message : null,
        };
      }
      return {
        txReference: null,
        depositAddress: null,
        sendInFlight: false,
        sendError: null,
      };
    }, [sourceWallet.kind, ethSend.status, solSend.status]);

  // Once the source-chain tx is broadcast we have a deposit address and can
  // poll 1Click for settlement. Polling pauses while `depositAddress` is null.
  const oneClickStatus = useOneClickStatus({ depositAddress });

  type CtaState =
    | "empty"
    | "loading"
    | "unsupported"
    | "error"
    | "connect-wallet"
    | "setup-identity"
    | "connect-source"
    | "sending"
    | "ready";

  const ctaState: CtaState = !parsedAmount
    ? "empty"
    : quoteState.kind === "loading"
      ? "loading"
      : quoteState.kind === "unsupported"
        ? "unsupported"
        : quoteState.kind === "error"
          ? "error"
          : quoteState.kind === "ready"
            ? !walletConnected
              ? "connect-wallet"
              : !identityReady
                ? "setup-identity"
                : !sourceReady
                  ? "connect-source"
                  : sendInFlight
                    ? "sending"
                    : "ready"
            : "empty";

  const outputDisplay =
    quote != null
      ? formatAmount(quote.outAmount, 4)
      : quoteState.kind === "loading"
        ? "—"
        : "";

  const handleDeposit = useCallback(async () => {
    if (ctaState !== "ready") return;
    const amountIn = toBaseUnits(parsedAmount, fromToken.decimals);
    const refundTo = sourceWallet.address;
    if (!refundTo) return;

    // TODO: insert the Starknet "setup tx" here once register_inbound and
    // CreateOpenNote land. The anonymizer needs an open note registered before
    // the source-chain deposit so `finalize(swap_id)` can sweep STRK from the
    // mailbox into it. For the demo we skip straight to the source-chain send.

    if (sourceWallet.kind === "evm") {
      await ethSend.send({
        fromToken,
        toToken,
        amountIn,
        refundTo,
        recipient: outputMbx,
        slippageBps,
      });
      return;
    }
    if (sourceWallet.kind === "solana") {
      try {
        await solSend.send({
          fromToken,
          toToken,
          amountIn,
          refundTo,
          recipient: outputMbx,
          slippageBps,
        });
      } catch {
        // The hook already reflected the error into status; swallow so we
        // don't get an unhandled rejection logged in the console.
      }
    }
  }, [
    ctaState,
    parsedAmount,
    fromToken,
    sourceWallet.address,
    sourceWallet.kind,
    ethSend,
    solSend,
    toToken,
    outputMbx,
    slippageBps,
  ]);

  const handleReset = useCallback(() => {
    ethSend.reset();
    solSend.reset();
  }, [ethSend, solSend]);

  const showProgress = txReference != null || sendInFlight;

  return (
    <>
      <div className="mb-3 flex items-center justify-end">
        <SettingsMenu slippageBps={slippageBps} onChange={setSlippageBps} />
      </div>
      <div className="space-y-2">
        <PublicSourcePanel
          token={fromToken}
          onSelectToken={setFromToken}
          amount={fromAmount}
          onAmount={setFromAmount}
          usd={parsedAmount * fromToken.usdPrice}
          sourceWallet={sourceWallet}
        />

        <RouteDivider />

        <ShieldedDestPanel
          token={toToken}
          amount={outputDisplay}
          usd={quote?.outUsd ?? 0}
          loading={quoteState.kind === "loading"}
        />

        <AnonymizerDeliveryNote outputMailbox={outputMbx} />
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

      {showProgress ? (
        <DepositProgress
          txReference={txReference}
          sourceChainLabel={fromToken.chain}
          sourceTokenSymbol={fromToken.symbol}
          outputMailbox={outputMbx}
          executionStatus={oneClickStatus.executionStatus}
          onReset={handleReset}
        />
      ) : (
        <button
          type="button"
          disabled={ctaState !== "ready" && ctaState !== "sending"}
          onClick={() => void handleDeposit()}
          className={`mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold tracking-tight transition focus-ring ${
            ctaState === "ready" || ctaState === "sending"
              ? "bg-accent text-accent-foreground shadow-accent hover:bg-accent-hover"
              : ctaState === "error"
                ? "bg-danger/10 text-danger"
                : "bg-surface-muted text-foreground-subtle"
          }`}
        >
          {ctaState === "loading" || ctaState === "sending" ? (
            <Loader2 size={16} className="animate-spin" />
          ) : null}
          {ctaCopy(
            ctaState,
            fromToken.symbol,
            fromToken.chain,
            sourceWallet.walletLabel,
          )}
        </button>
      )}
      {quoteState.kind === "error" ? (
        <p className="mt-2 text-center text-xs text-danger/80">
          {quoteState.message}
        </p>
      ) : null}
      {sendError && !showProgress ? (
        <p className="mt-2 text-center text-xs text-danger/80">{sendError}</p>
      ) : null}
    </>
  );
}

function ctaCopy(
  state:
    | "empty"
    | "loading"
    | "unsupported"
    | "error"
    | "connect-wallet"
    | "setup-identity"
    | "connect-source"
    | "sending"
    | "ready",
  fromSymbol: string,
  fromChain: string,
  sourceWalletLabel: string,
): string {
  switch (state) {
    case "empty":
      return "Enter an amount";
    case "loading":
      return "Fetching quote…";
    case "unsupported":
      return `${fromSymbol} on ${fromChain} not supported`;
    case "error":
      return "Quote unavailable";
    case "connect-wallet":
      return "Connect Starknet wallet to deposit";
    case "setup-identity":
      return "Set up shielded identity";
    case "connect-source":
      return sourceWalletLabel === "copy-paste"
        ? `Prepare ${fromChain} deposit`
        : `Connect ${sourceWalletLabel}`;
    case "sending":
      return `Awaiting ${sourceWalletLabel}…`;
    case "ready":
      return `Prepare ${fromChain} deposit`;
  }
}

function PublicSourcePanel({
  token,
  onSelectToken,
  amount,
  onAmount,
  usd,
  sourceWallet,
}: {
  token: Token;
  onSelectToken: (t: Token) => void;
  amount: string;
  onAmount: (v: string) => void;
  usd: number;
  sourceWallet: ReturnType<typeof useSourceWallet>;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4 transition focus-within:border-border-strong">
      <div className="mb-3 flex items-center justify-between text-xs text-foreground-muted">
        <span>From your external wallet</span>
        <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-foreground-muted">
          public · {token.chain}
        </span>
      </div>

      <SourceWalletBar sourceWallet={sourceWallet} />

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex-1">
          <AmountInput value={amount} onChange={onAmount} />
        </div>
        <TokenSelector token={token} onSelect={onSelectToken} />
      </div>
      <div className="mt-2 text-xs text-foreground-subtle">
        <span className="font-mono tabular-nums">{formatUsd(usd)}</span>
      </div>
    </div>
  );
}

// Full-width prominent CTA above the amount input. The original tiny pill in
// the panel footer was easy to miss — this version is impossible to miss.
function SourceWalletBar({
  sourceWallet,
}: {
  sourceWallet: ReturnType<typeof useSourceWallet>;
}) {
  if (sourceWallet.kind === "copy-paste") {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface-muted/40 px-3 py-2.5 text-[11px] text-foreground-muted">
        Send the source asset manually from your wallet — this chain doesn't
        have a supported browser extension yet.
      </div>
    );
  }

  if (sourceWallet.connected && sourceWallet.address) {
    return (
      <button
        type="button"
        onClick={() => void sourceWallet.disconnect()}
        className="group flex w-full items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3 py-2.5 text-sm transition hover:border-accent/60 hover:bg-accent/15 focus-ring"
        title={`Disconnect ${sourceWallet.walletLabel}`}
      >
        <span className="inline-flex items-center gap-2 font-medium text-accent">
          <CheckCircle2 size={14} />
          {sourceWallet.walletLabel} connected
        </span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {truncateAddress(sourceWallet.address, 6, 4)}
        </span>
      </button>
    );
  }

  if (!sourceWallet.available) {
    const installUrl =
      sourceWallet.kind === "evm"
        ? "https://metamask.io/download/"
        : "https://phantom.app/download";
    return (
      <a
        href={installUrl}
        target="_blank"
        rel="noreferrer"
        className="flex w-full items-center justify-between rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm font-medium text-warn transition hover:border-warn/60 hover:bg-warn/15"
      >
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={14} />
          Install {sourceWallet.walletLabel}
        </span>
        <span className="text-[11px] uppercase tracking-wider">
          Required for this chain →
        </span>
      </a>
    );
  }

  const isConnecting = sourceWallet.status.kind === "connecting";
  return (
    <button
      type="button"
      onClick={() => void sourceWallet.connect()}
      disabled={isConnecting}
      className="flex w-full items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3 py-2.5 text-sm font-semibold text-accent transition hover:border-accent/60 hover:bg-accent/15 disabled:cursor-wait focus-ring"
    >
      <span className="inline-flex items-center gap-2">
        {isConnecting ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Plug size={14} />
        )}
        {isConnecting ? "Connecting…" : `Connect ${sourceWallet.walletLabel}`}
      </span>
      <span className="text-[11px] font-normal uppercase tracking-wider text-accent/80">
        Step 1 of 2 →
      </span>
    </button>
  );
}

function ShieldedDestPanel({
  token,
  amount,
  usd,
  loading,
}: {
  token: Token;
  amount: string;
  usd: number;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4 transition focus-within:border-border-strong">
      <div className="mb-2 flex items-center justify-between text-xs text-foreground-muted">
        <span className="inline-flex items-center gap-1.5">
          To
          <span className="inline-flex items-center gap-1 rounded-pill bg-pool-ink px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">
            <ShieldCheck size={9} />
            Shielded
          </span>
        </span>
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
          Privacy pool
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
        <TokenSelector token={token} locked />
      </div>
      <div className="mt-2 text-xs text-foreground-subtle">
        <span className="font-mono tabular-nums">{formatUsd(usd)}</span>
      </div>
    </div>
  );
}

function AnonymizerDeliveryNote({ outputMailbox }: { outputMailbox: string }) {
  return (
    <div className="rounded-2xl border border-border bg-pool-ink/30 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <ArrowRight size={11} />
        </span>
        <div className="text-[11px] leading-relaxed text-foreground-muted">
          <div className="font-medium text-foreground">
            Routed via the anonymizer
          </div>
          <p className="mt-0.5">
            STRK from NEAR Intents lands at your per-swap mailbox{" "}
            <span className="font-mono text-foreground-subtle">
              {truncateAddress(outputMailbox, 8, 6)}
            </span>
            ; anyone can call <code className="text-accent">finalize()</code>{" "}
            and the anonymizer fills your pre-created open note in the pool.
            Your Starknet wallet only signs the setup tx — the deposit itself
            happens from your Metamask / Phantom on the source chain.
          </p>
        </div>
      </div>
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

// Wallet icon imports kept available for the post-CTA "Send" panel — added
// when register_inbound lands so the user can sign the source-chain transfer
// from inside the app.
export { Wallet };
