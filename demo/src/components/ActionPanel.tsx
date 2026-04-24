import { useState, type FormEvent } from "react";
import type { AccountConfig, TokenConfig } from "../config.ts";
import type { TokenBalance } from "../hooks/usePrivateState.ts";
import { formatAmount } from "../format.ts";

type Props = {
  pending: boolean;
  pendingAction: string | null;
  sendCapable: boolean;
  activeAddress: string;
  otherAccounts: AccountConfig[];
  tokens: TokenConfig[];
  tokenBalances: TokenBalance[];
  onRegister: () => void;
  /** When undefined, the mint form is hidden (e.g. on mainnet, no admin). */
  onMint?: (token: string, amount: string) => void;
  onDeposit: (token: string, amount: string) => void;
  onWithdraw: (token: string, amount: string) => void;
  onTransfer: (token: string, recipient: string, amount: string) => void;
};

function privateBalanceOf(
  tokenBalances: TokenBalance[],
  tokenAddress: string
): bigint | undefined {
  if (!tokenAddress) return undefined;
  const target = BigInt(tokenAddress);
  return tokenBalances.find((tb) => BigInt(tb.address) === target)?.private;
}

function TokenSelect({
  tokens,
  value,
  onChange,
}: {
  tokens: TokenConfig[];
  value: string;
  onChange: (address: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {tokens.map((token) => (
        <option key={token.address} value={token.address}>
          {token.name}
        </option>
      ))}
    </select>
  );
}

export function ActionPanel({
  pending,
  pendingAction,
  sendCapable,
  activeAddress,
  otherAccounts,
  tokens,
  tokenBalances,
  onRegister,
  onMint,
  onDeposit,
  onWithdraw,
  onTransfer,
}: Props) {
  const disabledTitle = sendCapable ? undefined : "View-only — connect a wallet to send";
  const disabled = pending || !sendCapable;
  const defaultToken = tokens[0]?.address ?? "";
  const [mintToken, setMintToken] = useState(defaultToken);
  const [mintAmount, setMintAmount] = useState("100");
  const [depositToken, setDepositToken] = useState(defaultToken);
  const [depositAmount, setDepositAmount] = useState("100");
  const [withdrawToken, setWithdrawToken] = useState(defaultToken);
  const [withdrawAmount, setWithdrawAmount] = useState("50");
  const [transferToken, setTransferToken] = useState(defaultToken);
  const [transferAmount, setTransferAmount] = useState("50");
  const [transferRecipient, setTransferRecipient] = useState("");

  function handleMint(event: FormEvent) {
    event.preventDefault();
    onMint?.(mintToken, mintAmount);
  }

  function handleDeposit(event: FormEvent) {
    event.preventDefault();
    onDeposit(depositToken, depositAmount);
  }

  function handleWithdraw(event: FormEvent) {
    event.preventDefault();
    onWithdraw(withdrawToken, withdrawAmount);
  }

  function handleTransfer(event: FormEvent) {
    event.preventDefault();
    if (!transferRecipient) return;
    onTransfer(transferToken, transferRecipient, transferAmount);
  }

  return (
    <>
      <h2>Simple Actions</h2>

      {onMint && (
        <form onSubmit={handleMint} className="action-form">
          <h3>Mint tokens (transparent)</h3>
          <div className="action-row">
            <TokenSelect tokens={tokens} value={mintToken} onChange={setMintToken} />
            <input
              type="number"
              value={mintAmount}
              onChange={(event) => setMintAmount(event.target.value)}
              placeholder="Amount"
              min="0"
              step="any"
            />
            <button type="submit" disabled={disabled} title={disabledTitle}>
              {pending && pendingAction === "Mint" && <span className="spinner" />}
              Mint
            </button>
          </div>
        </form>
      )}

      <div className="action-form">
        <div className="action-row">
          <h3 style={{ margin: 0, flex: 1 }}>Register in the pool</h3>
          <button type="button" disabled={disabled} onClick={onRegister} title={disabledTitle}>
            {pending && pendingAction === "Register" && <span className="spinner" />}
            Register
          </button>
        </div>
      </div>

      <form onSubmit={handleDeposit} className="action-form">
        <h3>Deposit to self (auto setup)</h3>
        <div className="action-row">
          <TokenSelect tokens={tokens} value={depositToken} onChange={setDepositToken} />
          <span className="amount-with-max">
            <input
              type="number"
              value={depositAmount}
              onChange={(event) => setDepositAmount(event.target.value)}
              placeholder="Amount"
              min="0"
              step="any"
            />
            <button
              type="button"
              className="max-link"
              disabled={pending}
              onClick={() => {
                const target = BigInt(depositToken);
                const balance = tokenBalances.find(
                  (tb) => BigInt(tb.address) === target
                )?.transparent;
                if (balance == null) return;
                const decimals = tokens.find((t) => t.address === depositToken)?.decimals ?? 18;
                setDepositAmount(formatAmount(balance, decimals));
              }}
            >
              Max
            </button>
          </span>
          <button type="submit" disabled={disabled} title={disabledTitle}>
            {pending && pendingAction === "Deposit" && <span className="spinner" />}
            Deposit
          </button>
        </div>
      </form>

      <form onSubmit={handleWithdraw} className="action-form">
        <h3>Withdraw to self</h3>
        <div className="action-row">
          <TokenSelect tokens={tokens} value={withdrawToken} onChange={setWithdrawToken} />
          <span className="amount-with-max">
            <input
              type="number"
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              placeholder="Amount"
              min="0"
              step="any"
            />
            <button
              type="button"
              className="max-link"
              disabled={disabled}
              onClick={() => {
                const balance = privateBalanceOf(tokenBalances, withdrawToken);
                if (balance == null) return;
                const decimals =
                  tokens.find((t) => t.address === withdrawToken)?.decimals ?? 18;
                setWithdrawAmount(formatAmount(balance, decimals));
              }}
            >
              Max
            </button>
          </span>
          <button type="submit" disabled={disabled} title={disabledTitle}>
            {pending && pendingAction === "Withdraw" && <span className="spinner" />}
            Withdraw
          </button>
        </div>
      </form>

      <form onSubmit={handleTransfer} className="action-form">
        <h3>Transfer to someone (or sweep)</h3>
        <select
          className="transfer-recipient"
          value={transferRecipient}
          onChange={(event) => setTransferRecipient(event.target.value)}
        >
          <option value="">Select recipient...</option>
          <option value={activeAddress}>Self ({activeAddress.slice(0, 10)}...)</option>
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
        <div className="action-row">
          <TokenSelect tokens={tokens} value={transferToken} onChange={setTransferToken} />
          <span className="amount-with-max">
            <input
              type="number"
              value={transferAmount}
              onChange={(event) => setTransferAmount(event.target.value)}
              placeholder="Amount"
              min="0"
              step="any"
            />
            <button
              type="button"
              className="max-link"
              disabled={disabled}
              onClick={() => {
                const balance = privateBalanceOf(tokenBalances, transferToken);
                if (balance == null) return;
                const decimals =
                  tokens.find((t) => t.address === transferToken)?.decimals ?? 18;
                setTransferAmount(formatAmount(balance, decimals));
              }}
            >
              Max
            </button>
          </span>
          <button
            type="submit"
            disabled={disabled || !transferRecipient || transferRecipient === "custom"}
            title={disabledTitle}
          >
            {pending && pendingAction === "Transfer" && <span className="spinner" />}
            Transfer
          </button>
        </div>
      </form>
    </>
  );
}
