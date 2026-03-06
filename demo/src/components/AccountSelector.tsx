import type { AccountConfig } from "../config.ts";

type Props = {
  accounts: AccountConfig[];
  activeIndex: number;
  onSelect: (index: number) => void;
};

export function AccountSelector({ accounts, activeIndex, onSelect }: Props) {
  return (
    <div className="account-selector">
      <label>Account:</label>
      <div className="account-tabs">
        {accounts.map((account, index) => (
          <button
            key={account.address}
            className={index === activeIndex ? "account-tab active" : "account-tab"}
            onClick={() => onSelect(index)}
          >
            {account.name}
            <span className="account-tab-address">({account.address.slice(0, 10)}...)</span>
          </button>
        ))}
      </div>
    </div>
  );
}
