import { useState, type FormEvent } from "react";
import type { RpcProvider } from "starknet";
import type { EkuboConfig, TokenConfig } from "../config.ts";
import { usePoolPrice } from "../hooks/usePoolPrice.ts";

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

type Props = {
  pending: boolean;
  pendingAction: string | null;
  tokens: TokenConfig[];
  swapTokens: TokenConfig[];
  provider: RpcProvider;
  ekubo: EkuboConfig;
  onSwap: (fromToken: string, toToken: string, amount: string) => void;
};

export function DefiPanel({
  pending,
  pendingAction,
  tokens,
  swapTokens,
  provider,
  ekubo,
  onSwap,
}: Props) {
  const [swapFromToken, setSwapFromToken] = useState(swapTokens[0]?.address ?? "");
  const [swapToToken, setSwapToToken] = useState(swapTokens[1]?.address ?? "");
  const [swapAmount, setSwapAmount] = useState("1");

  const { poolPrice, loading: priceLoading } = usePoolPrice(
    provider,
    ekubo,
    swapFromToken,
    swapToToken,
    tokens,
  );

  function handleSwap(event: FormEvent) {
    event.preventDefault();
    onSwap(swapFromToken, swapToToken, swapAmount);
  }

  const swapToOptions = swapTokens.filter((t) => t.address !== swapFromToken);

  return (
    <>
      <h2>Anonymous DeFi</h2>

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
          {pending && pendingAction === "Swap" && <span className="spinner" />}
          Swap
        </button>
      </form>
    </>
  );
}
