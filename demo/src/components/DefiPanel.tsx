import { useState, useEffect, type FormEvent } from "react";
import type { RpcProvider } from "starknet";
import { getQuotes } from "../avnu.ts";
import {
  findEkuboPool,
  type EkuboConfig,
  type VesuConfig,
  type TokenConfig,
} from "../config.ts";
import { usePoolPrice } from "../hooks/usePoolPrice.ts";
import { toRawAmount, formatTokenAmount, formatAmount } from "../format.ts";
import { previewDeposit, previewRedeem } from "../starknet.ts";
import type { TokenBalance } from "../hooks/usePrivateState.ts";

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
  sendCapable: boolean;
  tokens: TokenConfig[];
  tokenBalances: TokenBalance[];
  swapTokens?: TokenConfig[];
  provider: RpcProvider;
  ekubo?: EkuboConfig;
  vesu?: VesuConfig;
  paymasterAvailable?: boolean;
  onSwap?: (
    fromToken: string,
    toToken: string,
    amount: string,
    minReceivedRaw: bigint
  ) => void;
  onAvnuSwap?: (
    fromToken: string,
    toToken: string,
    amount: string,
    slippageBps: number
  ) => void;
  onVesuSupply?: (token: string, vTokenAddress: string, amount: string) => void;
  onVesuWithdraw?: (token: string, vTokenAddress: string, amount: string) => void;
};

function privateBalanceOf(
  tokenBalances: TokenBalance[],
  tokenAddress: string
): bigint | undefined {
  if (!tokenAddress) return undefined;
  const target = BigInt(tokenAddress);
  return tokenBalances.find((tb) => BigInt(tb.address) === target)?.private;
}

