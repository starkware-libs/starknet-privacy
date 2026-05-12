import type { TokenConfig } from "../../config.ts";

type Props = {
  amount: string;
  onAmount: (value: string) => void;
  token: string;
  onToken: (address: string) => void;
  tokens: TokenConfig[];
  onMax?: () => void;
  placeholder?: string;
  disabled?: boolean;
};

export function AmountInput({
  amount,
  onAmount,
  token,
  onToken,
  tokens,
  onMax,
  placeholder = "0",
  disabled,
}: Props) {
  return (
    <div className="amt">
      <input
        className="amt-input tabular"
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(event) => onAmount(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <div className="amt-side">
        <label className="amt-token-btn">
          <select
            value={token}
            onChange={(event) => onToken(event.target.value)}
            disabled={disabled}
          >
            {tokens.map((tokenConfig) => (
              <option key={tokenConfig.address} value={tokenConfig.address}>
                {tokenConfig.name}
              </option>
            ))}
          </select>
        </label>
        {onMax && (
          <button type="button" className="amt-max" onClick={onMax} disabled={disabled}>
            Max
          </button>
        )}
      </div>
    </div>
  );
}
