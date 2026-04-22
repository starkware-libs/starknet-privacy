import { useState, useRef, type FormEvent } from "react";
import type { AccountConfig, TokenConfig } from "../config.ts";
import type { TokenBalance } from "../hooks/usePrivateState.ts";
import { formatAmount } from "../format.ts";

export type OperationType = "deposit" | "transfer" | "withdraw" | "surplus";

const PHASE_ORDER: Record<OperationType, number> = {
  deposit: 3,
  transfer: 5,
  withdraw: 6,
  surplus: 7,
};

const OPERATION_LABELS: Record<OperationType, string> = {
  deposit: "Deposit",
  transfer: "Transfer",
  withdraw: "Withdraw",
  surplus: "Surplus To",
};

export type BuilderOperation = {
  id: number;
  operationType: OperationType;
  amount: string;
  token?: string;
  recipient?: string;
  withdrawSurplus?: boolean;
};

type Props = {
  pending: boolean;
  sendCapable: boolean;
  activeAddress: string;
  otherAccounts: AccountConfig[];
  tokens: TokenConfig[];
  tokenBalances: TokenBalance[];
  onExecute: (operations: BuilderOperation[]) => void;
};

export function TransactionBuilder({
  pending,
  sendCapable,
  activeAddress,
  otherAccounts,
  tokens,
  tokenBalances,
  onExecute,
}: Props) {
  const disabledTitle = sendCapable ? undefined : "View-only — connect a wallet to send";
  const defaultToken = tokens[0]?.address ?? "";
  const [operations, setOperations] = useState<BuilderOperation[]>([]);
  const [selectedType, setSelectedType] = useState<OperationType>("deposit");
  const [amount, setAmount] = useState("100");
  const [token, setToken] = useState(defaultToken);
  const [recipient, setRecipient] = useState("");
  const [withdrawSurplus, setWithdrawSurplus] = useState(false);
  const nextOperationId = useRef(0);

  const hasSurplus = operations.some((op) => op.operationType === "surplus");

  const tokenNameByAddress = new Map(tokens.map((t) => [t.address, t.name]));
  const needsToken =
    selectedType === "deposit" || selectedType === "transfer" || selectedType === "withdraw";

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    const needsRecipient =
      selectedType === "transfer" ||
      selectedType === "surplus" ||
      ((selectedType === "deposit" || selectedType === "withdraw") && recipient);

    const operation: BuilderOperation = {
      id: nextOperationId.current++,
      operationType: selectedType,
      amount,
      ...(needsToken ? { token } : {}),
      ...(needsRecipient ? { recipient } : {}),
      ...(selectedType === "surplus" ? { withdrawSurplus } : {}),
    };

    setOperations((previous) => {
      const updated = [...previous, operation];
      updated.sort((a, b) => PHASE_ORDER[a.operationType] - PHASE_ORDER[b.operationType]);
      return updated;
    });
  }

  function handleRemove(operationId: number) {
    setOperations((previous) => previous.filter((op) => op.id !== operationId));
  }

  function handleExecute() {
    onExecute(operations);
  }

  function formatOperationDetails(operation: BuilderOperation): string {
    if (operation.operationType === "surplus") {
      const target = operation.recipient ? `${operation.recipient.slice(0, 10)}...` : "self";
      return `→ ${target}${operation.withdrawSurplus ? " (withdraw)" : ""}`;
    }
    const tokenName = operation.token ? (tokenNameByAddress.get(operation.token) ?? "?") : "?";
    const details = `${operation.amount} ${tokenName}`;
    if (operation.recipient) {
      return `${details} → ${operation.recipient.slice(0, 10)}...`;
    }
    return details;
  }

  return (
    <>
      <h2>Transaction Builder</h2>

      <form onSubmit={handleAdd} className="builder-add">
        <select
          value={selectedType}
          onChange={(event) => setSelectedType(event.target.value as OperationType)}
        >
          <option value="deposit">Deposit</option>
          <option value="transfer">Transfer</option>
          <option value="withdraw">Withdraw</option>
          <option value="surplus" disabled={hasSurplus}>
            Surplus To
          </option>
        </select>

        {needsToken && (
          <select value={token} onChange={(event) => setToken(event.target.value)}>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.name}
              </option>
            ))}
          </select>
        )}

        {selectedType !== "surplus" && (
          <span className="amount-with-max">
            <input
              type="number"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="Amount"
              min="0"
              step="any"
            />
            {(selectedType === "transfer" ||
              selectedType === "withdraw" ||
              selectedType === "deposit") && (
              <button
                type="button"
                className="max-link"
                disabled={pending}
                onClick={() => {
                  if (!token) return;
                  const target = BigInt(token);
                  const tokenBalance = tokenBalances.find(
                    (tb) => BigInt(tb.address) === target
                  );
                  if (!tokenBalance) return;
                  const balance =
                    selectedType === "deposit" ? tokenBalance.transparent : tokenBalance.private;
                  const decimals = tokens.find((t) => t.address === token)?.decimals ?? 18;
                  setAmount(formatAmount(balance, decimals));
                }}
              >
                Max
              </button>
            )}
          </span>
        )}

        {(selectedType === "transfer" ||
          selectedType === "surplus" ||
          selectedType === "deposit" ||
          selectedType === "withdraw") && (
          <select value={recipient} onChange={(event) => setRecipient(event.target.value)}>
            {selectedType === "transfer" || selectedType === "surplus" ? (
              <option value="">Select recipient...</option>
            ) : (
              <option value="">None (set surplus recipient)</option>
            )}
            <option value={activeAddress}>Self ({activeAddress.slice(0, 10)}...)</option>
            {otherAccounts.map((account) => (
              <option key={account.address} value={account.address}>
                {account.name} ({account.address.slice(0, 10)}...)
              </option>
            ))}
          </select>
        )}

        {selectedType === "surplus" && (
          <label className="builder-checkbox">
            <input
              type="checkbox"
              checked={withdrawSurplus}
              onChange={(event) => setWithdrawSurplus(event.target.checked)}
            />
            Withdraw
          </label>
        )}

        <button
          type="submit"
          disabled={
            pending ||
            (selectedType === "surplus" && hasSurplus) ||
            ((selectedType === "transfer" || selectedType === "surplus") && !recipient)
          }
        >
          Add
        </button>
      </form>

      {operations.length === 0 ? (
        <p className="empty">No actions added</p>
      ) : (
        <div>
          {operations.map((operation) => (
            <div key={operation.id} className="builder-operation">
              <span className="chip">{OPERATION_LABELS[operation.operationType]}</span>
              <span>{formatOperationDetails(operation)}</span>
              <button
                className="remove-button"
                onClick={() => handleRemove(operation.id)}
                disabled={pending}
              >
                x
              </button>
            </div>
          ))}
          {!hasSurplus && (
            <div className="builder-operation" style={{ opacity: 0.5 }}>
              <span className="chip">Surplus To</span>
              <span>→ self</span>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "4px", marginTop: "8px" }}>
        <button
          onClick={handleExecute}
          disabled={pending || !sendCapable || operations.length === 0}
          style={{ flex: 1 }}
          title={disabledTitle}
        >
          {pending && <span className="spinner" />}
          Execute ({operations.length} ops)
        </button>
        {operations.length > 0 && (
          <button
            className="builder-clear-button"
            onClick={() => setOperations([])}
            disabled={pending}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}