export function DefiPanel({
  pending,
  pendingAction,
  sendCapable,
  tokens,
  tokenBalances,
  swapTokens,
  provider,
  ekubo,
  vesu,
  paymasterAvailable,
  onSwap,
  onAvnuSwap,
  onVesuSupply,
  onVesuWithdraw,
}: Props) {
  const disabledTitle = sendCapable ? undefined : "View-only — connect a wallet to send";

  // AVNU swap state (always renders when the callback is available).
  const [avnuFromToken, setAvnuFromToken] = useState(tokens[0]?.address ?? "");
  const [avnuToToken, setAvnuToToken] = useState(tokens[1]?.address ?? "");
  const [avnuAmount, setAvnuAmount] = useState("1");
  const [avnuSlippageBps, setAvnuSlippageBps] = useState(100);
  const [avnuExpectedOut, setAvnuExpectedOut] = useState<bigint | null>(null);
  const [avnuQuoteLoading, setAvnuQuoteLoading] = useState(false);
  const [avnuQuoteError, setAvnuQuoteError] = useState<string | null>(null);

  const avnuToTokenDecimals =
    tokens.find((t) => t.address === avnuToToken)?.decimals ?? 18;
  const avnuFromTokenDecimals =
    tokens.find((t) => t.address === avnuFromToken)?.decimals ?? 18;
  // Apply slippage to the raw expected output to get the displayed "To (min)".
  // Integer math on bigint keeps precision regardless of decimals.
  const avnuMinOutRaw =
    avnuExpectedOut !== null
      ? (avnuExpectedOut * BigInt(10000 - avnuSlippageBps)) / 10000n
      : null;
  const avnuMinOutDisplay =
    avnuMinOutRaw !== null ? formatTokenAmount(avnuMinOutRaw, avnuToTokenDecimals) : "";

  // Debounced AVNU quote refresh. Re-runs when from/to/amount change; the
  // cancelled flag discards stale responses when the inputs flip faster than
  // the network. Quote preview is a UX nicety — final slippage is enforced
  // at submit via `quoteToCalls({ slippage })` inside the swap handler.
  useEffect(() => {
    if (!onAvnuSwap) return;
    if (!avnuFromToken || !avnuToToken || avnuFromToken === avnuToToken) {
      setAvnuExpectedOut(null);
      setAvnuQuoteError(null);
      return;
    }
    const parsed = parseFloat(avnuAmount);
    if (!avnuAmount || !isFinite(parsed) || parsed <= 0) {
      setAvnuExpectedOut(null);
      setAvnuQuoteError(null);
      return;
    }
    let cancelled = false;
    let rawAmount: bigint;
    try {
      rawAmount = toRawAmount(avnuAmount, avnuFromTokenDecimals);
    } catch {
      setAvnuExpectedOut(null);
      return;
    }
    const timer = setTimeout(() => {
      setAvnuQuoteLoading(true);
      setAvnuQuoteError(null);
      getQuotes({
        sellTokenAddress: avnuFromToken,
        buyTokenAddress: avnuToToken,
        sellAmount: rawAmount,
        size: 1,
      }).then(
        (quotes) => {
          if (cancelled) return;
          const quote = quotes[0];
          if (!quote) {
            setAvnuExpectedOut(null);
            setAvnuQuoteError("no route");
          } else {
            setAvnuExpectedOut(quote.buyAmount);
          }
          setAvnuQuoteLoading(false);
        },
        (err) => {
          if (cancelled) return;
          setAvnuExpectedOut(null);
          setAvnuQuoteError(err instanceof Error ? err.message : "quote failed");
          setAvnuQuoteLoading(false);
        }
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [onAvnuSwap, avnuFromToken, avnuToToken, avnuAmount, avnuFromTokenDecimals]);

  function handleAvnuSwap(event: FormEvent) {
    event.preventDefault();
    onAvnuSwap?.(avnuFromToken, avnuToToken, avnuAmount, avnuSlippageBps);
  }
  const avnuToOptions = tokens.filter((t) => t.address !== avnuFromToken);
  // Ekubo swap state
  const [swapFromToken, setSwapFromToken] = useState(swapTokens?.[0]?.address ?? "");
  const [swapToToken, setSwapToToken] = useState(swapTokens?.[1]?.address ?? "");
  const [swapAmount, setSwapAmount] = useState("1");
  // Slippage tolerance in basis points (1 bps = 0.01%).
  const [slippageBps, setSlippageBps] = useState(50);

  const { poolPrice, loading: priceLoading } = usePoolPrice(
    provider,
    ekubo,
    swapFromToken,
    swapToToken,
    tokens
  );
  const swapPool = findEkuboPool(ekubo, swapFromToken, swapToToken);
  const toTokenDecimals =
    tokens.find((t) => t.address === swapToToken)?.decimals ?? 18;
  // When the Core contract doesn't expose `get_pool_price` (mock AMMs) we
  // can't compute a real expected output. Fall back to 1:1 so the UI shows
  // something useful and the user can submit; the mock executor's `swap`
  // returns deterministic amounts and the on-chain slippage floor is set
  // to 0 in this case (see swap-submit title hint).
  const fromAmountNumber = swapAmount ? parseFloat(swapAmount) : 0;
  const expectedOutHuman = poolPrice
    ? fromAmountNumber * poolPrice.price
    : swapPool
      ? fromAmountNumber
      : 0;
  const minOutHuman =
    poolPrice && expectedOutHuman > 0
      ? (expectedOutHuman * (10000 - slippageBps)) / 10000
      : 0;

  function computeMinReceivedRaw(): bigint {
    if (minOutHuman <= 0) return 0n;
    // Stay under Number's ~15-sig-digit precision when scaling up: compute the
    // first `safeDecimals` digits as a Number, then multiply the remainder
    // with BigInt. Losing a few low bits is fine for a slippage floor.
    const safeDecimals = Math.min(toTokenDecimals, 12);
    const extra = toTokenDecimals - safeDecimals;
    const scaled = Math.floor(minOutHuman * 10 ** safeDecimals);
    if (!isFinite(scaled) || scaled < 0) return 0n;
    return BigInt(scaled) * 10n ** BigInt(extra);
  }

  function handleSwap(event: FormEvent) {
    event.preventDefault();
    onSwap?.(swapFromToken, swapToToken, swapAmount, computeMinReceivedRaw());
  }

  // Only show "to" options that have a configured pool with the "from" token.
  const swapToOptions = (swapTokens ?? []).filter(
    (t) => t.address !== swapFromToken && findEkuboPool(ekubo, swapFromToken, t.address),
  );

  // Vesu lending state
  const [vesuVaultIndex, setVesuVaultIndex] = useState(0);
  const [vesuAmount, setVesuAmount] = useState("10");
  const [vesuIsSupply, setVesuIsSupply] = useState(true);
  const [vesuPreview, setVesuPreview] = useState<string | null>(null);

  const vesuVault = vesu?.vaults[vesuVaultIndex];
  const vesuToLabel = vesuIsSupply
    ? "v" + (vesuVault?.tokenConfig.name ?? "")
    : (vesuVault?.tokenConfig.name ?? "");

  // Preview: supply → preview_deposit (assets in → shares out),
  //          withdraw → preview_redeem (shares in → assets out).
  // Input units and output units differ by mode.
  useEffect(() => {
    if (!vesuVault || !provider || !vesuAmount) {
      setVesuPreview(null);
      return;
    }
    let cancelled = false;
    const underlyingDecimals = vesuVault.tokenConfig.decimals;
    const vTokenDecimals = 18;
    const inDecimals = vesuIsSupply ? underlyingDecimals : vTokenDecimals;
    const outDecimals = vesuIsSupply ? vTokenDecimals : underlyingDecimals;
    try {
      const rawAmount = toRawAmount(vesuAmount, inDecimals);
      const promise = vesuIsSupply
        ? previewDeposit(provider, vesuVault.vTokenAddress, rawAmount)
        : previewRedeem(provider, vesuVault.vTokenAddress, rawAmount);
      promise.then(
        (result) => {
          if (!cancelled) setVesuPreview(formatTokenAmount(result, outDecimals));
        },
        () => {
          if (!cancelled) setVesuPreview(null);
        }
      );
    } catch {
      setVesuPreview(null);
    }
    return () => {
      cancelled = true;
    };
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

      {onAvnuSwap && (
        <form onSubmit={handleAvnuSwap} className="action-form">
          <h3>Swap (AVNU · Private)</h3>
          <div className="swap-box">
            <label className="swap-label">From</label>
            <div className="swap-row">
              <span className="amount-with-max">
                <input
                  type="number"
                  value={avnuAmount}
                  onChange={(event) => setAvnuAmount(event.target.value)}
                  placeholder="0.0"
                  min="0"
                  step="any"
                />
                <button
                  type="button"
                  className="max-link"
                  disabled={pending || !sendCapable}
                  onClick={() => {
                    const balance = privateBalanceOf(tokenBalances, avnuFromToken);
                    if (balance == null) return;
                    const decimals =
                      tokens.find((t) => t.address === avnuFromToken)?.decimals ?? 18;
                    setAvnuAmount(formatAmount(balance, decimals));
                  }}
                >
                  Max
                </button>
              </span>
              <TokenSelect
                tokens={tokens}
                value={avnuFromToken}
                onChange={(address) => {
                  setAvnuFromToken(address);
                  if (avnuToToken === address) {
                    const fallback = tokens.find((t) => t.address !== address);
                    if (fallback) setAvnuToToken(fallback.address);
                  }
                }}
              />
            </div>
          </div>
          <div className="swap-flip-container">
            <button
              type="button"
              className="swap-flip-button"
              onClick={() => {
                setAvnuFromToken(avnuToToken);
                setAvnuToToken(avnuFromToken);
              }}
            >
              &#x21C5;
            </button>
          </div>
          <div className="swap-box">
            <label className="swap-label">To (min)</label>
            <div className="swap-row">
              <input
                type="text"
                readOnly
                value={avnuQuoteLoading ? "…" : avnuMinOutDisplay}
                placeholder={avnuQuoteError ?? "enter amount"}
              />
              <TokenSelect
                tokens={avnuToOptions}
                value={avnuToToken}
                onChange={setAvnuToToken}
              />
            </div>
          </div>
          <div className="slippage-row">
            <span className="slippage-label">Slippage</span>
            {[10, 50, 100, 300, 500, 2000].map((bps) => (
              <button
                type="button"
                key={bps}
                className={
                  "slippage-link" + (avnuSlippageBps === bps ? " slippage-link-active" : "")
                }
                onClick={() => setAvnuSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
          <button
            type="submit"
            className="swap-submit"
            disabled={
              pending ||
              !sendCapable ||
              avnuFromToken === avnuToToken ||
              !avnuAmount ||
              !paymasterAvailable ||
              avnuExpectedOut === null
            }
            title={
              !paymasterAvailable
                ? "Requires paymaster — enable it in the Config panel"
                : avnuExpectedOut === null
                  ? (avnuQuoteError ?? "Waiting for quote…")
                  : disabledTitle
            }
          >
            {pending && pendingAction === "AVNU Swap" && <span className="spinner" />}
            Swap
          </button>
        </form>
      )}

      {ekubo && (
        <form onSubmit={handleSwap} className="action-form">
          <h3>Swap (Ekubo)</h3>
          <div className="swap-box">
            <label className="swap-label">From</label>
            <div className="swap-row">
              <span className="amount-with-max">
                <input
                  type="number"
                  value={swapAmount}
                  onChange={(event) => setSwapAmount(event.target.value)}
                  placeholder="0.0"
                  min="0"
                  step="any"
                />
                <button
                  type="button"
                  className="max-link"
                  disabled={pending || !sendCapable}
                  onClick={() => {
                    const balance = privateBalanceOf(tokenBalances, swapFromToken);
                    if (balance == null) return;
                    const decimals =
                      tokens.find((t) => t.address === swapFromToken)?.decimals ?? 18;
                    setSwapAmount(formatAmount(balance, decimals));
                  }}
                >
                  Max
                </button>
              </span>
              <TokenSelect
                tokens={swapTokens ?? []}
                value={swapFromToken}
                onChange={(address) => {
                  setSwapFromToken(address);
                  // Re-target "to" if the current pair has no pool under the new "from".
                  const validTargets = (swapTokens ?? []).filter(
                    (t) => t.address !== address && findEkuboPool(ekubo, address, t.address)
                  );
                  if (validTargets.length === 0) return;
                  const currentStillValid = validTargets.some((t) => t.address === swapToToken);
                  if (!currentStillValid) setSwapToToken(validTargets[0].address);
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
            <label className="swap-label">{poolPrice ? "To (min)" : "To (est.)"}</label>
            <div className="swap-row">
              <input
                type="text"
                readOnly
                value={
                  minOutHuman > 0
                    ? minOutHuman.toPrecision(6)
                    : expectedOutHuman > 0
                      ? expectedOutHuman.toPrecision(6)
                      : ""
                }
                placeholder="0.0"
                title={
                  poolPrice && expectedOutHuman > 0
                    ? `Minimum received after ${slippageBps / 100}% slippage (expected ${expectedOutHuman.toPrecision(6)})`
                    : expectedOutHuman > 0
                      ? "Estimated output assuming a 1:1 mock pool. Actual output may differ."
                      : undefined
                }
              />
              <TokenSelect tokens={swapToOptions} value={swapToToken} onChange={setSwapToToken} />
            </div>
          </div>
          {poolPrice && <div className="pool-price">{poolPrice.label}</div>}
          {priceLoading && <div className="pool-price">Loading price...</div>}
          {!swapPool && swapFromToken !== swapToToken && (
            <div className="pool-price">No Ekubo pool configured for this pair</div>
          )}
          <div className="slippage-row">
            <span className="slippage-label">Slippage</span>
            {[10, 50, 100, 300, 500, 2000].map((bps) => (
              <button
                type="button"
                key={bps}
                className={
                  "slippage-link" + (slippageBps === bps ? " slippage-link-active" : "")
                }
                onClick={() => setSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
          <button
            type="submit"
            className="swap-submit"
            disabled={
              pending ||
              !sendCapable ||
              swapFromToken === swapToToken ||
              !swapAmount ||
              !swapPool
            }
            title={
              !swapPool && swapFromToken !== swapToToken
                ? "No pool for this pair"
                : !poolPrice
                  ? "No pool price available — submitting with no slippage floor (minimum_received=0)"
                  : disabledTitle
            }
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
              <span className="amount-with-max">
                <input
                  type="number"
                  value={vesuAmount}
                  onChange={(event) => setVesuAmount(event.target.value)}
                  placeholder="0.0"
                  min="0"
                  step="any"
                />
                <button
                  type="button"
                  className="max-link"
                  disabled={pending || !sendCapable || !vesuVault}
                  onClick={() => {
                    if (!vesuVault) return;
                    // Supply input is in underlying (USDC) units; withdraw input
                    // is in vToken (share) units to match the balance displayed
                    // in the balance table.
                    const sourceAddress = vesuIsSupply
                      ? vesuVault.tokenConfig.address
                      : vesuVault.vTokenAddress;
                    const balance = privateBalanceOf(tokenBalances, sourceAddress);
                    if (balance == null) return;
                    const decimals = vesuIsSupply
                      ? vesuVault.tokenConfig.decimals
                      : 18;
                    setVesuAmount(formatAmount(balance, decimals));
                  }}
                >
                  Max
                </button>
              </span>
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
              <input type="text" readOnly value={vesuPreview ?? ""} placeholder="0.0" />
              <span className="swap-row-label">{vesuToLabel}</span>
            </div>
          </div>
          <button
            type="submit"
            className="swap-submit"
            disabled={pending || !sendCapable || !vesuAmount}
            title={disabledTitle}
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
