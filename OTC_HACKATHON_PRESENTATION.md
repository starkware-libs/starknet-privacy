# Private OTC on Starknet — Hackathon Presentation

**Format:** Google-Slides-ready outline. One section = one slide. Paste each slide's
title + bullets straight in; speaker notes go in the "speaker notes" panel.

**Target length:** ~5 minutes. ~7 slides total, ~30-45 sec each, with the live
demo eating ~2 minutes. Slide 2 is the demo; everything else is one idea max.

---

## Slide 1 — Title (15 sec)

**Title:** Private OTC on Starknet

**Subtitle (one line):** Atomic, peer-to-peer trades. No escrow. No third party. No funds ever locked.

**Speaker notes:**
- Open with the thesis in one sentence: "OTC trading on a privacy pool — both sides keep their balances private, both legs settle atomically, and neither party ever escrows funds with a third party."
- Don't dwell. The demo does the selling.

---

## Slide 2 — Live Demo (~2 min — the centerpiece)

**Title:** Live Demo

**On-slide bullets (keep minimal — the screen is the demo):**
- Two browsers: Alice and Bob
- Same `trade_id`. Opposite legs. One click each.
- Watch: balances flip atomically. Order doesn't matter. Tampering reverts.

**Speaker notes / script:**
- Alice: "I'll give 100 USD, want 0.005 BTC, trade_id = 0x1234, counterparty = Bob."
- Bob: opposite leg, same trade_id.
- Hit submit on both. Whichever lands second triggers settlement.
- Show balances change on both sides — encrypted on-chain, plaintext in the UI.
- Open the **Audit** tab → received notes appear with the trade_id as the salt, click Verify, point at the confirmed on-chain `join_trade` tx.
- *If time:* show that flipping the ask amount in Bob's leg causes the tx to revert before any tokens move.

---

## Slide 3 — What we changed in the privacy pool (~30 sec)

**Title:** What we changed in the privacy pool

**Bullets:**
- Split `apply_actions` → `store_actions` + `apply_stored_actions`.
- **Proof verification** happens at *store* time. **Execution** happens at *apply* time.
- One transaction can `apply_stored_actions` for **both** legs ⇒ atomic multi-execution.
- Each leg's actions include an **InvokeExternal** that fires during apply → lets us assert a *conditional* check on chain.
- That conditional check is what turns a one-sided transfer into a real trade.

**Speaker notes:**
- The original privacy pool had proof-and-execute fused in one entrypoint. That made multi-leg atomic settlement impossible — you can't bundle two independently-proved actions in one tx because each proof binds to a specific block and execution context.
- Separating them lets the pool hold proven-but-not-yet-applied actions per party and lets a helper contract trigger the apply for both atomically.
- The InvokeExternal hook was already in the privacy pool — we used it for the conditional check that makes the trade meaningful.

---

## Slide 4 — What this gives us (~30 sec)

**Title:** What we achieved

**Bullets:**
- **Private** — amounts and tokens encrypted on chain; only the two parties can decrypt.
- **Atomic** — either both legs settle in the same tx, or neither does.
- **Peer-to-peer** — no third party, no escrow, no temporarily-locked funds.
- **Symmetric** — both sides submit the exact same shape of call. No initiator / responder roles.
- **Order-independent** — second-to-join automatically settles both.

**Speaker notes:**
- Contrast with traditional OTC: trusted desk, escrow, KYC choke-points, settlement risk during the lock window. None of that here.
- Contrast with on-chain DEX: orderbook leaks intent, AMM leaks price impact, both leak balance trails. Here the on-chain footprint is encrypted notes.

---

## Slide 5 — How: one proof, one trick (~60 sec — the technical punch)

**Title:** How: one proof carries both halves of the trade

**Bullets:**
- Each party's proof commits to: **(a)** transferring to the counterparty, **(b)** checking the counterparty also transferred them, scoped to the same `trade_id`.
- Naive impl ⇒ chicken-and-egg deadlock: each leg's apply needs the other side's notes to already exist on chain.
- **Helper contract breaks the deadlock.** The conditional check becomes: *"counterparty transferred me directly **OR** committed to transfer me in the OTC helper."*
- Salt = `trade_id` ⇒ each party can predict the encrypted note the counterparty will produce — **without** the counterparty sharing any secret.
- Net result: a check that's **on-chain, private, and token+amount-bound**.

