// Hardcoded relayer that submits the signed OutsideExecution txs on behalf
// of the wallet-extension user. The whole point is that the on-chain caller
// of the privacy pool action has no link to the user's account — so this
// account pays gas, advances its own nonce, and absorbs the public footprint.
//
// TESTNET ONLY. The private key is embedded in the bundle; anyone with the
// wallet URL can extract it and drain the STRK balance. On mainnet we'd
// route through an HTTP paymaster (AVNU) instead — the wallet only ever
// signs, never submits, so the migration is a swap of who broadcasts.
//
// Charlie's deterministic Sepolia account, supplied by the user.

import { Account, type RpcProvider } from "starknet";

export const RELAYER = {
  name: "Charlie",
  address: "0x7e5da3b8377dcd5aecff07fa660c7f933e7f3896dc994c03542304bba762877",
  privateKey: "0x35936ff2016465492ef9f69f8327e458b826d93ce1663cd6056f676c569f8ac",
} as const;

export function createRelayerAccount(provider: RpcProvider): Account {
  return new Account({
    provider,
    address: RELAYER.address,
    signer: RELAYER.privateKey,
    cairoVersion: "1",
  });
}
