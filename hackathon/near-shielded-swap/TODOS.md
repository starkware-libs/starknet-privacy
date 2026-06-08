# TODOs — NEAR Shielded Swap

Prioritized punch list. Read the [README](./README.md) first; this is the
"what to pick up next" cheatsheet for a teammate.

**Branch**: `avi/hackathon/near-anonymizer_part-5-plus-inbound`
**Fork**: `git@github.com:avi-starkware/starknet-privacy.git`

---

## Critical path to a working demo

These block end-to-end on-chain settlement. Do them in order; each unblocks
the next.

### 1. Add TS SDK helpers for `register_inbound`

**Why**: Deposit's Tx 1 has no way to encode the on-chain register call
without these. The Cairo side is ready; the TS side is the missing half.

**Where**: `app/src/lib/anonymizer.ts`

**What**:
- `registerInboundCalldata({ swap_id, asset_out, note_id_out, deposit_address_hint }): string[]`
  — 4 felts in this exact order per
  `packages/near_intents_anonymizer/src/tests/test_sdk_parity.cairo`
  Fixture 6.
- `effectiveSwapId(user: string, rawSwapId: string): string` — mirrors
  Cairo `compute_effective_swap_id`. Pedersen-hash of the two felts.
- Parity vitest cases that pin against the Cairo fixture values for
  Fixture 6 (calldata layout) and Fixture 7 (effective_swap_id
  derivation). Run snforge once to print the expected values; copy them
  in as test constants.

**Estimate**: ~60 LOC + parity tests. Half a day.

### 2. Wire Deposit Tx 1 setup

**Why**: Without it, Deposit lights up Metamask / Phantom but never tells
the anonymizer about the swap, so `finalize` has no `pending_swaps` entry
to read.

**Where**: `app/src/components/DepositForm.tsx` (TODO marker is in the
file; the `useWithdrawSubmit` hook is the closest reference shape).

**What**:
- New hook `useDepositSetup` or extend the Starknet wallet path: compose
  Tx 1 with `SetViewingKey* / OpenChannel* / OpenSubchannel* /
  CreateOpenNote(STRK, depositor=anonymizer) / InvokeExternal(register_inbound)`.
- Reuse `app/src/lib/pool-builder.ts`'s SDK build pattern.
- Gate the Metamask / Phantom send on Tx 1 success — show "Step 1 of 2"
  while Starknet is signing, "Step 2 of 2" once the source-chain wallet
  pops.

**Estimate**: ~80 LOC. Depends on #1.

### 3. Deploy `NearIntentsAnonymizer` + `MailboxReceiver`

**Why**: Until deployed, every mailbox-keyed 1Click recipient is a real
address with no sweep capability. STRK that lands there is unrecoverable.

**Where**:
- Runbook: `docs/near-intents-integration-plan.md`
- Deploy script: `e2e/scripts/deploy-near-intents-anonymizer.ts`
- Post-deploy: update `app/src/lib/chain.ts` with the real
  `ANONYMIZER_ADDRESS` and `RECEIVER_CLASS_HASH`.

**What**:
1. **Smoke on Sepolia first.** The Sepolia pool at `0x00c3b88…ef5574`
   shares the mainnet class hash; deploy the anonymizer against it,
   register a fake inbound, mint STRK to the mailbox by hand, run
   `finalize`, verify the open note credits. Catches any
   SDK-side derivation drift before real funds are at risk.
2. **Build artifacts**:
   `SCARB_IGNORE_CAIRO_VERSION=true scarb build --release -p near_intents_anonymizer`
3. **Verify class hashes** against `e2e/scripts/precompute-near-intents-anonymizer-hashes.ts`
   output.
4. **Mainnet deploy** with the team-funded deployer + the pool address
   `0x030a18…77db` as constructor arg.
5. **Update `chain.ts`.**

**Estimate**: ~half day if everything works first try. Half a day extra
budget for Sepolia debugging if mailbox derivation disagrees.

### 4. Replace input-note stub in Withdraw

**Why**: The prover currently rejects every Withdraw because the input
`Note` is all-zero (`synthesizeInputNoteStub` in `useWithdrawSubmit`).
Replace with real notes from the discovery service.

**Where**: `app/src/hooks/useWithdrawSubmit.ts` + new `useShieldedNotes`
hook driven by `transfers.discoverNotes()` from the privacy SDK.

**What**:
- Initialize a `PrivateTransfersInterface` keyed to the connected
  wallet + derived viewing key (matches `demo/src/starknet.ts`).
- `discoverNotes()` returns the user's spendable notes. Pick the one
  matching `fromToken.symbol === "STRK"` and `note.amount >= fromAmount`.
- Render available shielded balance in the "From" panel header
  (currently `1240.55` is a mock).
- Update `useWithdrawSubmit` to consume the selected note.

**Estimate**: ~50 LOC + UI changes for balance display. Half a day.

---

## High priority — polish for a clean demo

### 5. Pending swaps persistence

**Why**: Today the `SwapTimeline` shows a single mocked row. After a real
Deposit kicks off, it should appear there; survive reload; auto-update as
1Click settles.

**Where**: New `app/src/lib/pending-swaps-store.ts` + update
`app/src/components/SwapTimeline.tsx`.

