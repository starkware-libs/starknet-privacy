/** Decode a hex-encoded ASCII chain ID (e.g. 0x534e5f...) to a readable name. */
export function formatChainId(hex: string): string {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  let name = "";
  for (let offset = 0; offset < raw.length; offset += 2) {
    name += String.fromCharCode(parseInt(raw.slice(offset, offset + 2), 16));
  }
  return name;
}

/** Format a bigint token amount for display, optionally with decimal places. */
export function formatAmount(value: bigint, decimals?: number): string {
  if (decimals == null || decimals === 0) {
    return value.toLocaleString("en-US");
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const remainder = value % divisor;
  const fractionStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeFormatted = whole.toLocaleString("en-US");
  return fractionStr ? `${wholeFormatted}.${fractionStr}` : wholeFormatted;
}

const SUPERSCRIPT_DIGITS = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079";

function toSuperscript(value: number): string {
  return value.toString().split("").map((digit) => SUPERSCRIPT_DIGITS[Number(digit)]).join("");
}

/** Format a bigint token amount with capped fractional digits.
 *  Falls back to multiplication notation (e.g. 1×10⁻⁵) for values too small to show within maxFraction. */
export function formatTokenAmount(rawAmount: bigint, decimals: number, maxFraction = 4): string {
  if (rawAmount === 0n) return "0";
  if (decimals === 0) return rawAmount.toLocaleString("en-US");

  const divisor = 10n ** BigInt(decimals);
  const wholePart = rawAmount / divisor;
  const remainder = rawAmount % divisor;

  if (remainder === 0n) return wholePart.toLocaleString("en-US");

  const fractionFull = remainder.toString().padStart(decimals, "0");
  const fractionTrimmed = fractionFull.slice(0, maxFraction).replace(/0+$/, "");

  if (fractionTrimmed) {
    return `${wholePart.toLocaleString("en-US")}.${fractionTrimmed}`;
  }

  // Significant digits are beyond maxFraction — use multiplication notation
  if (wholePart === 0n) {
    const leadingZeros = fractionFull.match(/^0*/)![0].length;
    const significant = fractionFull.slice(leadingZeros).replace(/0+$/, "");
    const exponent = leadingZeros + 1;
    const mantissa = significant.length > 1
      ? `${significant[0]}.${significant.slice(1, 4).replace(/0+$/, "")}`
      : significant;
    return `${mantissa}\u00b710\u207b${toSuperscript(exponent)}`;
  }

  return wholePart.toLocaleString("en-US");
}

/** Convert a human-readable amount string (e.g. "100", "0.5") to raw bigint units. */
export function toRawAmount(humanAmount: string, decimals: number): bigint {
  const [wholePart, fractionPart = ""] = humanAmount.trim().split(".");
  if (fractionPart.length > decimals) {
    throw new Error(`Too many decimal places: ${fractionPart.length} > ${decimals}`);
  }
  const paddedFraction = fractionPart.padEnd(decimals, "0");
  return BigInt((wholePart || "0") + paddedFraction);
}

/** Format a unix timestamp as a relative or absolute time string. */
export function formatRelativeTime(timestampSecs: number): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const diffSecs = nowSecs - timestampSecs;

  if (diffSecs < 60) return `${Math.max(0, diffSecs)}s ago`;
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) {
    const date = new Date(timestampSecs * 1000);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    }
  }
  const date = new Date(timestampSecs * 1000);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    + " " + date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Truncate a hex address for display: 0x1234abcd...ef01 */
export function truncateAddress(hex: string): string {
  const padded = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (padded.length <= 14) return padded;
  return `${padded.slice(0, 10)}...${padded.slice(-4)}`;
}
