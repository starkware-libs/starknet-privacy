export const CHAIN = {
  name: "Mainnet",
  chainId: "0x534e5f4d41494e", // SN_MAIN
  rpcUrl: "http://34.61.242.43:9545/rpc/v0_10",
  explorerBase: "https://voyager.online",
} as const;

// Privacy pool — class declared on mainnet, instance deployment pending.
// Class hash verified via `starknet_getClass` against the user's RPC.
export const POOL_CLASS_HASH =
  "0x06fbd0ea6bf7405d2d5f47e3685941ff6d1737ebbf14c15b4acdb710920242e3";

// Mainnet privacy pool instance. Verified on-chain via `starknet_getClassHashAt`
// against the user's RPC — matches `POOL_CLASS_HASH`. Proving + discovery
// services below are pointed at this deployment.
export const POOL_CONTRACT_ADDRESS =
  "0x030a183e9b4199bc6e2c1f89829664c77554d5b548830d572d05e5d25c0c77db";

// Hosted services for the mainnet pool. Both are HTTP (not HTTPS) — fine for
// `http://localhost` dev, but a production HTTPS deploy of this app would need
// a TLS proxy in front of each, or mixed-content blocks will kill the calls.
export const PROVING_SERVICE_URL = "http://35.232.252.204:3000";
export const DISCOVERY_SERVICE_URL = "http://34.56.72.86:8080";

// TODO: replace with the real deploy output once `near_intents_anonymizer` is
// declared + deployed. Mailbox addresses derived from these placeholders are
// stable but meaningless — they only become real after the deploy script runs.
// Currently these match the fork's test-fixture values so addresses derived
// off-chain at least look consistent in the UI.
export const ANONYMIZER_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000aaa";
export const RECEIVER_CLASS_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000bbb";

// STRK fee-token address — hardcoded into the privacy pool Cairo
// (`packages/privacy/src/utils.cairo:62`) and identical across mainnet,
// sepolia, and devnet — safe to pin as a module constant. Source:
// `starknet-privacy/demo/src/starknet.ts:18`.
export const STRK_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return "";
  const normalized = addr.toLowerCase().startsWith("0x") ? addr : `0x${addr}`;
  if (normalized.length <= head + tail + 2) return normalized;
  return `${normalized.slice(0, head + 2)}…${normalized.slice(-tail)}`;
}

export function addressUrl(addr: string): string {
  return `${CHAIN.explorerBase}/contract/${addr}`;
}
