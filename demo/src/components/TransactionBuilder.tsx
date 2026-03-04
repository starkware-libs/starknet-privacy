import { useState, useRef, type FormEvent } from "react";
import type { AccountConfig } from "../config.ts";

export type OperationType = "deposit" | "transfer" | "withdraw" | "surplus" | "invoke";

const PHASE_ORDER: Record<OperationType, number> = {
  deposit: 3,
  transfer: 5,
  withdraw: 6,
  surplus: 7,
  invoke: 8,
};

const OPERATION_LABELS: Record<OperationType, string> = {
  deposit: "Deposit",
  transfer: "Transfer",
  withdraw: "Withdraw",
  surplus: "Surplus To",
  invoke: "Invoke",
};

export type BuilderOperation = {
  id: number;
  operationType: OperationType;
  amount: string;
  recipient?: string;
  withdrawSurplus?: boolean;
  contractAddress?: string;
  calldata?: string;
};

type Props = {
  pending: boolean;
  activeAddress: string;
  otherAccounts: AccountConfig[];
  onExecute: (operations: BuilderOperation[]) => void;
};

export function TransactionBuilder({ pending, activeAddress, otherAccounts, onExecute }: Props) {
  const [operations, setOperations] = useState<BuilderOperation[]>([]);
  const [selectedType, setSelectedType] = useState<OperationType>("deposit");
  const [amount, setAmount] = useState("100");
  const [recipient, setRecipient] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [calldata, setCalldata] = useState("");
  const [withdrawSurplus, setWithdrawSurplus] = useState(false);
  const nextOperationId = useRef(0);

  const hasInvoke = operations.some((op) => op.operationType === "invoke");
  const hasSurplus = operations.some((op) => op.operationType === "surplus");

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    const needsRecipient =
      selectedType === "transfer" || selectedType === "surplus" ||
      ((selectedType === "deposit" || selectedType === "withdraw") && recipient);

    const operation: BuilderOperation = {
      id: nextOperationId.current++,
      operationType: selectedType,
      amount,
      ...(needsRecipient ? { recipient } : {}),
      ...(selectedType === "surplus" ? { withdrawSurplus } : {}),
      ...(selectedType === "invoke"
        ? { contractAddress, calldata }
        : {}),
    };

    setOperations((previous) => {
      const updated = [...previous, operation];
      updated.sort(
        (a, b) => PHASE_ORDER[a.operationType] - PHASE_ORDER[b.operationType],
      );
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
    if (operation.operationType === "invoke") {
      return `${operation.contractAddress?.slice(0, 10)}...`;
    }
    if (operation.operationType === "surplus") {
      const target = operation.recipient
        ? `${operation.recipient.slice(0, 10)}...`
        : "self";
      return `→ ${target}${operation.withdrawSurplus ? " (withdraw)" : ""}`;
    }
    const details = `${operation.amount} STRK`;
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
          <option value="surplus" disabled={hasSurplus}>Surplus To</option>
          <option value="invoke" disabled={hasInvoke}>Invoke</option>
        </select>

        {selectedType !== "invoke" && selectedType !== "surplus" && (
          <input
            type="number"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Amount"
            min="1"
          />
        )}

        {(selectedType === "transfer" || selectedType === "surplus" ||
          selectedType === "deposit" || selectedType === "withdraw") && (
          <select
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          >
            {selectedType === "transfer" || selectedType === "surplus" ? (
              <option value="">Select recipient...</option>
            ) : (
              <option value="">None (set surplus recipient)</option>
            )}
            <option value={activeAddress}>
              Self ({activeAddress.slice(0, 10)}...)
            </option>
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

        {selectedType === "invoke" && (
          <>
            <input
              type="text"
              value={contractAddress}
              onChange={(event) => setContractAddress(event.target.value)}
              placeholder="Contract address (0x...)"
            />
            <input
              type="text"
              value={calldata}
              onChange={(event) => setCalldata(event.target.value)}
              placeholder="Calldata (comma-separated)"
            />
          </>
        )}

        <button
          type="submit"
          disabled={
            pending ||
            (selectedType === "invoke" && hasInvoke) ||
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

      <button
        onClick={handleExecute}
        disabled={pending || operations.length === 0}
        style={{ marginTop: "8px", width: "100%" }}
      >
        Execute Transaction ({operations.length} ops)
      </button>
    </>
  );
}
