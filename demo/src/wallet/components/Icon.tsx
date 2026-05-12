// Lightweight inline SVG icon set. Modeled after Lucide's stroke geometry but
// hand-rolled so the wallet has no icon-library dependency. All icons are 24×24,
// stroke 1.75, currentColor.

import type { ReactNode } from "react";

type IconProps = { size?: number; className?: string };

function svg(children: ReactNode, size = 18, className?: string) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Home: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
      </>,
      size,
      className
    ),
  Send: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="m12 19 9-15-18 4 6 3z" />
        <path d="m9 11 12-7" />
      </>,
      size,
      className
    ),
  Receive: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M12 4v12" />
        <path d="m6 14 6 6 6-6" />
      </>,
      size,
      className
    ),
  ArrowUpRight: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M7 17 17 7" />
        <path d="M9 7h8v8" />
      </>,
      size,
      className
    ),
  ArrowDownLeft: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M17 7 7 17" />
        <path d="M15 17H7V9" />
      </>,
      size,
      className
    ),
  Plus: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>,
      size,
      className
    ),
  Minus: ({ size, className }: IconProps) =>
    svg(<path d="M5 12h14" />, size, className),
  Activity: ({ size, className }: IconProps) =>
    svg(<path d="m3 12 4-9 5 18 5-18 4 9" />, size, className),
  Settings: ({ size, className }: IconProps) =>
    svg(
      <>
        <circle cx={12} cy={12} r={3} />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
      </>,
      size,
      className
    ),
  Shuffle: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M16 3h5v5" />
        <path d="M4 20 21 3" />
        <path d="M21 16v5h-5" />
        <path d="m15 15 6 6" />
        <path d="M4 4l5 5" />
      </>,
      size,
      className
    ),
  Eye: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx={12} cy={12} r={3} />
      </>,
      size,
      className
    ),
  EyeOff: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.2 17.2 0 0 1-3.4 4.5" />
        <path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="m2 2 20 20" />
      </>,
      size,
      className
    ),
  Copy: ({ size, className }: IconProps) =>
    svg(
      <>
        <rect x={9} y={9} width={11} height={11} rx={2} />
        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
      </>,
      size,
      className
    ),
  Check: ({ size, className }: IconProps) =>
    svg(<path d="M5 12l5 5L20 7" />, size, className),
  X: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </>,
      size,
      className
    ),
  Refresh: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 4v5h-5" />
      </>,
      size,
      className
    ),
  Shield: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </>,
      size,
      className
    ),
  Lock: ({ size, className }: IconProps) =>
    svg(
      <>
        <rect x={4} y={11} width={16} height={10} rx={2} />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>,
      size,
      className
    ),
  Wallet: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="M20 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z" />
        <path d="M3 9V6a2 2 0 0 1 2-2h12" />
        <path d="M17 14h.01" />
      </>,
      size,
      className
    ),
  Handshake: ({ size, className }: IconProps) =>
    svg(
      <>
        <path d="m11 17 2 2a1 1 0 0 0 3-1l-2-2" />
        <path d="m14 14 2 2a1 1 0 0 0 3-1l-3.5-3.5" />
        <path d="m17 13 2-2a3.3 3.3 0 0 0-4.6-4.6L13 7.8" />
        <path d="M7 14 5.1 16a3 3 0 0 0 4.2 4.2L11 18" />
        <path d="M11 7.8 9 6 7.4 6c-.8 0-1.5.3-2.1.9L3 9" />
      </>,
      size,
      className
    ),
  Sparkle: ({ size, className }: IconProps) =>
    svg(
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />,
      size,
      className
    ),
};
