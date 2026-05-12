import { Check, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { truncateAddress } from "../lib/chain";
import {
  isRefund,
  isSettling,
  type ExecutionStatus,
} from "../lib/oneclick-status";
import { GetExecutionStatusResponse } from "@defuse-protocol/one-click-sdk-typescript";

type StepState = "idle" | "active" | "done" | "failed";

interface Step {
  key: "sent" | "settling" | "delivered" | "claim";
  label: string;
}

const STEPS: readonly Step[] = [
  { key: "sent", label: "Source sent" },
  { key: "settling", label: "1Click settling" },
  { key: "delivered", label: "Output delivered" },
  { key: "claim", label: "Claim ready" },
];

export interface DepositProgressProps {
  /** Tx hash / signature for the source-chain transfer. */
  txReference: string | null;
  /** Source chain display label (e.g. "Ethereum", "Solana"). */
  sourceChainLabel: string;
  /** Source token symbol (for refund copy). */
  sourceTokenSymbol: string;
  /** Output mailbox address on Starknet. */
  outputMailbox: string;
  /** Latest 1Click execution status, or null until first poll lands. */
  executionStatus: ExecutionStatus | null;
  /** Reset the form back to the input view. */
  onReset: () => void;
  /** Hook into the (stubbed) claim step once we wire register_inbound. */
  onClaim?: () => void;
}

export function DepositProgress({
  txReference,
  sourceChainLabel,
  sourceTokenSymbol,
  outputMailbox,
  executionStatus,
  onReset,
  onClaim,
}: DepositProgressProps) {
  const refunded = executionStatus != null && isRefund(executionStatus);

  if (refunded) {
    return (
      <RefundPanel
        chainLabel={sourceChainLabel}
        tokenSymbol={sourceTokenSymbol}
        status={executionStatus}
        onReset={onReset}
      />
    );
  }

  const states = computeStates(executionStatus, txReference);
  const successStep = STEPS.findIndex((step) => step.key === "claim");
  const allDone = states[successStep] === "done";

  return (
    <div className="mt-4 space-y-4 rounded-2xl border border-border bg-surface/50 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">
          Deposit in progress
        </div>
        <StatusPill executionStatus={executionStatus} txReference={txReference} />
      </div>

      <StepperRow states={states} />

      <DetailRow
        label={`${sourceChainLabel} tx`}
        value={
          txReference
            ? truncateAddress(txReference, 8, 6)
            : "—"
        }
      />
      <DetailRow
        label="Output mailbox"
        value={truncateAddress(outputMailbox, 8, 6)}
      />

      <div className="flex gap-2">
        {allDone ? (
          <button
            type="button"
            onClick={onClaim}
            className="flex-1 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-accent transition hover:bg-accent-hover focus-ring"
          >
            Claim shielded note
          </button>
        ) : null}
        <button
          type="button"
          onClick={onReset}
          className="flex-1 rounded-xl border border-border bg-surface-muted px-4 py-2.5 text-sm font-medium text-foreground-muted transition hover:border-border-strong focus-ring"
        >
          {allDone ? "Start a new deposit" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function computeStates(
  executionStatus: ExecutionStatus | null,
  txReference: string | null,
): readonly StepState[] {
  // Step 0 — source tx is "sent" as soon as the wallet broadcast returns,
  // independent of 1Click's pickup latency.
  const sent: StepState = txReference ? "done" : "active";

  // Step 1 — settling covers every in-flight 1Click status; we only consider
  // it active once 1Click acknowledges the deposit (so the "settling" pulse
  // doesn't appear before the relayer has anything to do).
  const settling: StepState =
    executionStatus === GetExecutionStatusResponse.status.SUCCESS
      ? "done"
      : executionStatus != null && isSettling(executionStatus)
        ? "active"
        : txReference
          ? "active"
          : "idle";

  // Step 2 — terminal SUCCESS means STRK has landed at the output mailbox.
  const delivered: StepState =
    executionStatus === GetExecutionStatusResponse.status.SUCCESS
      ? "done"
      : "idle";

  // Step 3 — claim is gated on delivery. The actual relayer call is stubbed
  // until register_inbound lands; we surface a "ready" state for the CTA.
  const claim: StepState =
    executionStatus === GetExecutionStatusResponse.status.SUCCESS
      ? "done"
      : "idle";

  return [sent, settling, delivered, claim];
}

function StepperRow({ states }: { states: readonly StepState[] }) {
  return (
    <ol className="grid grid-cols-4 gap-2">
      {STEPS.map((step, idx) => {
        const state = states[idx] ?? "idle";
        const next = states[idx + 1];
        const connectorOn =
          state === "done" || (next !== undefined && next !== "idle");
        return (
          <li
            key={step.key}
            className="relative flex flex-col items-center text-center"
          >
            {idx < STEPS.length - 1 ? (
              <span
                aria-hidden
                className={`absolute left-1/2 top-3 h-px w-full ${
                  connectorOn ? "bg-accent/50" : "bg-border-strong"
                }`}
              />
            ) : null}

            <span
              className={`relative z-10 flex size-6 items-center justify-center rounded-full border ${
                state === "done"
                  ? "border-accent bg-accent text-accent-foreground"
                  : state === "active"
                    ? "border-accent bg-surface-elevated text-accent"
                    : "border-border-strong bg-surface-elevated text-foreground-subtle"
              }`}
            >
              {state === "done" ? (
                <Check size={12} strokeWidth={3} />
              ) : state === "active" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <span className="size-1 rounded-full bg-current" />
              )}
            </span>

            <span
              className={`mt-2 text-[11px] tracking-tight ${
                state === "idle"
                  ? "text-foreground-subtle"
                  : "text-foreground-muted"
              }`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusPill({
  executionStatus,
  txReference,
}: {
  executionStatus: ExecutionStatus | null;
  txReference: string | null;
}) {
  if (executionStatus === GetExecutionStatusResponse.status.SUCCESS) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-pool-ink px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-accent">
        <ShieldCheck size={11} />
        Settled
      </span>
    );
  }
  if (executionStatus != null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-accent">
        <Loader2 size={11} className="animate-spin" />
        {pillCopy(executionStatus)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-surface-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-foreground-muted">
      <Loader2 size={11} className="animate-spin" />
      {txReference ? "Awaiting pickup" : "Awaiting tx"}
    </span>
  );
}

function pillCopy(status: ExecutionStatus): string {
  switch (status) {
    case GetExecutionStatusResponse.status.KNOWN_DEPOSIT_TX:
      return "Deposit seen";
    case GetExecutionStatusResponse.status.PENDING_DEPOSIT:
      return "Pending deposit";
    case GetExecutionStatusResponse.status.INCOMPLETE_DEPOSIT:
      return "Incomplete deposit";
    case GetExecutionStatusResponse.status.PROCESSING:
      return "Processing";
    case GetExecutionStatusResponse.status.SUCCESS:
      return "Settled";
    case GetExecutionStatusResponse.status.REFUNDED:
      return "Refunded";
    case GetExecutionStatusResponse.status.FAILED:
      return "Failed";
  }
}

function RefundPanel({
  chainLabel,
  tokenSymbol,
  status,
  onReset,
}: {
  chainLabel: string;
  tokenSymbol: string;
  status: ExecutionStatus;
  onReset: () => void;
}) {
  const isFailed = status === GetExecutionStatusResponse.status.FAILED;
  return (
    <div className="mt-4 space-y-3 rounded-2xl border border-warn/40 bg-warn/10 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-warn" />
        <div className="text-sm font-semibold text-warn">
          {isFailed ? "Swap failed — funds refunded" : "Swap refunded"}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-foreground-muted">
        1Click refunded your {tokenSymbol} on {chainLabel}. No Starknet action
        needed — the refund went back to your source wallet.
      </p>
      <button
        type="button"
        onClick={onReset}
        className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-accent transition hover:bg-accent-hover focus-ring"
      >
        Start a new deposit
      </button>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-foreground-muted">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}
