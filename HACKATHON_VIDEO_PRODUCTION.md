# Hackathon Video — Production Notes

Two parts:
- **Part A — AI narration script.** Per slide, rewritten for AI TTS (HeyGen / ElevenLabs). Word counts target ~150 wpm. Total ~5:00.
- **Part B — OBS shot list.** What to capture for each segment, scene setup, and how to slice it in the editor.

Pipeline assumed: HeyGen renders avatar + slide for slides 1, 3-7. You record the demo (slide 2) in OBS. Stitch in Kdenlive.

---

## Part A — Narration script

> **Voice direction (global):** confident, technical, conversational but rehearsed. No filler words. Slight pause after period; longer pause between slide segments. Pronounce hex/code phrases naturally — "apply stored actions" not "apply underscore stored underscore actions". Numbers: read "0.005 BTC" as "zero point zero zero five B-T-C".

### Slide 1 — Title  *(15s · ~40 words)*

> **Direction:** confident, slight pause for emphasis after each sentence.

"Private OTC on Starknet. Atomic peer-to-peer trades. No escrow. No third party. No funds ever locked. Both sides keep their balances private. Both legs settle in a single transaction."

---

### Slide 2 — Live demo  *(~110s · ~245 words)* — voiceover over recorded screen

> **Direction:** energetic, narrating action. Slight emphasis on "order doesn't matter" and "no funds move".

"Here's the protocol in action. Two browsers — Alice on the left, Bob on the right. Each has a balance in the privacy pool. Amounts encrypted on chain, visible to them in the UI.

Alice wants to give one hundred USD for zero point zero zero five B-T-C. She picks a trade ID, fills in her offer and her ask, selects Bob as the counterparty. Bob fills in the opposite leg — same trade ID.

They've agreed on terms off chain. Each clicks submit. The order doesn't matter — whoever lands second triggers settlement. Both legs apply in a single transaction. Watch the balances flip. Alice has the B-T-C. Bob has the USD.

Now the audit tab. Reconstructed live from on-chain data — nothing read from local storage. The salt column holds the trade ID. Click verify, the app fetches the originating transaction, confirms it routed through the OTC contract, and recovers the trade ID from the calldata. Exportable as J-SON for an accountant.

And finally — tampering. Bob changes his amount mid-trade. The transaction reverts at fee estimation, before any funds move. The conditional check catches the mismatch."

---

### Slide 3 — What we changed  *(30s · ~75 words)*

> **Direction:** explanatory, slow on the technical phrase. Brief pause before "everything else".

"What did we change in the privacy pool? One thing. We split the apply actions entrypoint into two — store actions, and apply stored actions. Proof verification happens at store time. Execution happens later, at apply time. That's the change. Everything else our app does is built on top — applying both legs atomically in one transaction, and using the existing invoke external hook for a conditional check."

---

### Slide 4 — What you get  *(35s · ~75 words)*

> **Direction:** emphatic, list-like delivery. Slight pause between properties. Land "permissionless" hard.

"What this gives you. Private — amounts and tokens encrypted on chain. Only the two parties decrypt them. Atomic — both legs settle in a single transaction, or neither does. Peer to peer — no third party, no escrow, no lock window. Permissionless — no identity checks. Anyone can submit the transactions. Only valid proofs settle. Symmetric — both sides submit the same call, no initiator role. And order independent — whoever lands second automatically settles both."

---

### Slide 5 — How  *(55s · ~135 words)*

> **Direction:** the most important slide. Slow, deliberate, build-up. Pause noticeably before "OR". Land the closing sentence emphatically.

"How does this work? Each proof commits to two things at once — transferring tokens to the counterparty, and checking the counterparty also transferred you, scoped to the same trade ID.

A naive implementation creates a chicken-and-egg deadlock. If Alice's transaction needs Bob's note on chain, and Bob's needs Alice's, neither can go first.

The OTC helper contract breaks it. The check becomes — counterparty transferred me directly… *or* … counterparty committed to transfer me in the helper. Two branches, same condition.

When the first leg runs, the other's commitment is in the helper. When the second runs, the first's notes are already on chain.

The result — a check that's on chain, private, and bound to the exact agreed token and amount."

---

### Slide 6 — Proof points  *(40s · ~100 words)*

> **Direction:** brisk, confident, almost dismissive. The "reverts" should sound mechanical, inevitable.

"It works. And it can't be cheated. Order agnostic settlement — Alice first, Bob first, or both at the same time. The trade settles in every case. Tamper evident — try to send a different token than agreed, the transaction reverts. Try to send a smaller amount, reverts. Try to send to a different recipient, reverts. Try to use a different trade ID, the two legs never pair up. In each failure case, no funds ever move. The condition catches the mismatch at fee estimation, before any state changes."

---

### Slide 7 — Future work  *(35s · ~85 words)*

> **Direction:** aspirational, slight lift on the closing four-word punch line ("Atomic. No lock. Zero trust. Executed on the fly.") — each word a beat.

