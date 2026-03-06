import { useState } from "react";
import type { ChannelGroup, NoteDisplay } from "../hooks/usePrivateState.ts";
import type { PrivateState } from "../hooks/usePrivateState.ts";
import { formatTokenAmount } from "../format.ts";

const NOTES_PER_PAGE = 5;

type Props = {
  state: PrivateState;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

function ChannelCard({ group }: { group: ChannelGroup }) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(group.notes.length / NOTES_PER_PAGE));
  const clampedPage = Math.min(page, totalPages - 1);
  const visibleNotes = group.notes.slice(
    clampedPage * NOTES_PER_PAGE,
    (clampedPage + 1) * NOTES_PER_PAGE
  );

  return (
    <div className="channel-card">
      <div className="channel-card-header">
        <span className="channel-card-label">Sender</span>{" "}
        <span className="channel-card-value">{group.sender}</span>
        {group.senderName && <span className="chip">{group.senderName}</span>}
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Channel Key</span>{" "}
        <span className="channel-card-value">{group.channelKey}</span>
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Token</span>{" "}
        <span className="channel-card-value">{group.token}</span>
        <span className="chip">{group.tokenName.toLowerCase()}</span>
        <span className="channel-card-sep">|</span>
        <span className="channel-card-label">Unspent Notes</span>{" "}
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
                {note.open && <span className="chip">open</span>}
              </td>
              <td>{formatTokenAmount(note.amount, note.decimals)}</td>
              <td>{note.nonce}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
            Newer
          </button>
          <span>
            {clampedPage + 1} / {totalPages}
          </span>
          <button disabled={clampedPage >= totalPages - 1} onClick={() => setPage(clampedPage + 1)}>
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
          <thead>
            <tr>
              <th>Token</th>
              <th>Transparent</th>
              <th>Private</th>
            </tr>
          </thead>
          <tbody>
            {state.tokenBalances.map((tb) => (
              <tr key={tb.address}>
                <td>{tb.name}</td>
                <td>{formatTokenAmount(tb.transparent, tb.decimals)}</td>
                <td>{formatTokenAmount(tb.private, tb.decimals)}</td>
              </tr>
            ))}
            <tr>
              <td>Fee Token</td>
              <td>{formatTokenAmount(state.feeTokenBalance, 18)}</td>
              <td>&mdash;</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="notes-section">
        <h3>Unspent Notes ({state.notes.length})</h3>
        {state.channelGroups.length === 0 ? (
          <p className="empty">No notes discovered</p>
        ) : (
          state.channelGroups.map((group) => <ChannelCard key={group.groupKey} group={group} />)
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
                <th>Channel Key</th>
                <th>Token</th>
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
                  <td>{channel.channelKey}</td>
                  <td>
                    {channel.tokenAddress}
                    <span className="chip">{channel.tokenName.toLowerCase()}</span>
                  </td>
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
