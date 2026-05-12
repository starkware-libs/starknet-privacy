import { WalletButton } from "./WalletButton";

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <ShieldMark />
          <div className="leading-none">
            <div className="text-[15px] font-semibold tracking-tight text-foreground">
              Shielded Swap
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
              Starknet · NEAR Intents
            </div>
          </div>
        </div>

        <nav className="hidden items-center gap-1 sm:flex">
          <NavLink active>Swap</NavLink>
          <NavLink>Pool</NavLink>
          <NavLink>Docs</NavLink>
        </nav>

        <WalletButton />
      </div>
    </header>
  );
}

function NavLink({
  children,
  active,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <a
      href="#"
      className={`rounded-pill px-3 py-1.5 text-sm transition ${
        active
          ? "text-foreground"
          : "text-foreground-muted hover:text-foreground"
      }`}
    >
      {children}
    </a>
  );
}

function ShieldMark() {
  return (
    <span className="relative flex size-8 items-center justify-center">
      <span className="absolute inset-0 rounded-lg bg-accent/15" />
      <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
        <path
          d="M12 3 L20 6.5 V13 C20 17 16.5 19.6 12 21 C7.5 19.6 4 17 4 13 V6.5 Z"
          fill="#B6F35F"
        />
        <path
          d="M8.5 12.2 L10.9 14.6 L15.5 9.6"
          stroke="#070707"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
  );
}
