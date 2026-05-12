import { useState } from "react";
import { Icon } from "./Icon.tsx";

type Props = {
  value: string;
  label?: string;
  inline?: boolean;
};

export function CopyButton({ value, label, inline }: Props) {
  const [copied, setCopied] = useState(false);

  function onCopy() {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (inline) {
    return (
      <button
        type="button"
        className="btn-quiet"
        style={{
          padding: 4,
          borderRadius: 6,
          display: "inline-grid",
          placeItems: "center",
        }}
        onClick={onCopy}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
      </button>
    );
  }

  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy}>
      {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
      {copied ? "Copied" : label ?? "Copy"}
    </button>
  );
}
