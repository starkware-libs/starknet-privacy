import { useEffect, useRef, useState } from "react";
import type { RpcProvider } from "starknet";
import { getErc20Metadata, type TokenMetadata } from "../starknet.ts";

export type TokenMetadataMap = Map<string, TokenMetadata>;

export function useTokenMetadata(
  provider: RpcProvider | undefined,
  tokenAddresses: string[],
): TokenMetadataMap {
  const [metadata, setMetadata] = useState<TokenMetadataMap>(new Map());
  const fetchedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!provider) return;
    const missing = tokenAddresses.filter(
      (address) => !fetchedRef.current.has(address),
    );
    if (missing.length === 0) return;

    for (const address of missing) {
      fetchedRef.current.add(address);
    }

    Promise.all(
      missing.map(async (address) => {
        const meta = await getErc20Metadata(provider, address);
        return [address, meta] as const;
      }),
    ).then((entries) => {
      setMetadata((previous) => {
        const next = new Map(previous);
        for (const [address, meta] of entries) {
          next.set(address, meta);
        }
        return next;
      });
    });
  }, [provider, tokenAddresses]);

  return metadata;
}
