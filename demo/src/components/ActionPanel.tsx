import { useState, type FormEvent } from "react";
import type { RpcProvider } from "starknet";
import type { AccountConfig, EkuboConfig, TokenConfig } from "../config.ts";
import { usePoolPrice } from "../hooks/usePoolPrice.ts";

type Props = {
  pending: boolean;
  activeAddress: string;
  otherAccounts: AccountConfig[];
  tokens: TokenConfig[];
  swapTokens: TokenConfig[];
  provider: RpcProvider;
  ekubo?: EkuboConfig;
  onRegister: () => void;
  onMint: (token: string, amount: string) => void;
  onDeposit: (token: string, amount: string) => void;
  onWithdraw: (token: string, amount: string) => void;
  onTransfer: (token: string, recipient: string, amount: string) => void;
  onSwap: (fromToken: string, toToken: string, amount: string) => void;
};

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
  activeAddress,
  otherAccounts,
  tokens,
  swapTokens,
  provider,
  ekubo,
  onRegister,
  onMint,
  onDeposit,
  onWithdraw,
  onTransfer,
  onSwap,
}: Props) {
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
  const [swapFromToken, setSwapFromToken] = useState(swapTokens[0]?.address ?? "");
  const [swapToToken, setSwapToToken] = useState(swapTokens[1]?.address ?? "");
  const [swapAmount, setSwapAmount] = useState("1");

  const { poolPrice, loading: priceLoading } = usePoolPrice(
    provider,
    ekubo,
    swapFromToken,
    swapToToken,
    tokens
  );

  function handleMint(event: FormEvent) {
    event.preventDefault();
    onMint(mintToken, mintAmount);
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

  function handleSwap(event: FormEvent) {
    event.preventDefault();
    onSwap(swapFromToken, swapToToken, swapAmount);
  }

  // For swap: available "to" tokens exclude the selected "from" token
  const swapToOptions = swapTokens.filter((t) => t.address !== swapFromToken);

  return (
    <>
      <h2>Actions</h2>

      <form onSubmit={handleMint} className="action-form">
        <h3>Mint tokens (transparent)</h3>
        <div className="action-row">
          <TokenSelect tokens={tokens} value={mintToken} onChange={setMintToken} />
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
        </div>
      </form>

      <div className="action-form">
        <div className="action-row">
          <h3 style={{ margin: 0, flex: 1 }}>Register in the pool</h3>
          <button type="button" disabled={pending} onClick={onRegister}>
            Register
          </button>
        </div>
      </div>

      <form onSubmit={handleDeposit} className="action-form">
        <h3>Deposit to self (auto setup)</h3>
        <div className="action-row">
          <TokenSelect tokens={tokens} value={depositToken} onChange={setDepositToken} />
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
        </div>
      </form>

      <form onSubmit={handleWithdraw} className="action-form">
        <h3>Withdraw to self</h3>
        <div className="action-row">
          <TokenSelect tokens={tokens} value={withdrawToken} onChange={setWithdrawToken} />
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
        </div>
      </form>

      {swapTokens.length >= 2 && (
        <form onSubmit={handleSwap} className="action-form">
          <h3>Swap (Ekubo)</h3>
          <div className="swap-box">
            <label className="swap-label">From</label>
            <div className="swap-row">
              <input
                type="number"
                value={swapAmount}
                onChange={(event) => setSwapAmount(event.target.value)}
                placeholder="0.0"
                min="0"
                step="any"
              />
              <TokenSelect
                tokens={swapTokens}
                value={swapFromToken}
                onChange={(address) => {
                  setSwapFromToken(address);
                  const remaining = swapTokens.filter((t) => t.address !== address);
                  if (remaining.length === 1) setSwapToToken(remaining[0].address);
                  else if (swapToToken === address && remaining.length > 0)
                    setSwapToToken(remaining[0].address);
                }}
              />
            </div>
          </div>
          <div className="swap-flip-container">
            <button
              type="button"
              className="swap-flip-button"
              onClick={() => {
                setSwapFromToken(swapToToken);
                setSwapToToken(swapFromToken);
              }}
            >
              &#x21C5;
            </button>
          </div>
          <div className="swap-box">
            <label className="swap-label">To</label>
            <div className="swap-row">
              <input
                type="text"
                readOnly
                value={
                  poolPrice && swapAmount
                    ? (parseFloat(swapAmount) * poolPrice.price).toPrecision(6)
                    : ""
                }
                placeholder="0.0"
              />
              <TokenSelect tokens={swapToOptions} value={swapToToken} onChange={setSwapToToken} />
            </div>
          </div>
          {poolPrice && <div className="pool-price">{poolPrice.label}</div>}
          {priceLoading && <div className="pool-price">Loading price...</div>}
          <button
            type="submit"
            className="swap-submit"
            disabled={pending || swapFromToken === swapToToken || !swapAmount}
          >
            Swap
          </button>
        </form>
      )}
    </>
  );
}