**What**: localStorage-backed list of `{ id, kind: "withdraw" | "deposit",
fromToken, toToken, amounts, depositAddress, sourceTxHash, status,
startedAt }`. `DepositForm` writes on send; `SwapTimeline` reads + polls
1Click for status updates.

**Estimate**: ~100 LOC.

### 6. Confirmation modal before signing

**Why**: For mainnet swaps with real money, the user should see the
destination address, amounts, fees, and mailbox addresses *before* the
wallet popup. Strong demo signal.

**Where**: New `app/src/components/ReviewSwapModal.tsx`.

**What**: Triggered by the "Review withdraw" / "Prepare ETH deposit" CTA;
shows full quote breakdown + the two mailbox addresses + an explicit
"Sign" button. Sign opens the wallet.

**Estimate**: ~60 LOC.

### 7. Code review the new Cairo

**Why**: `register_inbound` is permissionless. Worth a careful human pass
on the access-control and the depositor-check guards before mainnet.

**Where**: `packages/near_intents_anonymizer/src/near_intents_anonymizer.cairo`
on this branch.

**Specific things to check**:
- Can a stranger calling `register_inbound` on someone else's
  `note_id_out` cause grief? (Open notes have `depositor=anonymizer`;
  the anonymizer reads the open note's depositor; `effective_swap_id =
  pedersen(caller, swap_id)` should isolate.)
- `recover` correctly rejects inbound entries (`NO_INBOUND_RECOVERY`).
- The new `InboundRegistered` event leaks `swap_id` and `user` —
  intended (off-chain indexers need it), but worth confirming the
  privacy implications are acceptable.

---

## Medium priority — production-grade

### 8. Resolve `starknet.js` v8 ↔ v10 mismatch

**Why**: Two `as unknown as Account` casts in `pool-builder.ts` are
runtime-safe but typecheck-blind. Consolidate on one major version.

**Options**:
1. Wait for `starknetkit` to publish a v10-compatible release.
2. Backport the SDK to starknet@8 (significant SDK changes; unlikely
   worth it).
3. Stay on the cast bridge (current).

### 9. Keeper bot for `finalize` / `recover`

**Why**: Today the user is asked to click "Claim shielded note" after
1Click settles. A keeper bot would close the loop without user action.

**Where**: New `e2e/scripts/near-intents-keeper.ts` (or a separate
service). Polls `pending_swaps` for `status=Pending` entries past
threshold, checks mailbox balances, fires `finalize` or `recover` as
appropriate. Doesn't need any contract changes — `finalize` is already
permissionless.

### 10. Hashed-only events

**Why**: Today `SwapStarted` / `SwapFinalized` / `InboundRegistered` leak
plaintext amounts. Identity-privacy is preserved; aggregate-volume
privacy isn't.

**Where**: `packages/near_intents_anonymizer/src/near_intents_anonymizer.cairo`
event definitions + off-chain indexer logic.

### 11. Real USDC-on-Solana support

**Why**: Currently scoped to ETH-on-Eth, USDC-on-Eth, SOL-on-Sol. Adding
USDC-on-Sol is one more `Token` entry + an SPL-token transfer path in
`useSolanaSend` (TODO comment already exists in `sol-send.ts`).

**Estimate**: ~80 LOC for SPL token transfer (needs
`@solana/spl-token` for the associated-token-account derivation).

---

## Bookmark — out of scope for this hackathon

### 12. Add ETH-on-Starknet to NEAR Intents

Full report at `docs/adding-starknet-tokens-to-near-intents.md`. Today
NEAR Intents only lists STRK on Starknet — so the off-ramp is "STRK → any
chain" and the on-ramp is "any chain → STRK", with no shielded-Starknet
round-trip via 1Click. Listing ETH-on-Starknet requires the Defuse team
to add the asset entry (the PoA bridge code is ready). Estimated 2–4
weeks best case via Defuse Telegram. **No engineering on our side until
they list.**

### 13. NEAR Chain Signatures integration

The aspirational "one wallet for all chains" path. Discussed at length in
session notes. Out of hackathon scope (months of work, MPC dependency,
ed25519 limitations). Bookmark for V2.

### 14. AA session keys for one-signature Withdraw + Claim

Currently Withdraw is one tx; Claim is a second tx. With Argent X session
keys, both could be signed at once. Nice UX, future work.

---

## "What we should do" — recommended order

If you're picking up the work fresh, here's a sensible path:

1. **Read this README + the contract package's README** (in
   `packages/near_intents_anonymizer/`). 20 min.
2. **Run the app locally** + click around in Withdraw and Deposit modes.
   Get the visual shape. 20 min.
3. **Read the failing path**: try entering an amount in Withdraw with a
   wallet connected — observe the prover reject (item #4 above is the
   fix).
4. **Tier 1 work**: items #1 → #2 → #3 → #4 in this file, in that order.
   Roughly 2 days of focused work.
5. **Then demo polish**: items #5 + #6.

If a teammate is splitting work: items #1 and #4 are independent (one is
SDK helpers, the other is wiring `discoverNotes`); items #2 and #5 are
independent (one is Tx 1 composition, the other is persistence). #3
(deploy) is a single-person job because it's a serial dependency on a
shared chain.