**Speaker notes:**
- Walk through the deadlock briefly: "If Alice's apply requires Bob's note to exist, and Bob's apply requires Alice's note to exist, neither can go first."
- The OR-clause fix: when Alice's apply runs (second-to-go), Bob's notes already exist on chain → Alice's check looks up the actual note. When Bob's apply runs (first-to-go), Alice's actions are still committed (not yet applied) → Bob's check reads Alice's commitment from helper storage. Same condition, two branches.
- The deterministic-salt insight is the privacy magic: normally a transfer's encrypted note depends on a random salt only the sender knows. By fixing the salt to `trade_id`, both parties — and only the two of them — can compute the exact `(note_id, packed_value)` the counterparty must emit. The on-chain check just does an equality.
- This is the part the privacy pool's verbosity makes possible. One proof, two intertwined assertions, no extra round-trips.

---

## Slide 6 — Proof points (videos) (~45 sec — TBD content)

**Title:** It works (and it can't be cheated)

**Bullets / video captions:**
- **Order-agnostic settlement:** Alice-first, Bob-first, and *simultaneous* submits — all settle.
- **Tamper-evident:** if either party changes any trade detail (token, amount, counterparty, trade_id) the second-to-join's `join_trade` reverts before any funds move.
- *(Captions point at terminal/explorer output.)*

**Videos to record (TODO):**
1. **Order doesn't matter** — 3 short clips:
   - Alice clicks first, Bob clicks ~5s later → settles on Bob's tx.
   - Bob clicks first, Alice clicks ~5s later → settles on Alice's tx.
   - Both click within ~1s → still settles, on whichever lands second.
2. **Can't cheat** — for each of these, show the revert + the failing assertion in the explorer:
   - Bob sends a different token than agreed → `EXPECTED_NOTE_NOT_FOUND` (packed_value mismatch).
   - Bob sends a smaller amount than agreed → same, different packed_value.
   - Bob targets a different `trade_id` than Alice → hashes never pair up.
   - Bob's recipient is someone else → Alice's incoming channel never sees the note → check fails.

**Speaker notes:**
- Don't narrate every video — just queue them and let the failure modes speak. "Try to cheat by changing X → revert."

---

## Slide 7 — Future work + Close (~30 sec)

**Title:** What's next

**Bullets:**
- **Selective-disclosure compliance proofs** — prove "my OTC volume this quarter was under $X" without revealing any individual trade.
- **Multi-leg trades** — same primitive extended to 3+ parties (ring swaps, circular settlement).
- **Conditional trades with oracles** — limit orders that only settle when an oracle price is in range. Same `InvokeExternal` hook.
- **Cross-asset classes** — ERC20 ↔ ERC721 OTC (private NFT settlement).

**Closing line:**
- "The privacy pool's expressiveness — one proof binding multiple commitments — is the unlock. OTC is just the first thing we built on top."

**Speaker notes:**
- If Q&A is included, leave 30 sec for it. Stop here.

---

## Appendix — Things to have on standby (not slides)

- The **OtcSettlement contract on Voyager** — open in a tab, ready to show the `join_trade` calldata for a real settlement.
- A **terminal** with the deploy script handy, in case someone asks "how do I run this".
- The **Audit tab** loaded in the demo browser — it's the strongest answer to any compliance question.
- Two **import-account JSONs** pre-staged for Alice and Bob.

## Appendix — Likely questions

- *"What's the trust assumption?"* — Cryptographic proofs + the helper contract's on-chain logic. The helper is a 100-line contract; readable in one sitting.
- *"What about MEV?"* — The two `join_trade` txs each commit to a specific trade_id; the helper only settles when both are present. There's no price slippage to extract.
- *"What if one party never shows up?"* — The first party's actions sit `stored` but never `applied`. They're free to cancel by re-using the trade_id with a counter-action, or just walk away (their funds were never moved — `store_actions` doesn't transfer anything).
- *"How private is it really?"* — Counterparty addresses are visible (channels are public). Amounts and tokens are encrypted; only sender and recipient can decrypt. Same privacy guarantees as a regular privacy-pool transfer.
