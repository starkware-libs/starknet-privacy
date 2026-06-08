// Single source of truth for the Solana mainnet RPC endpoint used by the
// deposit flow. The public mainnet-beta endpoint is rate-limited and not
// production-grade; swap for a dedicated provider before any non-hackathon
// use.
export const SOLANA_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