"What's next. Match maker integration. Today Alice and Bob have to know each other. With a match maker in front, they don't. Each posts a conditional offer. The match maker finds the counterparty, adds the only missing piece — a proof of transfer to Alice and transfer to Bob — and settles. Neither party sees who they traded with. Put the match maker inside an enclave, and even it doesn't see the details.

Atomic. No lock. Zero trust. Executed on the fly."

---

**Total: ~765 words / ~5:05 at 150 wpm.** Trim if HeyGen's render comes in over 5:00 — slide 2 narration is the easiest to compress (cut the audit-tab segment if needed).

---

## Part B — OBS shot list

### Pre-recording setup (do once)

- Display: 1920×1080 native. Hide notifications (Do Not Disturb), close Slack/email/Signal.
- Browsers: two Firefox or Chrome windows, sized to exactly half-screen each. No extensions visible in toolbar. No bookmarks bar.
- Demo state: pool/indexer/prover all healthy (`http://localhost:5173` showing green status). Alice and Bob both pre-imported with funded balances. STRK fee covered. Ekubo/Vesu balances zero (less distraction).
- OBS Studio settings:
  - Output → Recording → Format: `mkv` (remux to `mp4` after; `mkv` is crash-safe).
  - Output → Recording → Encoder: hardware encoder (NVENC / VAAPI) if available; else x264 quality preset "fast".
  - Video → Base + output resolution: 1920×1080. FPS: 30.
  - Audio → Mic/Aux Audio: muted (you're narrating later, not now).
  - Audio → Desktop Audio: enabled (captures pool's sound notifications if any — usually nothing).

### OBS scenes to prepare

| Scene | Sources | Use for |
|-------|---------|---------|
| **Split** | Window Capture: Alice browser (left half) + Window Capture: Bob browser (right half) + Text overlays "Alice" / "Bob" top-left of each | Trade setup + submit |
| **Single — Audit** | Window Capture: Alice browser, fullscreen | Audit tab segment |
| **Single — Revert** | Window Capture: any browser, fullscreen | Tampering segment |
| **Single — Explorer** | Window Capture: Sepolia Voyager tab, fullscreen | Showing reverted tx on chain |

### Shots to capture (target: 4 takes, ~2:00 total raw)

**Take 1 — Trade setup**  *(~20s, scene: Split)*
- Both Alice and Bob have OTC tab open.
- Alice fills first: trade_id `0x1234`, offer 100 USD, counterparty = Bob (pick from datalist by name), ask 0.005 BTC.
- Bob fills second: same trade_id, offer 0.005 BTC, counterparty = Alice, ask 100 USD.
- End frame: both forms filled, neither submitted yet.

**Take 2 — Submit**  *(~40s, scene: Split)*
- Alice clicks Submit leg. Bob clicks Submit leg ~3 seconds later (so the audience sees the order-doesn't-matter point — Bob's tx is what triggers settlement).
- Wait for both txs to settle. Balances update.
- End frame: both balances reflect the swap (Alice ↓USD ↑BTC, Bob ↑USD ↓BTC).
- *If you can:* simulate "simultaneous" by submitting within ~1 second of each other. Same outcome — visually proves the point.

**Take 3 — Audit tab**  *(~30s, scene: Single — Audit)*
- Switch to Alice's browser, fullscreen. Click Audit tab.
- Auto-loaded ledger shows the received note from Bob with the trade_id in the Salt column.
- Click **Verify** on that row. Wait ~2s. Row updates with "✓ OTC", tx link, and trade_id recovered from calldata.
- Click **Export JSON**. Show the download appearing in the browser's download bar.
- End frame: download visible.

**Take 4 — Tampering reverts**  *(~30s, scene: Single — Revert + Explorer)*
- Start a fresh trade_id (e.g. `0x5678`). Alice submits her leg first (capture briefly).
- Switch to Bob's browser. Bob types the offer/ask but **changes the ask amount** to a different number than what Alice agreed to.
- Bob clicks Submit. The UI shows the fee-estimation revert error. Hover/highlight the `EXPECTED_NOTE_NOT_FOUND` text or whichever error surfaces in the UI.
- *Optional bonus:* switch to a Voyager explorer tab showing the revert receipt with the failing assertion.
- End frame: clear error message visible.

### How to slice in Kdenlive

1. Drop all four `.mkv` takes onto track V1, in order: setup → submit → audit → revert.
2. Trim leading/trailing dead time on each take (typically 1-2s each side).
3. Drop the AI narration audio (slide 2 segment, exported as `.mp3` from HeyGen or ElevenLabs) onto track A1. Align start to Take 1 start.
4. If the narration runs longer than the visuals, *speed up* the takes uniformly (Right click → Speed) to fit. If shorter, add a 1-2s freeze frame on the most visually informative moments.
5. Add a 0.5s fade-in at the start of the demo segment, 0.5s fade-out at the end.
6. Render: H.264, 1080p30, target bitrate ~5 Mbps (good enough for any hackathon submission portal).

### Assembling the full video

Final timeline (top-down, V1 = main video, V2 = picture-in-picture if any, A1 = narration):

| Time | V1 content | Source |
|------|-----------|--------|
| 0:00 — 0:15 | Slide 1 (avatar + title slide) | HeyGen render of slide 1 |
| 0:15 — 2:05 | Demo footage (Takes 1-4 trimmed/stitched) | OBS recordings |
| 2:05 — 2:35 | Slide 3 (avatar + slide) | HeyGen render of slide 3 |
| 2:35 — 3:10 | Slide 4 | HeyGen |
| 3:10 — 4:05 | Slide 5 | HeyGen |
| 4:05 — 4:45 | Slide 6 | HeyGen |
| 4:45 — 5:20 | Slide 7 | HeyGen |

Output: `OTC_hackathon_submission.mp4`.

### Gotchas

- **HeyGen pronunciation.** Test slide 5 first — "trade ID", "invoke external", "apply stored actions" sometimes come out clipped. If so, add hyphenation in the script ("trade I-D") or commas to slow the avatar down.
- **OBS audio drift on long takes.** If your final video has audio that drifts out of sync over 5 min, re-encode in Kdenlive with "use audio from clip" set on each segment, not the project.
- **Voyager screenshots in Take 4.** The explorer can be slow to load. Pre-warm the tab by hitting refresh on a known reverted tx before you start recording.
- **Mic noise.** You're not recording your own voice — the AI narrates. Mute desktop audio in OBS if your environment has any background noise picked up.

---

## Part C — Day-of checklist

### T-60 min (before you start recording)

- [ ] Pull latest: `git status` clean, branch matches what you want to demo.
- [ ] SDK built: `cd sdk && npm run build` succeeds (silent).
- [ ] Demo built: `cd demo && npm install && npm run dev` shows `Local: http://localhost:5173/`.
- [ ] All three services healthy (the bar at the top of the demo is green): RPC, indexer, prover.
- [ ] **STRK balance** on Alice's address ≥ 50 STRK (for fees). Same for Bob.
- [ ] **Token balances** for Alice: ≥ 200 USD, 0 BTC. For Bob: ≥ 0.01 BTC, 0 USD. (Mint via the Actions tab if short.)
- [ ] Audit tab loads — pick any prior received note and click Verify; confirm "✓ OTC" appears.
- [ ] OTC contract verified on Voyager (open `0x056ac8a6faa4166a8e66d66032a2abf4f1567667d3ab4c1e5f0c498a3e7dde60` in a tab).

### T-15 min (right before)

- [ ] Notifications off (DND on, Slack quit, email closed).
- [ ] Two browser windows positioned exactly half-screen each. Hide bookmark bar.
- [ ] OBS scenes pre-tested: switch between Split / Single-Audit / Single-Revert / Single-Explorer with hotkeys, no glitches.
- [ ] Pick fresh trade_ids — never reuse one already settled (would conflict-free, but `trade_hashes` cleared after settle, so a fresh one keeps the demo clean): `0x1234`, `0x5678`, `0x9ABC` are your three slots.
- [ ] Voyager tab pre-warmed on the OTC contract's recent txs.

### Recording order

1. Take 1 — Trade setup (Split scene).
2. Take 2 — Submit & settle (Split scene). **Don't cut between Take 1 and 2** if you can avoid it — single take is cleaner.
3. Take 3 — Audit tab (Single-Audit scene).
4. Take 4 — Tampering reverts (Single-Revert scene, then Single-Explorer scene). **Use a different trade_id** here so the prior trade's settled state doesn't confuse you mid-shot.

### After recording, before assembling

- [ ] Watch each `.mkv` end-to-end at 2x — check for: visible notifications, accidental mouse drift, browser-error popups, lag stutters.
- [ ] If any retake needed: do it now while everything's still set up.
- [ ] Remux `.mkv` → `.mp4` (Kdenlive handles this on import, but `ffmpeg -i in.mkv -c copy out.mp4` is faster if you want a separate pass).

### Files produced

| File | What it is |
|------|------------|
| `OTC_HACKATHON_DECK.md` | Marp source. Edit + re-render any time. |
| `OTC_HACKATHON_DECK.pdf` | Slides as PDF, for presenting from. |
| `OTC_HACKATHON_DECK.pptx` | Slides as PPTX, for Google Slides / PowerPoint / HeyGen import. |
| `OTC_HACKATHON_PRESENTATION.md` | Long-form outline + speaker notes (for live talk). |
| `HACKATHON_VIDEO_PRODUCTION.md` | This file — narration script + OBS shot list + day-of checklist. |

### Submission package

If the hackathon wants a single tarball/zip:

```
OTC_hackathon_submission/
├── video.mp4                              # final assembled video
├── slides.pdf                             # OTC_HACKATHON_DECK.pdf
├── README.md                              # short project description
└── repo/                                  # link to GitHub or a clean snapshot
```
