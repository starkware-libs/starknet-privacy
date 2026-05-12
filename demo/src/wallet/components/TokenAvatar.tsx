// Token mark used in the home token list and the activity icons. For the
// three first-class assets (STRK, BTC, USD) we draw inline SVG logos that
// match each project's brand mark; for anything else we fall back to a
// deterministic gradient with the first letters as initials.
//
// The v-prefixed Vesu wrappers (vUSD, vBTC) inherit the underlying token's
// logo and overlay a small "v" badge in the corner — so "vBTC" reads as
// "Bitcoin, but wrapped" at a glance.

const PALETTE = [
  ["#7c5cff", "#4d80ff"],
  ["#21d4fd", "#2186f5"],
  ["#f97316", "#fbbf24"],
  ["#34d399", "#06b6d4"],
  ["#f472b6", "#a855f7"],
  ["#ef4444", "#f59e0b"],
  ["#22d3ee", "#34d399"],
  ["#a78bfa", "#ec4899"],
];

function paletteHash(name: string): number {
  let value = 0;
  for (let offset = 0; offset < name.length; offset += 1) {
    value = (value * 31 + name.charCodeAt(offset)) >>> 0;
  }
  return value;
}

// Strip Vesu's "v" prefix to find the underlying asset. We only treat it as
// a wrapper when the rest of the name is one of the known tickers — otherwise
// "vUSDT" would silently match a hypothetical "USDT", and we don't want to
// guess about brands we don't know.
const KNOWN: Record<string, true> = { STRK: true, BTC: true, USD: true };

function unwrapVesu(name: string): { underlying: string; wrapped: boolean } {
  if (name.length > 1 && name.startsWith("v")) {
    const rest = name.slice(1).toUpperCase();
    if (rest in KNOWN) return { underlying: rest, wrapped: true };
  }
  return { underlying: name.toUpperCase(), wrapped: false };
}

export function TokenAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const { underlying, wrapped } = unwrapVesu(name);
  const mark = renderMark(underlying, size);
  return (
    <div
      className="token-icon"
      style={{
        width: size,
        height: size,
        position: "relative",
        background: "transparent",
        boxShadow: "none",
      }}
    >
      {mark}
      {wrapped && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, size * 0.42),
            height: Math.max(14, size * 0.42),
            borderRadius: "50%",
            background: "var(--bg-1)",
            color: "var(--accent-3)",
            display: "grid",
            placeItems: "center",
            fontSize: Math.max(8, size * 0.22),
            fontWeight: 800,
            boxShadow: "inset 0 0 0 1.5px var(--accent-3)",
            lineHeight: 1,
          }}
          title="Vesu wrapped"
        >
          v
        </span>
      )}
    </div>
  );
}

function renderMark(underlying: string, size: number): React.ReactNode {
  switch (underlying) {
    case "STRK":
      return <StrkMark size={size} />;
    case "BTC":
      return <BtcMark size={size} />;
    case "USD":
      return <UsdMark size={size} />;
    default:
      return <Fallback name={underlying} size={size} />;
  }
}

function Fallback({ name, size }: { name: string; size: number }) {
  const pair = PALETTE[paletteHash(name) % PALETTE.length];
  const initials = name.slice(0, 3).toUpperCase();
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: Math.max(10, Math.floor(size / 3)),
        color: "#fff",
        background: `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`,
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
      }}
    >
      {initials}
    </div>
  );
}

