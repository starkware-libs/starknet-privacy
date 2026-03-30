import { useState } from "react";
import type { AccountConfig } from "../config.ts";
import { buildShareUrl } from "../hooks/useAccounts.ts";

type Props = {
  accounts: AccountConfig[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onSave: (raw: string) => string | null;
};

function serializeAccounts(accounts: AccountConfig[]): string {
  return accounts.length > 0 ? JSON.stringify(accounts, null, 2) : "";
}

export function AccountSelector({
  accounts,
  activeIndex,
  onSelect,
  onSave,
}: Props) {
  const [editText, setEditText] = useState(() => serializeAccounts(accounts));
  const [editError, setEditError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(accounts.length === 0);
  const [copied, setCopied] = useState(false);

  const handleSave = () => {
    const error = onSave(editText);
    if (error) {
      setEditError(error);
    } else {
      setEditError(null);
      setShowEdit(false);
    }
  };

  const toggleEdit = () => {
    if (!showEdit) {
      setEditText(serializeAccounts(accounts));
      setEditError(null);
    }
    setShowEdit(!showEdit);
  };

  const handleShare = () => {
    const url = buildShareUrl(accounts);
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`account-selector${showEdit ? " account-selector-import" : ""}`}>
      <div className="account-selector-row">
        <label>Account:</label>
        <div className="account-tabs">
          {accounts.map((account, index) =>
            account.admin ? null : (
              <button
                key={account.address}
                className={index === activeIndex ? "account-tab active" : "account-tab"}
                onClick={() => onSelect(index)}
              >
                {account.name}
                <span className="account-tab-address">
                  ({account.address.slice(0, 10)}...)
                </span>
              </button>
            ),
          )}
          <button className="account-tab import-toggle" onClick={toggleEdit}>
            Edit
          </button>
          {accounts.length > 0 && (
            <button className="account-tab import-toggle" onClick={handleShare}>
              {copied ? "Copied!" : "Share"}
            </button>
          )}
        </div>
      </div>
      {showEdit && (
        <div className="import-form">
          <textarea
            className="import-textarea"
            placeholder='[{"name":"Alice","address":"0x...","privateKey":"0x...","viewingKey":"0x..."}]'
            value={editText}
            onChange={(event) => {
              setEditText(event.target.value);
              setEditError(null);
            }}
            rows={5}
          />
          {editError && <span className="error">{editError}</span>}
          <button onClick={handleSave} disabled={!editText.trim()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
