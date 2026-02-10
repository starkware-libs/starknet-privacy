import { useState, type FormEvent } from "react";
import type { AccountConfig } from "../config.ts";

type Props = {
  accounts: AccountConfig[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onAdd: (account: AccountConfig) => void;
};

export function AccountSelector({ accounts, activeIndex, onSelect, onAdd }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [viewingKey, setViewingKey] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !address || !privateKey || !viewingKey) return;
    onAdd({ name, address, privateKey, viewingKey });
    setName("");
    setAddress("");
    setPrivateKey("");
    setViewingKey("");
    setShowForm(false);
  }

  return (
    <div className="account-selector">
      <label>
        Account:{" "}
        <select
          value={activeIndex}
          onChange={(event) => onSelect(Number(event.target.value))}
        >
          {accounts.map((account, index) => (
            <option key={index} value={index}>
              {account.name} ({account.address.slice(0, 10)}...)
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => setShowForm(!showForm)}>
        {showForm ? "Cancel" : "+ Add Account"}
      </button>
      {showForm && (
        <form onSubmit={handleSubmit} className="add-account-form">
          <input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <input placeholder="Address (0x...)" value={address} onChange={(event) => setAddress(event.target.value)} />
          <input placeholder="Private Key (0x...)" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} />
          <input placeholder="Viewing Key (0x...)" value={viewingKey} onChange={(event) => setViewingKey(event.target.value)} />
          <button type="submit">Add</button>
        </form>
      )}
    </div>
  );
}
