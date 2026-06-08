import type { Token } from "../types";

interface Props {
  token: Token;
  size?: number;
}

// Hand-tuned brand SVGs for the four tokens that appear in the demo. Falls
// back to a tinted-letter disc for anything else. Inline rather than packaged
// (a) to control look-and-feel against the dark theme and (b) to avoid pulling
// in an icon library.
export function BrandIcon({ token, size = 28 }: Props) {
  const Render = BRAND_ICONS[token.id];
  if (Render) {
    // The shield silhouette is non-circular, so a pill ring would draw a
    // halo around it. Other tokens keep the disc treatment.
    const isShield = token.id === "strk-starknet";
    return (
      <span
        className={
          isShield
            ? "inline-flex items-center justify-center"
            : "inline-flex items-center justify-center rounded-pill ring-1 ring-black/30"
        }
        style={{ width: size, height: size }}
      >
        <Render size={size} />
      </span>
    );
  }
  return <LetterDisc token={token} size={size} />;
}

type IconComponent = (props: { size: number }) => JSX.Element;

const BRAND_ICONS: Record<string, IconComponent> = {
  "strk-starknet": StrkIcon,
  "eth-ethereum": EthIcon,
  "usdc-ethereum": UsdcIcon,
  "sol-solana": SolIcon,
};

function StrkIcon({ size }: { size: number }) {
  // Shielded-STRK badge: navy shield with double border, white + orange waves,
  // plus the upper-right sparkle and lower-left dot from the reference logo.
  // The waves share endpoints so the white sits flush above the orange.
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-label="STRK"
      role="img"
    >
      <defs>
        <clipPath id="strkShieldClip">
          <path d="M16 2.2 C 19.6 2.2 23.6 2.7 26.6 3.4 C 27.6 3.6 28.3 4.4 28.4 5.4 C 28.7 9.6 28.6 17.4 26.7 22 C 24.6 27 19.6 29.5 16.6 30.6 C 16.2 30.7 15.8 30.7 15.4 30.6 C 12.4 29.5 7.4 27 5.3 22 C 3.4 17.4 3.3 9.6 3.6 5.4 C 3.7 4.4 4.4 3.6 5.4 3.4 C 8.4 2.7 12.4 2.2 16 2.2 Z" />
        </clipPath>
      </defs>
      <path
        d="M16 2.2 C 19.6 2.2 23.6 2.7 26.6 3.4 C 27.6 3.6 28.3 4.4 28.4 5.4 C 28.7 9.6 28.6 17.4 26.7 22 C 24.6 27 19.6 29.5 16.6 30.6 C 16.2 30.7 15.8 30.7 15.4 30.6 C 12.4 29.5 7.4 27 5.3 22 C 3.4 17.4 3.3 9.6 3.6 5.4 C 3.7 4.4 4.4 3.6 5.4 3.4 C 8.4 2.7 12.4 2.2 16 2.2 Z"
        fill="#23308A"
      />
      <path
        d="M16 4.4 C 19.2 4.4 22.8 4.85 25.5 5.45 C 26.2 5.6 26.6 6.1 26.65 6.8 C 26.95 10.7 26.85 17.2 25.15 21.25 C 23.35 25.55 19 27.75 16.35 28.7 C 16.12 28.78 15.88 28.78 15.65 28.7 C 13 27.75 8.65 25.55 6.85 21.25 C 5.15 17.2 5.05 10.7 5.35 6.8 C 5.4 6.1 5.8 5.6 6.5 5.45 C 9.2 4.85 12.8 4.4 16 4.4 Z"
        fill="none"
        stroke="#5267C8"
        strokeWidth="1.1"
      />
      <g clipPath="url(#strkShieldClip)">
        <path
          d="M2 15.6 C 6 11.8 10 17.4 14.5 16.2 C 19 15 23.5 11 30 12.6 L 30 17.4 C 23.5 16.2 19 19.4 14.5 20.4 C 10 21.4 6 17.6 2 19.6 Z"
          fill="#FFFFFF"
        />
        <path
          d="M2 19.6 C 6 17.6 10 21.4 14.5 20.4 C 19 19.4 23.5 16.2 30 17.4 L 30 22.6 C 23.5 21.6 19 24.6 14.5 25.4 C 10 26.2 6 23 2 24.4 Z"
          fill="#FF5C2A"
        />
      </g>
      <path
        d="M23.2 7.4 L 23.75 9.4 L 25.75 9.95 L 23.75 10.5 L 23.2 12.5 L 22.65 10.5 L 20.65 9.95 L 22.65 9.4 Z"
        fill="#FFFFFF"
      />
      <circle cx="9.2" cy="22.6" r="0.95" fill="#FFFFFF" />
    </svg>
  );
}

function EthIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-label="ETH"
      role="img"
    >
      <rect width="32" height="32" rx="16" fill="#0B0B0B" />
      <path d="M16 5 L23.5 17 L16 21 L8.5 17 Z" fill="#627EEA" opacity="0.85" />
      <path d="M16 5 L8.5 17 L16 13.6 Z" fill="#8FA0F4" />
      <path d="M16 22.6 L23.5 18.4 L16 28 Z" fill="#627EEA" opacity="0.85" />
      <path d="M8.5 18.4 L16 22.6 L16 28 Z" fill="#8FA0F4" />
    </svg>
  );
}

function UsdcIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-label="USDC"
      role="img"
    >
      <circle cx="16" cy="16" r="15" fill="#2775CA" />
      <path
        d="M11.5 18.8 c0 1.5 1.1 2.4 3.4 2.7 v1.5 h2 v-1.5 c2.4 -.3 3.6 -1.5 3.6 -3.1 c0 -1.7 -1.1 -2.6 -3.5 -3.1 c-1.6 -.3 -2.1 -.7 -2.1 -1.4 c0 -.7 .5 -1.1 1.7 -1.1 c1.3 0 1.9 .4 2.1 1.4 h2 c-.2 -1.6 -1.2 -2.5 -3 -2.8 V9.9 h-2 v1.5 c-2.2 .3 -3.3 1.4 -3.3 3 c0 1.6 1.1 2.4 3.4 2.9 c1.6 .3 2.1 .7 2.1 1.5 c0 .8 -.6 1.2 -1.9 1.2 c-1.5 0 -2.1 -.5 -2.3 -1.5 h-2.2 z"
        fill="#fff"
      />
    </svg>
  );
}

function SolIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-label="SOL"
      role="img"
    >
      <defs>
        <linearGradient id="solGrad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="50%" stopColor="#8752F3" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="16" fill="#0B0B0B" />
      <path
        d="M9.4 22.4 L23.3 22.4 L26 25 L12.1 25 Z"
        fill="url(#solGrad)"
      />
      <path
        d="M9.4 14.7 L23.3 14.7 L26 17.3 L12.1 17.3 Z"
        fill="url(#solGrad)"
      />
      <path d="M9.4 7 L23.3 7 L26 9.6 L12.1 9.6 Z" fill="url(#solGrad)" />
    </svg>
  );
}

function LetterDisc({ token, size }: { token: Token; size: number }) {
  return (
    <span
      className="relative inline-flex items-center justify-center rounded-pill text-[0.6em] font-semibold ring-1 ring-black/30"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(120% 120% at 30% 20%, ${token.iconTint}, ${shade(token.iconTint, -0.35)})`,
        color: contrastInk(token.iconTint),
        fontSize: size * 0.46,
        lineHeight: 1,
      }}
      aria-hidden
    >
      {token.symbol.slice(0, 1)}
    </span>
  );
}

function shade(hex: string, amount: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = clamp(((n >> 16) & 0xff) + Math.round(255 * amount));
  const g = clamp(((n >> 8) & 0xff) + Math.round(255 * amount));
  const b = clamp((n & 0xff) + Math.round(255 * amount));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, n));
}

function contrastInk(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m || !m[1]) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#0A0A0A" : "#FFFFFF";
}
