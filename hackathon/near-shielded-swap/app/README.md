# Shielded Swap — Hackathon UI

Cross-chain swap UI for shielded Starknet privacy-pool funds, routed via NEAR Intents.
Pure frontend; mock data only.

## Run

```bash
npm install
npm run dev
```

Opens on http://localhost:5180.

## Tech

- Vite + React 18 + TypeScript (strict)
- Tailwind CSS with brand tokens
- lucide-react icons
- Mona Sans / JetBrains Mono via Google Fonts

## Structure

```
src/
  components/    SwapCard, TokenSelector, QuoteDetails, SwapTimeline, ...
  mocks/         tokens.ts, quote.ts, pendingSwaps.ts
  lib/           format.ts (number/USD/time helpers)
  types.ts
  App.tsx
```

All state is local. Replace `src/mocks/` with real SDK calls when wiring to the
`near_intents_anonymizer` contract (see `docs/near-intents-integration-plan.md`
in the privacy-pool repo).
