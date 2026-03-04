import { useState } from "react";
import type { ChannelGroup, NoteDisplay } from "../hooks/usePrivateState.ts";
import type { PrivateState } from "../hooks/usePrivateState.ts";

const NOTES_PER_PAGE = 10;

type Props = {
  state: PrivateState;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

function formatAmount(value: bigint): string {
  return value.toLocaleString("en-US");
}

function ChannelCard({ group }: { group: ChannelGroup }) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(group.notes.length / NOTES_PER_PAGE));
  const clampedPage = Math.min(page, totalPages - 1);
  const visibleNotes = group.notes.slice(
    clampedPage * NOTES_PER_PAGE,
    (clampedPage + 1) * NOTES_PER_PAGE,
  );

  return (
    <div className="channel-card">
      <div className="channel-card-header">
        <span className="channel-card-label">Sender</span>{" "}
        <span className="channel-card-value">{group.sender}</span>
        {group.senderName && <span className="chip">{group.senderName}</span>}
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Token</span>{" "}
        <span className="channel-card-value">{group.token}</span>
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Channel Key</span>{" "}
        <span className="channel-card-value">{group.channelKey}</span>
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Unspent Notes</span>{" "}
        <span className="channel-card-value">{group.notes.length}</span>
      </div>
      <table>
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
              <td>{note.id}</td>
              <td>{formatAmount(note.amount)}</td>
              <td>
                {note.nonce}
                {note.open && <span className="chip">open</span>}
              </td>
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

export function InfoPanel({ state, loading, error, onRefresh }: Props) {
  return (
    <div className="info-panel">
      <h2>
        State{" "}
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </h2>
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
          <tbody>
            <tr>
              <td>Fee Token</td>
              <td>{formatAmount(state.feeTokenBalance)}</td>
            </tr>
            <tr>
              <td>Token (transparent)</td>
              <td>{formatAmount(state.tokenBalance)}</td>
            </tr>
            <tr>
              <td>Token (private)</td>
              <td>{formatAmount(state.privateBalance)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="notes-section">
        <h3>Unspent Notes ({state.notes.length})</h3>
        {state.channelGroups.length === 0 ? (
          <p className="empty">No notes discovered</p>
        ) : (
          state.channelGroups.map((group) => (
            <ChannelCard key={group.channelKey} group={group} />
          ))
        )}
      </div>

      <div className="channels-section">
        <h3>Outgoing Channels ({state.channels.length})</h3>
        {state.channels.length === 0 ? (
          <p className="empty">No channels discovered</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Token</th>
                <th>Channel Key</th>
                <th>Next Note Index</th>
              </tr>
            </thead>
            <tbody>
              {state.channels.map((channel, index) => (
                <tr key={index}>
                  <td>
                    {channel.recipient}
                    {channel.recipientName && <span className="chip">{channel.recipientName}</span>}
                  </td>
                  <td>
                    {channel.tokens.map((tokenEntry, tokenIndex) => (
                      <div key={tokenIndex}>
                        {tokenEntry.tokenAddress}
                      </div>
                    ))}
                  </td>
                  <td>{channel.channelKey}</td>
                  <td>{channel.noteNonce}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
