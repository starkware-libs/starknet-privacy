import { useState, type FormEvent } from "react";
import type { AccountConfig } from "../config.ts";
import { toRawAmount } from "../format.ts";

type Props = {
  pending: boolean;
  activeAddress: string;
  otherAccounts: AccountConfig[];
  tokenDecimals: number;
  onRegister: () => void;
  onMint: (amount: bigint) => void;
  onDeposit: (amount: bigint) => void;
  onWithdraw: (amount: bigint) => void;
  onTransfer: (recipient: string, amount: bigint) => void;
};

export function ActionPanel({
  pending,
  activeAddress,
  otherAccounts,
  tokenDecimals,
  onRegister,
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

  const parseAmount = (value: string) => toRawAmount(value, tokenDecimals);

  function handleMint(event: FormEvent) {
    event.preventDefault();
    onMint(parseAmount(mintAmount));
  }

  function handleDeposit(event: FormEvent) {
    event.preventDefault();
    onDeposit(parseAmount(depositAmount));
  }

  function handleWithdraw(event: FormEvent) {
    event.preventDefault();
    onWithdraw(parseAmount(withdrawAmount));
  }

  function handleTransfer(event: FormEvent) {
    event.preventDefault();
    if (!transferRecipient) return;
    onTransfer(transferRecipient, parseAmount(transferAmount));
  }

  return (
    <>
      <h2>Actions</h2>

      <form onSubmit={handleMint} className="action-form">
        <h3>Mint tokens (transparent)</h3>
        <input
          type="text"
          inputMode="decimal"
          value={mintAmount}
          onChange={(event) => setMintAmount(event.target.value)}
          placeholder="Amount"
        />
        <button type="submit" disabled={pending}>
          Mint
        </button>
      </form>

      <div className="action-form">
        <h3>Register in the pool</h3>
        <button type="button" disabled={pending} onClick={onRegister}>
          Register
        </button>
      </div>

      <form onSubmit={handleDeposit} className="action-form">
        <h3>Deposit to self (auto setup)</h3>
        <input
          type="text"
          inputMode="decimal"
          value={depositAmount}
          onChange={(event) => setDepositAmount(event.target.value)}
          placeholder="Amount"
        />
        <button type="submit" disabled={pending}>
          Deposit
        </button>
      </form>

      <form onSubmit={handleWithdraw} className="action-form">
        <h3>Withdraw to self</h3>
        <input
          type="text"
          inputMode="decimal"
          value={withdrawAmount}
          onChange={(event) => setWithdrawAmount(event.target.value)}
          placeholder="Amount"
        />
        <button type="submit" disabled={pending}>
          Withdraw
        </button>
      </form>

      <form onSubmit={handleTransfer} className="action-form">
        <h3>Transfer to someone (or sweep)</h3>
        <select
          value={transferRecipient}
          onChange={(event) => setTransferRecipient(event.target.value)}
        >
          <option value="">Select recipient...</option>
          <option value={activeAddress}>
            Self ({activeAddress.slice(0, 10)}...)
          </option>
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
          type="text"
          inputMode="decimal"
          value={transferAmount}
          onChange={(event) => setTransferAmount(event.target.value)}
          placeholder="Amount"
        />
        <button
          type="submit"
          disabled={pending || !transferRecipient || transferRecipient === "custom"}
        >
          Transfer
        </button>
      </form>
    </>
  );
}
