/** Decode a hex-encoded ASCII chain ID (e.g. 0x534e5f...) to a readable name. */
export function formatChainId(hex: string): string {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  let name = "";
  for (let offset = 0; offset < raw.length; offset += 2) {
    name += String.fromCharCode(parseInt(raw.slice(offset, offset + 2), 16));
  }
  return name;
}

/** Truncate a hex address for display: 0x1234abcd...ef01 */
export function truncateAddress(hex: string): string {
  const padded = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (padded.length <= 14) return padded;
  return `${padded.slice(0, 10)}...${padded.slice(-4)}`;
}

/**
 * Convert a human-readable amount string (e.g. "100", "0.5") to raw units.
 * Uses pure string/bigint arithmetic — no floating point — to avoid rounding errors.
 */
export function toRawAmount(humanAmount: string, decimals: number): bigint {
  const [wholePart, fractionPart = ""] = humanAmount.split(".");
  if (fractionPart.length > decimals) {
    throw new Error(`Too many decimal places: ${fractionPart.length} > ${decimals}`);
  }
  const paddedFraction = fractionPart.padEnd(decimals, "0");
  return BigInt(wholePart + paddedFraction);
}

/** Format a raw amount to a human-readable string with up to `maxFraction` decimal places. */
export function formatTokenAmount(rawAmount: bigint, decimals: number, maxFraction = 4): string {
  if (decimals === 0) return rawAmount.toLocaleString("en-US");

  const divisor = 10n ** BigInt(decimals);
  const wholePart = rawAmount / divisor;
  const remainder = rawAmount % divisor;

  if (remainder === 0n) return wholePart.toLocaleString("en-US");

  // Pad remainder to `decimals` digits, then trim trailing zeros up to maxFraction
  const fractionFull = remainder.toString().padStart(decimals, "0");
  const fractionTrimmed = fractionFull.slice(0, maxFraction).replace(/0+$/, "");

  if (!fractionTrimmed) return wholePart.toLocaleString("en-US");
  return `${wholePart.toLocaleString("en-US")}.${fractionTrimmed}`;
}
