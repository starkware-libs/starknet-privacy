import { useState, useEffect } from "react";
import type { RpcProvider } from "starknet";
import { findEkuboPool, type EkuboConfig, type TokenConfig } from "../config.ts";
import { getPoolPrice } from "../starknet.ts";

export type PoolPrice = {
  price: number;
  /** Price expressed as "1 fromToken = X toToken" */
  label: string;
};

/**
 * Fetches the current Ekubo pool price for a given token pair.
 * Returns the price as "1 fromToken = X toToken".
 */
export function usePoolPrice(
  provider: RpcProvider | undefined,
  ekubo: EkuboConfig | undefined,
  fromToken: string,
  toToken: string,
  allTokens: TokenConfig[]
): { poolPrice: PoolPrice | null; loading: boolean } {
  const [poolPrice, setPoolPrice] = useState<PoolPrice | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!provider || !ekubo || !fromToken || !toToken || fromToken === toToken) {
      setPoolPrice(null);
      return;
    }

    const tokenMap = new Map(allTokens.map((t) => [t.address, t]));
    const fromConfig = tokenMap.get(fromToken);
    const toConfig = tokenMap.get(toToken);
    if (!fromConfig || !toConfig) {
      setPoolPrice(null);
      return;
    }

    const pool = findEkuboPool(ekubo, fromToken, toToken);
    if (!pool) {
      setPoolPrice(null);
      return;
    }

    // Token maps use hex strings; pool.token0/token1 also hex but may differ
    // in casing / zero-padding. Match via BigInt equality.
    const token0BigInt = BigInt(pool.token0);
    const tokenByBigInt = new Map(allTokens.map((t) => [BigInt(t.address), t]));
    const token0Decimals = tokenByBigInt.get(token0BigInt)?.decimals ?? 18;
    const token1Decimals = tokenByBigInt.get(BigInt(pool.token1))?.decimals ?? 18;

    let cancelled = false;
    setLoading(true);

    void getPoolPrice(
      provider,
      ekubo.coreAddress,
      pool.token0,
      pool.token1,
      pool.fee,
      pool.tickSpacing,
      pool.extension,
      token0Decimals,
      token1Decimals
    ).then(
      (result) => {
        if (cancelled) return;
        // result.price is token1/token0. Convert to fromToken/toToken direction.
        const isFromToken0 = BigInt(fromToken) === token0BigInt;
        const directionalPrice = isFromToken0 ? result.price : 1 / result.price;
        setPoolPrice({
          price: directionalPrice,
          label: `1 ${fromConfig.name} = ${directionalPrice.toPrecision(6)} ${toConfig.name}`,
        });
        setLoading(false);
      },
      (error) => {
        if (cancelled) return;
        console.error("[PoolPrice] failed:", error);
        setPoolPrice(null);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [provider, ekubo, fromToken, toToken, allTokens]);

  return { poolPrice, loading };
}
