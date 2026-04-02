import { useState, useEffect, type FormEvent } from "react";
import type { RpcProvider } from "starknet";
import type { EkuboConfig, VesuConfig, TokenConfig } from "../config.ts";
import { usePoolPrice } from "../hooks/usePoolPrice.ts";
import { toRawAmount, formatTokenAmount } from "../format.ts";
import { previewDeposit, previewRedeem } from "../starknet.ts";

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
  swapTokens?: TokenConfig[];
  provider: RpcProvider;
  ekubo?: EkuboConfig;
  vesu?: VesuConfig;
  onSwap?: (fromToken: string, toToken: string, amount: string) => void;
  onVesuSupply?: (token: string, vTokenAddress: string, amount: string) => void;
  onVesuWithdraw?: (token: string, vTokenAddress: string, amount: string) => void;
};

export function DefiPanel({
  pending,
  pendingAction,
  tokens,
  swapTokens,
  provider,
  ekubo,
  vesu,
  onSwap,
  onVesuSupply,
  onVesuWithdraw,
}: Props) {
  // Ekubo swap state
  const [swapFromToken, setSwapFromToken] = useState(swapTokens?.[0]?.address ?? "");
  const [swapToToken, setSwapToToken] = useState(swapTokens?.[1]?.address ?? "");
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
    onSwap?.(swapFromToken, swapToToken, swapAmount);
  }

  const swapToOptions = swapTokens?.filter((t) => t.address !== swapFromToken) ?? [];

  // Vesu lending state
  const [vesuVaultIndex, setVesuVaultIndex] = useState(0);
  const [vesuAmount, setVesuAmount] = useState("10");
  const [vesuIsSupply, setVesuIsSupply] = useState(true);
  const [vesuPreview, setVesuPreview] = useState<string | null>(null);

  const vesuVault = vesu?.vaults[vesuVaultIndex];
  const vesuToLabel = vesuIsSupply
    ? "v" + (vesuVault?.tokenConfig.name ?? "")
    : vesuVault?.tokenConfig.name ?? "";

  // Preview: supply → preview_deposit (assets → shares), withdraw → preview_redeem (shares → assets)
  useEffect(() => {
    if (!vesuVault || !provider || !vesuAmount) {
      setVesuPreview(null);
      return;
    }
    let cancelled = false;
    const decimals = vesuVault.tokenConfig.decimals;
    try {
      const rawAmount = toRawAmount(vesuAmount, decimals);
      const promise = vesuIsSupply
        ? previewDeposit(provider, vesuVault.vTokenAddress, rawAmount)
        : previewRedeem(provider, vesuVault.vTokenAddress, rawAmount);
      promise.then(
        (result) => {
          if (!cancelled) setVesuPreview(formatTokenAmount(result, decimals));
        },
        () => {
          if (!cancelled) setVesuPreview(null);
        },
      );
    } catch {
      setVesuPreview(null);
    }
    return () => { cancelled = true; };
  }, [provider, vesuVault, vesuAmount, vesuIsSupply]);

  function handleVesu(event: FormEvent) {
    event.preventDefault();
    if (!vesuVault) return;
    if (vesuIsSupply) {
      onVesuSupply?.(vesuVault.tokenConfig.address, vesuVault.vTokenAddress, vesuAmount);
    } else {
      onVesuWithdraw?.(vesuVault.tokenConfig.address, vesuVault.vTokenAddress, vesuAmount);
    }
  }

  return (
    <>
      <h2>Anonymous DeFi</h2>

      {ekubo && (
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
                tokens={swapTokens ?? []}
                value={swapFromToken}
                onChange={(address) => {
                  setSwapFromToken(address);
                  const remaining = (swapTokens ?? []).filter((t) => t.address !== address);
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
      )}

      {vesu && vesu.vaults.length > 0 && (
        <form onSubmit={handleVesu} className="action-form">
          <h3>Lending (Vesu)</h3>
          <div className="swap-box">
            <label className="swap-label">From</label>
            <div className="swap-row">
              <input
                type="number"
                value={vesuAmount}
                onChange={(event) => setVesuAmount(event.target.value)}
                placeholder="0.0"
                min="0"
                step="any"
              />
              <select
                value={vesuVaultIndex}
                onChange={(event) => setVesuVaultIndex(Number(event.target.value))}
              >
                {vesu.vaults.map((vault, index) => (
                  <option key={vault.vTokenAddress} value={index}>
                    {vesuIsSupply ? vault.tokenConfig.name : `v${vault.tokenConfig.name}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="swap-flip-container">
            <button
              type="button"
              className="swap-flip-button"
              onClick={() => setVesuIsSupply((prev) => !prev)}
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
                value={vesuPreview ?? ""}
                placeholder="0.0"
              />
              <span className="swap-row-label">{vesuToLabel}</span>
            </div>
          </div>
          <button
            type="submit"
            className="swap-submit"
            disabled={pending || !vesuAmount}
          >
            {pending && (pendingAction === "Vesu Supply" || pendingAction === "Vesu Withdraw") && (
              <span className="spinner" />
            )}
            {vesuIsSupply ? "Supply" : "Withdraw"}
          </button>
        </form>
      )}
    </>
  );
}
