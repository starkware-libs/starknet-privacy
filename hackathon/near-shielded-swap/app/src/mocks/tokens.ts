import type { Token } from "../types";

// Source: only STRK on Starknet is a valid shielded source — that's the only
// asset 1Click indexes on Starknet (verified live against
// https://1click.chaindefuser.com/v0/tokens).
export const SOURCE_TOKEN: Token = {
  id: "strk-starknet",
  symbol: "STRK",
  name: "Starknet",
  chain: "Starknet",
  chainTag: "starknet",
  decimals: 18,
  iconTint: "#FF5C2A",
  usdPrice: 0.05,
  shieldedBalance: 1240.55,
};

// Scoped destination catalog for the hackathon demo: three counterparties
// across two non-Starknet chains. Each maps to a real 1Click asset entry
// (verified live against https://1click.chaindefuser.com/v0/tokens) and a
// supported source wallet (Metamask for `eth`, Phantom for `sol`).
export const DESTINATION_TOKENS: Token[] = [
  {
    id: "eth-ethereum",
    symbol: "ETH",
    name: "Ether",
    chain: "Ethereum",
    chainTag: "eth",
    decimals: 18,
    iconTint: "#627EEA",
    usdPrice: 2288,
  },
  {
    id: "usdc-ethereum",
    symbol: "USDC",
    name: "USD Coin",
    chain: "Ethereum",
    chainTag: "eth",
    decimals: 6,
    iconTint: "#2775CA",
    usdPrice: 1,
  },
  {
    id: "sol-solana",
    symbol: "SOL",
    name: "Solana",
    chain: "Solana",
    chainTag: "sol",
    decimals: 9,
    iconTint: "#9945FF",
    usdPrice: 185,
  },
];

export const ALL_TOKENS: Token[] = [SOURCE_TOKEN, ...DESTINATION_TOKENS];

export const TOKEN_BY_ID: Record<string, Token> = Object.fromEntries(
  ALL_TOKENS.map((t) => [t.id, t]),
);

// Kept for backwards-compat with components that still import TOKENS.
export const TOKENS = ALL_TOKENS;
export const TOKEN_BY_SYMBOL: Record<string, Token> = Object.fromEntries(
  ALL_TOKENS.map((t) => [t.symbol, t]),
);
