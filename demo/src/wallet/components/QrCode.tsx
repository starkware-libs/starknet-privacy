// "Visual hash" rendering of an address. Not a real QR (which would need a
// dependency or a hand-rolled encoder with too much surface for bugs); instead
// a deterministic 16×16 grid derived from the address that keeps the receive
// screen visually anchored. Pair with the copy button — that's how addresses
// actually get shared in 2025 wallets anyway.

function hashAddress(address: string): bigint {
  // FNV-1a over the hex bytes, then derive a 256-bit seed by repeated mixing.
  const trimmed = address.toLowerCase().replace(/^0x/, "");
  let seed = 0xcbf29ce484222325n;
  for (let offset = 0; offset < trimmed.length; offset += 1) {
    seed ^= BigInt(trimmed.charCodeAt(offset));
    seed = (seed * 0x100000001b3n) & ((1n << 256n) - 1n);
  }
  return seed;
}

export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const seed = hashAddress(value);
  const cells = 16;
  const cell = size / cells;
  // Derive 128 bits and mirror left↔right for a symmetric, identicon-like look.
  let state = seed;
  function nextBit(): boolean {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return ((state >> 31n) & 1n) === 1n;
  }
  const grid: boolean[][] = Array.from({ length: cells }, () => new Array(cells).fill(false));
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells / 2; col += 1) {
      const dark = nextBit();
      grid[row][col] = dark;
      grid[row][cells - 1 - col] = dark;
    }
  }
  const paths: string[] = [];
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      if (grid[row][col]) {
        paths.push(`M${col * cell + 1},${row * cell + 1}h${cell - 2}v${cell - 2}h-${cell - 2}z`);
      }
    }
  }
  return (
    <div
      className="qr-frame"
      style={{
        background: "linear-gradient(135deg, #14162a, #1c2042)",
        boxShadow: "0 12px 40px -12px rgba(124, 92, 255, 0.5)",
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="qrgrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7c5cff" />
            <stop offset="60%" stopColor="#4d80ff" />
            <stop offset="100%" stopColor="#21d4fd" />
          </linearGradient>
        </defs>
        <path d={paths.join(" ")} fill="url(#qrgrad)" />
      </svg>
    </div>
  );
}
