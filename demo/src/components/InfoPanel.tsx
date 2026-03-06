import { useState } from "react";
import type {
  IncomingChannelCard,
  OutgoingChannelCard,
  TokenNoteGroup,
  NoteDisplay,
  PrivateState,
} from "../hooks/usePrivateState.ts";
import type { TransactionDisplay } from "../hooks/useHistory.ts";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { formatTokenAmount, truncateAddress } from "../format.ts";

const NOTES_PER_PAGE = 5;

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-copy-button"
      title={copied ? "Copied!" : "Copy full value"}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "\u2713" : "\u29C9"}
    </button>
  );
}

function TokenSubgroup({ group }: { group: TokenNoteGroup }) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(group.notes.length / NOTES_PER_PAGE));
  const clampedPage = Math.min(page, totalPages - 1);
  const visibleNotes = group.notes.slice(
    clampedPage * NOTES_PER_PAGE,
    (clampedPage + 1) * NOTES_PER_PAGE,
  );

  return (
    <div className="token-subgroup">
      <div className="token-subgroup-header">
        <span className="channel-card-label">{group.tokenName}</span>
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Notes</span>{" "}
        <span className="channel-card-value">{group.notes.length}</span>
      </div>
      <table>
        <colgroup>
          <col className="col-note-id" />
          <col className="col-amount" />
          <col className="col-index" />
        </colgroup>
        <thead>
          <tr>
            <th>Note ID</th>
            <th>Amount</th>
            <th>Index</th>
          </tr>
        </thead>
        <tbody>
          {visibleNotes.map((note: NoteDisplay) => (
            <tr key={note.id}>
              <td>
                {note.id}
                <CopyButton value={`0x${note.rawId.toString(16)}`} />
              </td>
              <td>
                {formatTokenAmount(note.amount, note.decimals)}
                {note.open && <span className="chip">open</span>}
              </td>
              <td>{note.nonce}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="pagination">
          <button
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
          >
            Newer
          </button>
          <span>
            {clampedPage + 1} / {totalPages}
          </span>
          <button
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            Older
          </button>
        </div>
      )}
    </div>
  );
}

function IncomingCard({ card }: { card: IncomingChannelCard }) {
  return (
    <div className="channel-card">
      <div className="channel-card-header">
        <span className="channel-card-label">Sender</span>{" "}
        {card.senderName === "Self" ? (
          <span className="self-label">Self</span>
        ) : (
          <span className="channel-card-value">{card.senderName ?? card.sender}</span>
        )}
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Channel Key</span>{" "}
        <span className="channel-card-value">
          {card.channelKey}
          <CopyButton value={card.rawChannelKey} />
        </span>
      </div>
      {card.tokenGroups.map((tokenGroup) => (
        <TokenSubgroup key={tokenGroup.tokenAddress} group={tokenGroup} />
      ))}
    </div>
  );
}

function OutgoingCard({ card }: { card: OutgoingChannelCard }) {
  return (
    <div className="channel-card">
      <div className="channel-card-header">
        <span className="channel-card-label">Recipient</span>{" "}
        {card.recipientName === "Self" ? (
          <span className="self-label">Self</span>
        ) : (
          <span className="channel-card-value">{card.recipientName ?? card.recipient}</span>
        )}
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Channel Key</span>{" "}
        <span className="channel-card-value">
          {card.channelKey}
          <CopyButton value={card.rawChannelKey} />
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Next Note Index</th>
          </tr>
        </thead>
        <tbody>
          {card.tokens.map((token) => (
            <tr key={token.tokenAddress}>
              <td>{token.tokenName}</td>
              <td>{token.noteNonce}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Props = {
  state: PrivateState;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  historyTransactions: TransactionDisplay[];
  explorerUrl?: string;
  historyLoading: boolean;
  historyError: string | null;
  historyComplete: boolean;
  onFetchHistory: () => void;
};

export function InfoPanel({
  state,
  loading,
  error,
  onRefresh,
  historyTransactions,
  explorerUrl,
  historyLoading,
  historyError,
  historyComplete,
  onFetchHistory,
}: Props) {
  const [view, setView] = useState<"notes" | "channels" | "activity">("activity");

  return (
    <div className="island">
      <div className="island-header">
        <h2>State</h2>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error && <div className="error">Error: {error}</div>}

      <div>
        Registered:{" "}
        {state.isRegistered === null ? (
          <span className="chip">unknown</span>
        ) : state.isRegistered ? (
          <span className="chip chip-ok">yes</span>
        ) : (
          <span className="chip chip-no">no</span>
        )}
      </div>

      <div className="balances">
        <h3>Balances</h3>
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Private</th>
              <th>Notes</th>
              <th>Transparent</th>
              <th>Token Address</th>
            </tr>
          </thead>
          <tbody>
            {state.tokenBalances.map((tb) => (
              <tr key={tb.address}>
                <td>
                  {tb.name}
                  {tb.fee && <span className="chip">fee</span>}
                </td>
                <td>{formatTokenAmount(tb.private, tb.decimals)}</td>
                <td>{tb.noteCount}</td>
                <td>{formatTokenAmount(tb.transparent, tb.decimals)}</td>
                <td>
                  {truncateAddress(tb.address)}
                  <CopyButton value={tb.address} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="tab-section">
        <div className="tab-bar">
          <h3
            className={`tab ${view === "activity" ? "tab-active" : ""}`}
            onClick={() => setView("activity")}
          >
            Activity
          </h3>
          <h3
            className={`tab ${view === "notes" ? "tab-active" : ""}`}
            onClick={() => setView("notes")}
          >
            Unspent Notes
          </h3>
          <h3
            className={`tab ${view === "channels" ? "tab-active" : ""}`}
            onClick={() => setView("channels")}
          >
            Outgoing Channels
          </h3>
        </div>

        {view === "notes" && (
          <div className="notes-section">
            {state.incomingCards.length === 0 ? (
              <p className="empty">No notes discovered</p>
            ) : (
              <div className="cards-grid">
                {state.incomingCards.map((card) => (
                  <IncomingCard key={card.cardKey} card={card} />
                ))}
              </div>
            )}
          </div>
        )}

        {view === "channels" && (
          <div className="channels-section">
            {state.outgoingCards.length === 0 ? (
              <p className="empty">No channels discovered</p>
            ) : (
              <div className="cards-grid">
                {state.outgoingCards.map((card) => (
                  <OutgoingCard key={card.cardKey} card={card} />
                ))}
              </div>
            )}
          </div>
        )}

        {view === "activity" && (
          <HistoryPanel
            transactions={historyTransactions}
            explorerUrl={explorerUrl}
            loading={historyLoading}
            error={historyError}
            historyComplete={historyComplete}
            onFetchMore={onFetchHistory}
          />
        )}
      </div>
    </div>
  );
}
