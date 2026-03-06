import { useState, useCallback, useEffect } from "react";
import type { RpcProvider } from "starknet";
import {
  SetupRequirement,
  type Note,
  type Channel,
  type PrivateTransfersInterface,
} from "starknet-sdk";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { AppConfig, AccountConfig } from "../config.ts";
import { getErc20Balance } from "../starknet.ts";

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
  nonce: number;
  open: boolean;
};

export type ChannelDisplay = {
  recipient: string;
  recipientName: string | null;
  publicKey: string;
  channelKey: string;
  noteNonce: number;
  tokenAddress: string;
  tokenName: string;
};

export type ChannelGroup = {
  groupKey: string;
  channelKey: string;
  sender: string;
  senderName: string | null;
  token: string;
  tokenName: string;
  notes: NoteDisplay[];
};

export type TokenBalance = {
  name: string;
  address: string;
  decimals: number;
  transparent: bigint;
  private: bigint;
};

export type PrivateState = {
  isRegistered: boolean | null;
  tokenBalances: TokenBalance[];
  feeTokenBalance: bigint;
  notes: NoteDisplay[];
  channelGroups: ChannelGroup[];
  channels: ChannelDisplay[];
};

const EMPTY_STATE: PrivateState = {
  isRegistered: null,
  tokenBalances: [],
  feeTokenBalance: 0n,
  notes: [],
  channelGroups: [],
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
  allAccounts: AccountConfig[],
  poolAddress: string,
  config: AppConfig
) {
  const [state, setState] = useState<PrivateState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset displayed state when the active account or pool changes so stale
  // data from the previous selection is never shown.
  useEffect(() => {
    setState(EMPTY_STATE);
  }, [account, poolAddress]);

  const refresh = useCallback(async () => {
    if (!provider || !transfers || !account) return;
    setLoading(true);
    setError(null);

    try {
      const indexer = new IndexerDiscoveryProvider(config.indexerUrl, poolAddress);

      const allTokenAddresses = config.tokens.map((t) => BigInt(t.address));
      const tokenNameByBigInt = new Map(config.tokens.map((t) => [BigInt(t.address), t.name]));
      const tokenDecimalsByBigInt = new Map(
        config.tokens.map((t) => [BigInt(t.address), t.decimals])
      );

      const [
        transparentBalances,
        feeTokenBalance,
        { notes: notesMap },
        channelsResult,
        requirement,
      ] = await Promise.all([
        Promise.all(
          config.tokens.map((t) => getErc20Balance(provider, t.address, account.address))
        ),
        getErc20Balance(provider, config.feeTokenAddress, account.address),
        transfers.discoverNotes({ tokens: allTokenAddresses }),
        indexer.discoverChannels(BigInt(account.address), BigInt(account.viewingKey), "all"),
        indexer.discoverRequirement(
          BigInt(account.address),
          BigInt(account.viewingKey),
          BigInt(account.address),
          allTokenAddresses[0] ?? 0n
        ),
      ]);
      const isRegistered = requirement !== SetupRequirement.Register;

      const nameByAddress = new Map<bigint, string>();
      for (const acc of allAccounts) {
        const accAddress = BigInt(acc.address);
        nameByAddress.set(
          accAddress,
          accAddress === BigInt(account.address) ? "self" : acc.name.toLowerCase()
        );
      }

      // Build notes from all tokens, deduplicating by note ID
      const allNotes: NoteDisplay[] = [];
      const seenNoteIds = new Set<bigint>();
      const privateBalanceByToken = new Map<string, bigint>();

      for (const [tokenBigInt, tokenNotes] of notesMap) {
        const tokenHex = `0x${tokenBigInt.toString(16)}`;
        const tokenName =
          tokenNameByBigInt.get(tokenBigInt) ?? truncateAddress(tokenBigInt.toString(16));
        const tokenDecimals = tokenDecimalsByBigInt.get(tokenBigInt) ?? 0;

        let privateBalance = 0n;
        for (const note of tokenNotes as Note[]) {
          const noteIdBigInt = toBigInt(note.id);
          if (seenNoteIds.has(noteIdBigInt)) continue;
          seenNoteIds.add(noteIdBigInt);

          privateBalance += note.amount;
          const witness = readWitness(note.witness);
          const senderBigInt = toBigInt(note.sender);
          allNotes.push({
            id: formatBigInt(noteIdBigInt),
            rawId: noteIdBigInt,
            amount: note.amount,
            decimals: tokenDecimals,
            token: truncateAddress(tokenBigInt.toString(16)),
            tokenName,
            sender: truncateAddress(senderBigInt.toString(16)),
            senderName: nameByAddress.get(senderBigInt) ?? null,
            channelKey: formatBigInt(witness.channelKey),
            nonce: witness.nonce,
            open: note.open ?? false,
          });
        }
        privateBalanceByToken.set(tokenHex.toLowerCase(), privateBalance);
      }

      // Build per-token balance rows
      const tokenBalances: TokenBalance[] = config.tokens.map((t, index) => ({
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        transparent: transparentBalances[index],
        private: privateBalanceByToken.get(t.address.toLowerCase()) ?? 0n,
      }));

      const channels: ChannelDisplay[] = [];
      for (const [recipient, channel] of channelsResult.channels) {
        const internal = readChannel(channel);
        for (const [tokenAddress, tokenChannel] of internal.tokens) {
          channels.push({
            recipient: truncateAddress(recipient.toString(16)),
            recipientName: nameByAddress.get(recipient) ?? null,
            publicKey: formatBigInt(internal.publicKey),
            channelKey: internal.key ? formatBigInt(internal.key) : "N/A",
            noteNonce: tokenChannel.noteNonce,
            tokenAddress: truncateAddress(tokenAddress.toString(16)),
            tokenName:
              tokenNameByBigInt.get(tokenAddress) ?? truncateAddress(tokenAddress.toString(16)),
          });
        }
      }

      const groupsByKey = new Map<string, NoteDisplay[]>();
      for (const note of allNotes) {
        const groupKey = `${note.sender}::${note.token}`;
        const existing = groupsByKey.get(groupKey);
        if (existing) {
          existing.push(note);
        } else {
          groupsByKey.set(groupKey, [note]);
        }
      }

      const channelGroups: ChannelGroup[] = [];
      for (const [groupKey, groupNotes] of groupsByKey) {
        groupNotes.sort((a, b) => b.nonce - a.nonce);
        const firstNote = groupNotes[0];
        channelGroups.push({
          groupKey,
          channelKey: firstNote.channelKey,
          sender: firstNote.sender,
          senderName: firstNote.senderName,
          token: firstNote.token,
          tokenName: firstNote.tokenName,
          notes: groupNotes,
        });
      }
      channelGroups.sort((a, b) => b.notes[0].nonce - a.notes[0].nonce);

      setState({
        isRegistered,
        tokenBalances,
        feeTokenBalance,
        notes: allNotes,
        channelGroups,
        channels,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [provider, transfers, account, allAccounts, poolAddress, config]);

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