// Starknet — official brand mark from starknet.io's logo SVG (navy circle
// with coral ring, twin waves in white & coral, sparkle, accent dot).
// Paths copied verbatim from the public starknet-logo-light.svg so the
// rendering matches what Coinbase / CoinGecko / etc. show.
function StrkMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 41" fill="none" aria-hidden>
      <path
        d="M0.294582 20.813C0.294582 31.719 9.13542 40.5598 20.0414 40.5598C30.9474 40.5598 39.7888 31.719 39.7888 20.813C39.7888 9.90701 30.9474 1.06616 20.0414 1.06616C9.13542 1.06616 0.294582 9.907 0.294582 20.813Z"
        fill="#0C0C4F"
        stroke="#EC796B"
        strokeWidth="0.506336"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.2193 16.1014L11.713 14.5761C11.8133 14.2659 12.0582 14.0245 12.3695 13.9293L13.9023 13.4579C14.1145 13.3931 14.1162 13.0938 13.9057 13.0256L12.3799 12.5319C12.0702 12.4315 11.8288 12.1867 11.7331 11.8753L11.2623 10.3425C11.1975 10.1309 10.8982 10.1286 10.8299 10.3397L10.3362 11.865C10.2359 12.1746 9.991 12.416 9.67963 12.5118L8.14688 12.9826C7.93472 13.0479 7.93243 13.3467 8.14344 13.4149L9.66931 13.9086C9.97896 14.009 10.2204 14.2544 10.3161 14.5658L10.7869 16.0979C10.8517 16.3101 11.151 16.3124 11.2193 16.1014Z"
        fill="#FAFAFA"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M35.4461 15.2138C34.8142 14.5072 33.828 14.1093 32.8693 13.9462C31.9028 13.7895 30.8896 13.804 29.9355 13.9735C28.0051 14.3001 26.2514 15.0994 24.7219 16.0854C23.9276 16.5694 23.2502 17.1293 22.5484 17.6996C22.2103 17.988 21.902 18.2952 21.5809 18.5979L20.7036 19.4708C19.7504 20.4672 18.8108 21.3747 17.9017 22.127C16.989 22.8758 16.1356 23.4444 15.2947 23.8416C14.4542 24.2408 13.5549 24.4755 12.3828 24.5131C11.221 24.5541 9.84635 24.3444 8.376 23.9983C6.89774 23.6537 5.34543 23.1625 3.61075 22.7399C4.21602 24.4191 5.12749 25.903 6.2977 27.2594C7.48164 28.5923 8.96003 29.8072 10.8592 30.6062C12.7309 31.4229 15.0831 31.716 17.2825 31.2737C19.4877 30.8493 21.4229 29.8288 22.9871 28.6487C24.5553 27.4565 25.8241 26.0984 26.8937 24.6866C27.189 24.2965 27.3452 24.0782 27.5589 23.7733L28.1494 22.8985C28.5599 22.3573 28.9335 21.7412 29.3397 21.2051C30.1362 20.0822 30.9214 18.9607 31.8339 17.9274C32.2932 17.4033 32.7773 16.902 33.349 16.4203C33.6342 16.1851 33.9423 15.955 34.2835 15.7477C34.6299 15.5241 34.9957 15.3491 35.4461 15.2138Z"
        fill="#EC796B"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M35.4462 15.2134C34.7673 13.5004 33.5054 12.0585 31.8115 10.9945C30.1279 9.94223 27.7895 9.4052 25.4724 9.86299C24.3277 10.0844 23.2187 10.5106 22.2454 11.0782C21.2766 11.6436 20.4084 12.3241 19.6569 13.0543C19.2817 13.4205 18.9411 13.8026 18.6028 14.1869L17.7258 15.3049L16.3714 17.1046C14.6447 19.4202 12.7853 22.1339 9.73396 22.938C6.73838 23.7274 5.43914 23.0283 3.61086 22.7395C3.94515 23.6026 4.35925 24.4407 4.92063 25.1781C5.47155 25.9304 6.12227 26.637 6.9313 27.2426C7.34015 27.5335 7.7718 27.8206 8.25121 28.0641C8.72843 28.2994 9.24309 28.5064 9.79242 28.6623C10.8851 28.9618 12.1152 29.0667 13.3063 28.9056C14.498 28.7466 15.637 28.369 16.6326 27.8674C17.6355 27.3706 18.5092 26.7656 19.2893 26.127C20.8401 24.8392 22.0464 23.4162 23.0653 21.9778C23.5778 21.2587 24.043 20.5259 24.4733 19.793L24.9797 18.9205C25.1345 18.6654 25.2911 18.4088 25.4502 18.1698C26.0918 17.2095 26.7194 16.4395 27.4817 15.8616C28.2335 15.2687 29.2802 14.8307 30.679 14.7289C32.072 14.626 33.6801 14.8162 35.4462 15.2134Z"
        fill="#FAFAFA"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M27.91 29.4455C27.91 30.7036 28.9304 31.724 30.1885 31.724C31.4466 31.724 32.4658 30.7036 32.4658 29.4455C32.4658 28.1874 31.4466 27.167 30.1885 27.167C28.9304 27.167 27.91 28.1874 27.91 29.4455Z"
        fill="#EC796B"
      />
    </svg>
  );
}

// Bitcoin — orange brand color and the canonical ₿ glyph. The ₿ is rendered
// as text rather than a custom path so it inherits font fallback and reads
// the same on every OS.
function BtcMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <circle cx={20} cy={20} r={20} fill="#f7931a" />
      <text
        x={20}
        y={28}
        textAnchor="middle"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontWeight={800}
        fontSize={26}
        fill="#fff"
      >
        ₿
      </text>
    </svg>
  );
}

// USD test token — green coin with $ glyph. Slightly different palette
// from Bitcoin so the two stand apart at a glance.
function UsdMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="usd-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#16a34a" />
        </linearGradient>
      </defs>
      <circle cx={20} cy={20} r={20} fill="url(#usd-bg)" />
      <text
        x={20}
        y={28}
        textAnchor="middle"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontWeight={800}
        fontSize={24}
        fill="#fff"
      >
        $
      </text>
    </svg>
  );
}
