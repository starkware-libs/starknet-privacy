import { TopBar } from "./components/TopBar";
import { SwapCard } from "./components/SwapCard";
import { SwapTimeline } from "./components/SwapTimeline";
import { WalletProvider } from "./hooks/useWallet";

export default function App() {
  return (
    <WalletProvider>
      <AppShell />
    </WalletProvider>
  );
}

function AppShell() {
  return (
    <div className="relative min-h-screen text-foreground">
      <TopBar />

      <main className="relative z-10 mx-auto flex flex-col items-center gap-6 px-5 pb-24 pt-12 sm:pt-20">
        <Kicker />
        <SwapCard />
        <SwapTimeline />
      </main>

      <Footer />
    </div>
  );
}

function Kicker() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="rounded-pill border border-border bg-surface-elevated/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-foreground-muted">
        Shielded · Ethereum · Solana
      </span>
      <h1 className="max-w-xl text-display font-light text-foreground">
        Move STRK in and out.
        <span className="ml-2 text-accent">Stay private.</span>
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-foreground-muted">
        Bridge between Ethereum, Solana, and the Starknet privacy pool — the
        NEAR Intents leg breaks the link between your shielded balance and
        either side.
      </p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="relative z-10 mx-auto max-w-6xl px-5 pb-10 text-center text-[11px] uppercase tracking-[0.18em] text-foreground-subtle">
      Built on Starknet · Routed by NEAR Intents
    </footer>
  );
}
