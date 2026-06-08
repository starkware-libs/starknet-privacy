import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

export function AmountInput({
  value,
  onChange,
  readOnly,
  autoFocus,
  placeholder = "0",
}: Props) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      value={value}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^0-9.]/g, "");
        const parts = cleaned.split(".");
        const safe =
          parts.length > 1
            ? `${parts[0] ?? ""}.${parts.slice(1).join("")}`
            : cleaned;
        onChange?.(safe);
      }}
      className="w-full bg-transparent font-sans text-[2.6rem] font-light leading-none tracking-tight text-foreground placeholder:text-foreground-subtle/60 focus:outline-none [font-variant-numeric:tabular-nums]"
    />
  );
}
