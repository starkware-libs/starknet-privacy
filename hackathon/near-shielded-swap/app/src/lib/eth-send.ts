import {
  OneClickService,
  QuoteRequest,
  type QuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { Token } from "../types";
import { findAssetByToken } from "./oneclick";

// ERC-20 `transfer(address,uint256)` — keccak256("transfer(address,uint256)")[0..4].
// Hardcoded to avoid pulling in a keccak implementation.
const ERC20_TRANSFER_SELECTOR = "a9059cbb";

export interface EthTransferTx {
  to: string;
  value: string;
}

export interface Erc20TransferTx {
  to: string;
  data: string;
}

export function buildEthTransfer(args: {
  to: string;
  valueWei: bigint;
}): EthTransferTx {
  return {
    to: args.to,
    value: "0x" + args.valueWei.toString(16),
  };
}

export function buildErc20Transfer(args: {
  token: string;
  to: string;
  amount: bigint;
}): Erc20TransferTx {
  // ABI head: selector || pad32(address) || pad32(uint256). Addresses must be
  // lowercased and stripped of `0x` before padding — the EIP-55 checksum case
  // would otherwise leak into the calldata payload.
  const recipient = stripHexPrefix(args.to).toLowerCase().padStart(64, "0");
  const amount = args.amount.toString(16).padStart(64, "0");
  return {
    to: args.token,
    data: "0x" + ERC20_TRANSFER_SELECTOR + recipient + amount,
  };
}

export interface RealQuoteResult {
  depositAddress: string;
  signature: string;
  response: QuoteResponse;
}

export async function requestRealQuote(args: {
  from: Token;
  to: Token;
  amountIn: bigint;
  slippageBps: number;
  recipient: string;
  refundTo: string;
}): Promise<RealQuoteResult | null> {
  const [fromAsset, toAsset] = await Promise.all([
    findAssetByToken(args.from),
    findAssetByToken(args.to),
  ]);
  if (!fromAsset || !toAsset) return null;

  const request: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: args.slippageBps,
    originAsset: fromAsset.assetId,
    destinationAsset: toAsset.assetId,
    amount: args.amountIn.toString(),
    refundTo: args.refundTo,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: args.recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  const response = await OneClickService.getQuote(request);
  const depositAddress = response.quote.depositAddress;
  if (!depositAddress) return null;
  return { depositAddress, signature: response.signature, response };
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}
