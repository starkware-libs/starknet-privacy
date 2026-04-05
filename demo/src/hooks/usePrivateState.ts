import { useState, useCallback, useEffect, useRef } from "react";
import type { RpcProvider } from "starknet";
import {
  SetupRequirement,
  createEmptyRegistry,
  type Note,
  type Channel,
  type PrivateTransfersInterface,
  type PrivateRegistry,
} from "starknet-sdk";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { AppConfig, AccountConfig } from "../config.ts";
import { getErc20Balance } from "../starknet.ts";
import type { TokenMetadataMap } from "./useTokenMetadata.ts";

export type NoteDisplay = {
  id: string;
  rawId: bigint;
  amount: bigint;
  decimals: number;
  token: string;
  tokenName: string;
  sender: string;
  senderName: string | null;
  channelKey: string;
  rawChannelKey: string;
  nonce: number;
  open: boolean;
};

export type TokenNoteGroup = {
  tokenAddress: string;
  tokenName: string;
  decimals: number;
  notes: NoteDisplay[];
};

export type IncomingChannelCard = {
  cardKey: string;
  sender: string;
  senderName: string | null;
  channelKey: string;
  rawChannelKey: string;
  tokenGroups: TokenNoteGroup[];
};

export type OutgoingChannelCard = {
  cardKey: string;
  recipient: string;
  recipientName: string | null;
  channelKey: string;
  rawChannelKey: string;
  tokens: { tokenAddress: string; tokenName: string; noteNonce: number }[];
};

export type TokenBalance = {
  name: string;
  address: string;
  decimals: number;
  transparent: bigint;
  private: bigint;
  noteCount: number;
};

export type PrivateState = {
  isRegistered: boolean | null;
  tokenBalances: TokenBalance[];
  feeTokenBalance: bigint;
  feeTokenAddress: string;
  notes: NoteDisplay[];
  incomingCards: IncomingChannelCard[];
  outgoingCards: OutgoingChannelCard[];
};

