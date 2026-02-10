import type { PrivateState } from "../hooks/usePrivateState.ts";

type Props = {
  state: PrivateState;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

function formatAmount(value: bigint): string {
  return value.toString();
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
        <h3>Notes ({state.notes.length})</h3>
        {state.notes.length === 0 ? (
          <p className="empty">No notes discovered</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Note ID</th>
                <th>Amount</th>
                <th>Sender</th>
                <th>Channel Key</th>
                <th>Nonce</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {state.notes.map((note) => (
                <tr key={note.id}>
                  <td>{note.id}</td>
                  <td>{formatAmount(note.amount)}</td>
                  <td>
                    {note.sender}
                    {note.isSelfSender && <span className="chip">self</span>}
                  </td>
                  <td>{note.channelKey}</td>
                  <td>{note.nonce}</td>
                  <td>{note.open ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                <th>Public Key</th>
                <th>Channel Key</th>
                <th>Note Nonce</th>
                <th>Token</th>
              </tr>
            </thead>
            <tbody>
              {state.channels.map((channel, index) => (
                <tr key={index}>
                  <td>
                    {channel.recipient}
                    {channel.isSelf && <span className="chip">self</span>}
                  </td>
                  <td>{channel.publicKey}</td>
                  <td>{channel.channelKey}</td>
                  <td>{channel.noteNonce}</td>
                  <td>
                    {channel.tokens.map((tokenEntry, tokenIndex) => (
                      <div key={tokenIndex}>
                        {tokenEntry.tokenAddress}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
