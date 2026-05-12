import { useMemo, useState } from "react";
import type { TokenConfig } from "../../config.ts";
import type { TokenBalance } from "../../hooks/usePrivateState.ts";
import type { TransactionStatus } from "../../hooks/useTransactions.ts";
import { formatAmount, formatTokenAmount } from "../../format.ts";
import { Modal } from "../components/Modal.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { Icon } from "../components/Icon.tsx";
import { SuccessView } from "../components/SuccessView.tsx";

type Props = {
  open: boolean;
  onClose: () => void;
  tokens: TokenConfig[];
  balances: TokenBalance[];
  status: TransactionStatus;
  explorerUrl?: string;
  onDeposit: (token: string, amount: string) => void;
};

export function DepositModal({
  open,
  onClose,
  tokens,
  balances,
  status,
  explorerUrl,
  onDeposit,
}: Props) {
  const [armed, setArmed] = useState(false);
  const defaultToken =
    balances.find((tb) => tb.transparent > 0n)?.address ?? tokens[0]?.address ?? "";
  const [token, setToken] = useState(defaultToken);
  const [amount, setAmount] = useState("");

  const decimals = useMemo(
    () => tokens.find((entry) => entry.address === token)?.decimals ?? 18,
    [token, tokens]
  );
  const transparent =
    balances.find((tb) => BigInt(tb.address) === BigInt(token || "0x0"))?.transparent ?? 0n;

  function onMax() {
    setAmount(formatAmount(transparent, decimals));
  }

  function onSubmit() {
    if (!amount) return;
    setArmed(true);
    onDeposit(token, amount);
  }

  const succeeded = armed && !status.pending && Boolean(status.lastTxHash) && !status.lastError;
  if (succeeded && status.lastTxHash) {
    const tokenName = tokens.find((t) => t.address === token)?.name ?? "";
    return (
      <Modal open={open} onClose={onClose} title="Deposited">
        <SuccessView
          title="Tokens shielded"
          subtitle={`${amount} ${tokenName} is now inside the pool. Future activity is private.`}
          txHash={status.lastTxHash}
          explorerUrl={explorerUrl}
          onDone={onClose}
        />
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Deposit to pool">
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Move tokens from your public wallet balance into the shielded pool. Outside
        observers see the deposit value; once shielded, future activity is private.
      </p>

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
            Public balance:{" "}
            <span className="tabular" style={{ color: "var(--text-dim)" }}>
              {formatTokenAmount(transparent, decimals)}
            </span>
          </span>
        </div>
      </div>

      <button
        className="btn btn-primary btn-block"
        onClick={onSubmit}
        disabled={status.pending || !amount}
      >
        {status.pending ? (
          <>
            <span className="spinner" />
            {status.action ?? "Depositing"}
          </>
        ) : (
          <>
            <Icon.Plus size={15} />
            Deposit
          </>
        )}
      </button>
    </Modal>
  );
}