const EMPTY_STATE: PrivateState = {
  isRegistered: null,
  tokenBalances: [],
  feeTokenBalance: 0n,
  feeTokenAddress: "",
  notes: [],
  incomingCards: [],
  outgoingCards: [],
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
  allAccounts: AccountConfig[],
  poolAddress: string,
  config: AppConfig,
  registry: PrivateRegistry,
  tokenMetadata: TokenMetadataMap,
) {
  const [state, setState] = useState<PrivateState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref so refresh callback doesn't re-trigger when metadata loads
  const tokenMetadataRef = useRef(tokenMetadata);
  tokenMetadataRef.current = tokenMetadata;

  useEffect(() => {
    setState(EMPTY_STATE);
  }, [account, poolAddress]);

  const refresh = useCallback(async () => {
    if (!provider || !transfers || !account) return;
    setLoading(true);
    setError(null);

    try {
      const indexer = new IndexerDiscoveryProvider(config.indexerUrl, poolAddress);
      const [tokenBalance, feeTokenBalance, notesResult, channelsResult, requirement] =
        await Promise.all([
          getErc20Balance(provider, config.tokenAddress, account.address, "pre_confirmed"),
          getErc20Balance(provider, config.feeTokenAddress, account.address, "pre_confirmed"),
          indexer.discoverNotes(
            BigInt(account.address),
            BigInt(account.viewingKey),
            { cursor: registry.cursor, tokens: [BigInt(config.tokenAddress)] },
          ),
          indexer.discoverChannels(
            BigInt(account.address),
            BigInt(account.viewingKey),
            "all",
            { cursor: { channels: registry.channels } },
          ),
          indexer.discoverRequirement(
            BigInt(account.address),
            BigInt(account.viewingKey),
            BigInt(account.address),
            BigInt(config.tokenAddress),
          ),
        ]);
      const isRegistered = requirement !== SetupRequirement.Register;

      registry.cursor = notesResult.cursor;
      if (channelsResult.channels) registry.channels = channelsResult.channels;

      const meta = tokenMetadataRef.current.get(config.tokenAddress);
      const tokenName = meta?.symbol ?? "Token";
      const tokenDecimals = meta?.decimals ?? 0;

      const tokenNotes = notesResult.notes.get(BigInt(config.tokenAddress)) ?? [];
      registry.notes = notesResult.notes;
      const privateBalance = tokenNotes.reduce(
        (sum: bigint, note: Note) => sum + note.amount,
        0n,
      );

      // Note amounts in the privacy pool are already in human-readable units
      // (e.g. 50 for 50 STRK), NOT raw ERC20 units (50 * 10^18).
      // Only transparent ERC20 balances need decimal scaling.
      const tokenBalances: TokenBalance[] = [{
        name: tokenName,
        address: config.tokenAddress,
        decimals: tokenDecimals,
        transparent: tokenBalance,
        private: privateBalance,
        noteCount: tokenNotes.length,
      }];

      const nameByAddress = new Map<bigint, string>();
      for (const acc of allAccounts) {
        const accAddress = BigInt(acc.address);
        nameByAddress.set(accAddress, accAddress === BigInt(account.address) ? "Self" : acc.name);
      }

      const tokenAddressBigInt = BigInt(config.tokenAddress);
      const notes: NoteDisplay[] = tokenNotes.map((note: Note) => {
        const witness = readWitness(note.witness);
        const senderBigInt = toBigInt(note.sender);
        const noteIdBigInt = toBigInt(note.id);
        return {
          id: formatBigInt(noteIdBigInt),
          rawId: noteIdBigInt,
          amount: note.amount,
          decimals: tokenDecimals,
          token: truncateAddress(tokenAddressBigInt.toString(16)),
          tokenName,
          sender: truncateAddress(senderBigInt.toString(16)),
          senderName: nameByAddress.get(senderBigInt) ?? null,
          channelKey: formatBigInt(witness.channelKey),
          rawChannelKey: `0x${witness.channelKey.toString(16)}`,
          nonce: witness.nonce,
          open: note.open ?? false,
        };
      });

      // Build incoming cards: group notes by sender, then by token
      const bySender = new Map<string, NoteDisplay[]>();
      for (const note of notes) {
        const key = note.sender;
        const existing = bySender.get(key);
        if (existing) {
          existing.push(note);
        } else {
          bySender.set(key, [note]);
        }
      }

      const incomingCards: IncomingChannelCard[] = [];
      for (const [sender, senderNotes] of bySender) {
        senderNotes.sort((a, b) => b.nonce - a.nonce);
        const firstNote = senderNotes[0];

        // Sub-group by token (single token for now, but structure is ready)
        const byToken = new Map<string, NoteDisplay[]>();
        for (const note of senderNotes) {
          const existing = byToken.get(note.token);
          if (existing) {
            existing.push(note);
          } else {
            byToken.set(note.token, [note]);
          }
        }

        const tokenGroups: TokenNoteGroup[] = [];
        for (const [tokenAddr, tokenNotesList] of byToken) {
          const first = tokenNotesList[0];
          tokenGroups.push({
            tokenAddress: tokenAddr,
            tokenName: first.tokenName,
            decimals: first.decimals,
            notes: tokenNotesList,
          });
        }

        incomingCards.push({
          cardKey: sender,
          sender,
          senderName: firstNote.senderName,
          channelKey: firstNote.channelKey,
          rawChannelKey: firstNote.rawChannelKey,
          tokenGroups,
        });
      }
      // Sort: Self first, then alphabetical
      incomingCards.sort((a, b) => {
        if (a.senderName === "Self") return -1;
        if (b.senderName === "Self") return 1;
        return (a.senderName ?? a.sender).localeCompare(b.senderName ?? b.sender);
      });

      // Build outgoing cards
      const outgoingCards: OutgoingChannelCard[] = [];
      for (const [recipient, channel] of channelsResult.channels) {
        const internal = readChannel(channel);
        const tokens: OutgoingChannelCard["tokens"] = [];
        for (const [tokenAddr, tokenChannel] of internal.tokens) {
          const tokenMeta = tokenMetadataRef.current.get(
            `0x${tokenAddr.toString(16)}`,
          );
          tokens.push({
            tokenAddress: truncateAddress(tokenAddr.toString(16)),
            tokenName: tokenMeta?.symbol ?? truncateAddress(tokenAddr.toString(16)),
            noteNonce: tokenChannel.noteNonce,
          });
        }
        const recipientName = nameByAddress.get(recipient) ?? null;
        outgoingCards.push({
          cardKey: recipient.toString(16),
          recipient: truncateAddress(recipient.toString(16)),
          recipientName,
          channelKey: internal.key ? formatBigInt(internal.key) : "N/A",
          rawChannelKey: internal.key ? `0x${internal.key.toString(16)}` : "",
          tokens,
        });
      }
      // Sort: Self first, then alphabetical
      outgoingCards.sort((a, b) => {
        if (a.recipientName === "Self") return -1;
        if (b.recipientName === "Self") return 1;
        return (a.recipientName ?? a.recipient).localeCompare(b.recipientName ?? b.recipient);
      });

      setState({
        isRegistered,
        tokenBalances,
        feeTokenBalance,
        feeTokenAddress: config.feeTokenAddress,
        notes,
        incomingCards,
        outgoingCards,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      Object.assign(registry, createEmptyRegistry());
    } finally {
      setLoading(false);
    }
  }, [provider, transfers, account, allAccounts, poolAddress, config, registry]);

  const refreshBalances = useCallback(async () => {
    if (!provider || !account) return;
    const meta = tokenMetadataRef.current.get(config.tokenAddress);
    const tokenDecimals = meta?.decimals ?? 0;
    const tokenName = meta?.symbol ?? "Token";
    const [tokenBalance, feeTokenBalance] = await Promise.all([
      getErc20Balance(provider, config.tokenAddress, account.address, "pre_confirmed"),
      getErc20Balance(provider, config.feeTokenAddress, account.address, "pre_confirmed"),
    ]);
    setState((previous) => ({
      ...previous,
      feeTokenBalance,
      tokenBalances: previous.tokenBalances.length > 0
        ? previous.tokenBalances.map((tb) =>
            tb.address === config.tokenAddress
              ? { ...tb, transparent: tokenBalance }
              : tb,
          )
        : [{ name: tokenName, address: config.tokenAddress, decimals: tokenDecimals, transparent: tokenBalance, private: 0n, noteCount: 0 }],
    }));
  }, [provider, account, config.tokenAddress, config.feeTokenAddress]);

  return { state, loading, error, refresh, refreshBalances };
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

function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}
