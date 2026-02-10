import { useState, useCallback } from "react";
import type { RpcProvider } from "starknet";
import { SetupRequirement, type Note, type Channel, type PrivateTransfersInterface } from "starknet-sdk";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { AppConfig, AccountConfig } from "../config.ts";
import { getErc20Balance } from "../starknet.ts";

export type NoteDisplay = {
  id: string;
  amount: bigint;
  token: string;
  sender: string;
  isSelfSender: boolean;
  channelKey: string;
  nonce: number;
  open: boolean;
};

export type ChannelDisplay = {
  recipient: string;
  isSelf: boolean;
  publicKey: string;
  channelKey: string;
  noteNonce: number;
  tokens: Array<{ tokenAddress: string }>;
};

export type PrivateState = {
  isRegistered: boolean | null;
  tokenBalance: bigint;
  feeTokenBalance: bigint;
  privateBalance: bigint;
  notes: NoteDisplay[];
  channels: ChannelDisplay[];
};

const EMPTY_STATE: PrivateState = {
  isRegistered: null,
  tokenBalance: 0n,
  feeTokenBalance: 0n,
  privateBalance: 0n,
  notes: [],
  channels: [],
};

// SDK fields are marked @internal, access via runtime shape
type WitnessInternal = { channelKey: bigint; nonce: number; r: bigint };
type ChannelInternal = {
  publicKey: bigint;
  key?: bigint;
  tokens: Map<bigint, { tokenIndex: number; noteNonce: number }>;
};

function readWitness(witness: unknown): WitnessInternal {
  return witness as WitnessInternal;
}

function readChannel(channel: Channel): ChannelInternal {
  return channel as unknown as ChannelInternal;
}

export function usePrivateState(
  provider: RpcProvider | undefined,
  transfers: PrivateTransfersInterface | undefined,
  account: AccountConfig | undefined,
  config: AppConfig,
) {
  const [state, setState] = useState<PrivateState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!provider || !transfers || !account) return;
    setLoading(true);
    setError(null);

    try {
      const indexer = new IndexerDiscoveryProvider(config.indexerUrl);
      const [tokenBalance, feeTokenBalance, { notes: notesMap }, channelsResult, requirement] =
        await Promise.all([
          getErc20Balance(provider, config.tokenAddress, account.address),
          getErc20Balance(provider, config.feeTokenAddress, account.address),
          transfers.discoverNotes({ tokens: [BigInt(config.tokenAddress)] }),
          indexer.discoverChannels(
            BigInt(account.address),
            BigInt(account.viewingKey),
            "all",
          ),
          indexer.discoverRequirement(
            BigInt(account.address),
            BigInt(account.viewingKey),
            BigInt(account.address),
            BigInt(config.tokenAddress),
          ),
        ]);
      const isRegistered = requirement !== SetupRequirement.Register;

      const tokenNotes = notesMap.get(BigInt(config.tokenAddress)) ?? [];
      const privateBalance = tokenNotes.reduce(
        (sum: bigint, note: Note) => sum + note.amount,
        0n,
      );

      const ownerAddress = BigInt(account.address);

      const tokenAddressBigInt = BigInt(config.tokenAddress);
      const notes: NoteDisplay[] = tokenNotes.map((note: Note) => {
        const witness = readWitness(note.witness);
        const senderBigInt = toBigInt(note.sender);
        return {
          id: formatBigInt(toBigInt(note.id)),
          amount: note.amount,
          token: truncateAddress(tokenAddressBigInt.toString(16)),
          sender: truncateAddress(senderBigInt.toString(16)),
          isSelfSender: senderBigInt === ownerAddress,
          channelKey: formatBigInt(witness.channelKey),
          nonce: witness.nonce,
          open: note.open ?? false,
        };
      });
      const channels: ChannelDisplay[] = [];
      for (const [recipient, channel] of channelsResult.channels) {
        const internal = readChannel(channel);
        const tokens: ChannelDisplay["tokens"] = [];
        let noteNonce = 0;
        for (const [tokenAddress, tokenChannel] of internal.tokens) {
          tokens.push({
            tokenAddress: truncateAddress(tokenAddress.toString(16)),
          });
          noteNonce = Math.max(noteNonce, tokenChannel.noteNonce);
        }
        const isSelf = recipient === ownerAddress;
        channels.push({
          recipient: truncateAddress(recipient.toString(16)),
          isSelf,
          publicKey: formatBigInt(internal.publicKey),
          channelKey: internal.key ? formatBigInt(internal.key) : "N/A",
          noteNonce,
          tokens,
        });
      }

      setState({ isRegistered, tokenBalance, feeTokenBalance, privateBalance, notes, channels });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [provider, transfers, account, config]);

  return { state, loading, error, refresh };
}

function truncateAddress(hex: string): string {
  const padded = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (padded.length <= 14) return padded;
  return `${padded.slice(0, 8)}...${padded.slice(-4)}`;
}

function formatBigInt(value: bigint): string {
  const hex = value.toString(16);
  if (hex.length <= 12) return `0x${hex}`;
  return `0x${hex.slice(0, 6)}...${hex.slice(-4)}`;
}

/** Convert BigNumberish (string | number | bigint) to bigint. Handles hex and decimal strings. */
function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}
