import { useState, type FormEvent } from "react";
import type { AccountConfig } from "../config.ts";

type Props = {
  pending: boolean;
  otherAccounts: AccountConfig[];
  onMint: (amount: bigint) => void;
  onDeposit: (amount: bigint) => void;
  onWithdraw: (amount: bigint) => void;
  onTransfer: (recipient: string, amount: bigint) => void;
};

export function ActionPanel({
  pending,
  otherAccounts,
  onMint,
  onDeposit,
  onWithdraw,
  onTransfer,
}: Props) {
  const [mintAmount, setMintAmount] = useState("100");
  const [depositAmount, setDepositAmount] = useState("100");
  const [withdrawAmount, setWithdrawAmount] = useState("50");
  const [transferAmount, setTransferAmount] = useState("50");
  const [transferRecipient, setTransferRecipient] = useState("");

  function handleMint(event: FormEvent) {
    event.preventDefault();
    onMint(BigInt(mintAmount));
  }

  function handleDeposit(event: FormEvent) {
    event.preventDefault();
    onDeposit(BigInt(depositAmount));
  }

  function handleWithdraw(event: FormEvent) {
    event.preventDefault();
    onWithdraw(BigInt(withdrawAmount));
  }

  function handleTransfer(event: FormEvent) {
    event.preventDefault();
    if (!transferRecipient) return;
    onTransfer(transferRecipient, BigInt(transferAmount));
  }

  return (
    <div className="action-panel">
      <h2>Actions</h2>

      <form onSubmit={handleMint} className="action-form">
        <h3>Mint (admin)</h3>
        <input
          type="number"
          value={mintAmount}
          onChange={(event) => setMintAmount(event.target.value)}
          placeholder="Amount"
          min="1"
        />
        <button type="submit" disabled={pending}>
          Mint
        </button>
      </form>

      <form onSubmit={handleDeposit} className="action-form">
        <h3>Deposit</h3>
        <input
          type="number"
          value={depositAmount}
          onChange={(event) => setDepositAmount(event.target.value)}
          placeholder="Amount"
          min="1"
        />
        <button type="submit" disabled={pending}>
          Deposit
        </button>
      </form>

      <form onSubmit={handleWithdraw} className="action-form">
        <h3>Withdraw</h3>
        <input
          type="number"
          value={withdrawAmount}
          onChange={(event) => setWithdrawAmount(event.target.value)}
          placeholder="Amount"
          min="1"
        />
        <button type="submit" disabled={pending}>
          Withdraw
        </button>
      </form>

      <form onSubmit={handleTransfer} className="action-form">
        <h3>Transfer</h3>
        <select
          value={transferRecipient}
          onChange={(event) => setTransferRecipient(event.target.value)}
        >
          <option value="">Select recipient...</option>
          {otherAccounts.map((account) => (
            <option key={account.address} value={account.address}>
              {account.name} ({account.address.slice(0, 10)}...)
            </option>
          ))}
          <option value="custom">Custom address...</option>
        </select>
        {transferRecipient === "custom" && (
          <input
            type="text"
            value=""
            onChange={(event) => setTransferRecipient(event.target.value)}
            placeholder="Recipient address (0x...)"
          />
        )}
        <input
          type="number"
          value={transferAmount}
          onChange={(event) => setTransferAmount(event.target.value)}
          placeholder="Amount"
          min="1"
        />
        <button
          type="submit"
          disabled={pending || !transferRecipient || transferRecipient === "custom"}
        >
          Transfer
        </button>
      </form>
    </div>
  );
}
