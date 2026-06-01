# ForgeYields private redemption — design notes (v2)

Status: **Phases 2a and 2b complete** with a query-based claim architecture that uses the gateway as the authoritative oracle for redemption attribution. The mock gateway implements the epoch-gated lifecycle (Phase 2a). The anonymizer exposes `Deposit + RequestRedeem + ClaimRedeem` with a commitment/secret bearer-protection layer (Phase 2b). A full **private** redemption flow has been validated end-to-end on devnet (see [`e2e/tests/devnet/forge-private-redemption.test.ts`](../../../e2e/tests/devnet/forge-private-redemption.test.ts)).

## Final architecture: query-based, no DoS, no bookkeeping drift

The anonymizer's `_claim_redeem` works like this at claim time:

1. **Verify** the wallet's `secret` matches the stored commitment.
2. **Check NFT existence** at the gateway's `redeem_request` ERC-721 contract via a `SafeDispatcher.owner_of(id)` — `Result::Ok` = alive, `Result::Err` = burned.
3. **Opportunistic claim**: if the NFT is still alive, call `gateway.claim_redeem(id)` atomically in the same tx. If it's already burned (auto-service, bot, etc. fired the claim earlier), skip — funds are already on the anonymizer.
4. **Read the authoritative amount** via `gateway.due_assets_from_id(id)`. This view works **before AND after** the NFT is burned because (a) `id_to_info(id)` persists post-burn at the redeem_request contract and (b) the gateway preserves the per-epoch `redeem_assets / redeem_shares` ratio across individual claims.
5. **Route** that exact amount from the anonymizer's balance into the open note specified by Alice's tx.

Why this matters:

- **No DoS via front-run.** If Bob calls `gateway.claim_redeem(42)` directly, the funds still go to `owner_of(42) = anonymizer`. Bob gains nothing, and Alice's subsequent claim works the same — the anonymizer just detects the burn and skips its own call.
- **No anonymizer-side bookkeeping for amounts.** The gateway is the oracle. Per-redemption attribution lives in the gateway's storage (via the persisted `id_to_info`). The anonymizer only stores the commitment hash.
- **Gain/loss handling is automatic.** If the strategy loses money between request and settle, `redeem_assets[epoch] < redeem_nominal[epoch]` and `due_assets_from_id` returns the pro-rata loss. We just transfer what the gateway says we owe.

## The shape of the problem

ForgeYields' `TokenGateway` redemption is **asynchronous and NFT-based** (see [`packages/token_gateway/src/token_gateway/interface.cairo`](../../forge-contracts-cvm/packages/token_gateway/src/token_gateway/interface.cairo) in `forge-contracts-cvm`):

```
request_redeem(shares, receiver, owner) -> id     // mints redemption NFT, queues for next epoch
[ … controller reports back, gateway settles the epoch … ]
claim_redeem(id) -> assets                        // burns NFT, releases underlying
```

Between the two calls, the redemption epoch is observable on-chain via the NFT id. Two private transactions are required, separated by an arbitrary number of blocks.

Compare to Vesu (synchronous): a private withdraw is one tx — anonymizer burns shares, receives underlying, fills an open note. Done.

## What needs to change

Three things, ranked by load-bearing weight:

### 1. Privacy pool needs to hold an opaque NFT-shaped note

Today, notes carry `(token, amount: u128)` — fungible only. A redemption NFT is `(token, id: u256)` — non-fungible, no amount. The pool's note model must either:

| Option | What changes | Cost |
|---|---|---|
| **A. New `NftNote` variant alongside `Note`** | Adds a parallel storage layout, a `CreateEncNftNote` action, a `UseNftNote` action, etc. Notes diverge into two type families. | High — touches every layer (storage, actions, serialization, indexer, discovery, SDK) |
| **B. Encode NFT id in the `amount` field of a regular note** | Reuse `amount: u128` as an opaque id when `token` is a known NFT contract. Requires SDK + discovery to know which token addresses are NFT-typed. | Medium — leaky abstraction, can't carry both id and amount simultaneously, can't represent collections with > 2¹²⁸ ids |
| **C. Treat the redemption id as a shared secret outside the pool** | The redemption id leaves the private tx (carried by the wallet as an off-chain bookmark) and is privately re-injected into the pool at claim time via a separate ZK proof of knowledge. | Lowest pool change, **highest UX/wallet complexity** |

**Recommendation:** Option A is the right shape, but a large body of work. Option C is the right *first move* to learn what the pool actually needs.

### 2. ~~Anonymizer needs three operations~~ ✅ done (Phase 2b)

`ForgeOperation` is an enum-with-payload:

```cairo
pub enum ForgeOperation {
    Deposit: DepositParams,             // underlying -> share note (1 tx)
    RequestRedeem: RequestRedeemParams, // share note -> burn shares + record commitment
    ClaimRedeem: ClaimRedeemParams,     // settled redemption -> underlying note
}
```

- `RequestRedeem` returns an empty `Span<OpenNoteDeposit>` — the shares are burned at the gateway, the redemption id lives off-chain in the wallet, nothing flows back into the pool.
- `ClaimRedeem` returns the underlying as a single `OpenNoteDeposit` filling the user-supplied open note.

The anonymizer never holds tokens between transactions; it does store one persistent piece of state — the per-redemption commitment map (cleared on successful claim). See "Anonymizer storage model" below.

### 3. ~~Gateway mock needs a fake epoch processor~~ ✅ done (Phase 2a)

The mock now implements the full lifecycle:

- `request_redeem(shares, receiver, owner)` — burns shares immediately, records `{ owner, receiver, shares, request_epoch }`, emits `RedeemRequested`, returns auto-incrementing `id`.
- `process_epoch(new_pps)` — bumps `epoch`, sets `pps`, snapshots `pps_by_epoch[epoch] = new_pps`. Settlement is implicit: a request filed at epoch N becomes claimable once `current_epoch > N`, and uses `pps_by_epoch[N + 1]` as the settlement price (so later epoch reports never re-price old requests).
- `claim_redeem(id)` — checks `current_epoch > request_epoch`, computes `assets = shares * pps_by_epoch[request_epoch + 1] / WAD`, transfers underlying to `receiver`, marks `claimed = true`. Errors: `NOT_CLAIMABLE_YET`, `ALREADY_CLAIMED`, `UNKNOWN_REQUEST`, `UNAUTHORIZED_CLAIMER`.

Devnet tests confirm: claim-before-settle panics with `NOT_CLAIMABLE_YET`; claim-twice panics with `ALREADY_CLAIMED`; the happy path transfers the settled amount (e.g. 20 shares × 1.1 pps = 22 USD).

## What stays the same

- **Crypto / nullifier scheme**: shares notes are spent (nullifier created) at `RequestRedeem`. No reuse of nullifier logic between deposit / redemption.
- **Fees, paymasters, proof validation**: unchanged — same flow as deposit.

## Anonymizer storage model

The anonymizer keeps **one persistent map**: `redemption_commitments: Map<(gateway, id), commitment>`. This is the minimal state needed to make commitments uniquely addressable per redemption — and it's cleared on successful claim. No token balances, no per-id assets bookkeeping (the gateway's `due_assets_from_id` is the oracle for that), no NFT custody (the NFT lives at the gateway's `redeem_request` ERC-721 contract).

Between `RequestRedeem` and `ClaimRedeem` the anonymizer's only knowledge of Alice's redemption is the commitment hash. The off-chain `secret` (kept by the wallet) is what closes the loop at claim time.

## Open questions for the StarkWare team

1. **Note model decision (Option A vs B vs C above).** This is the single biggest architectural call. C is fast to prototype; A is the long-term correct shape.
2. **Does the pool currently support “zero-amount notes”?** A redemption NFT is conceptually a 1-of-1; if amount=0 is reserved for opens, encoding-the-id-as-amount needs a sentinel scheme.
3. **Epoch leakage.** Even in the private case, the redemption epoch is observable (it's a gateway storage slot). Anyone watching the chain can correlate "the gateway moved to epoch N+1 at block T" with "shares notes consumed in private tx at block T" → narrowing the anonymity set. Mitigations: delay claim by random number of epochs, batch claims off-chain. Worth discussing before committing to a design.
4. **Cross-chain redemption.** Real ForgeYields redemptions trigger an L1 bridge withdrawal via `claim_redeem`. The bridge transfer is public. Privacy ends at the Starknet boundary — is that an acceptable v2 scope, or do we need to anonymize the L1 withdrawal too (much harder)?

## Suggested phasing

| Phase | Scope | Status |
|---|---|---|
| **2a** | Mock gateway: full epoch lifecycle. No pool changes. | ✅ Done — `MockForgeYieldsGateway` + `forge-redeem.test.ts` |
| **2b** | Anonymizer: add `RequestRedeem` + `ClaimRedeem` ops with a commitment/secret bearer-protection layer (Option C+). SDK carries `(id, secret)` off-chain; only the wallet that holds the secret can claim. | ✅ Done — `ForgeYieldsAnonymizer` 3-op enum + `forge-private-redemption.test.ts` |
| **2c** | Pool note model: implement Option A (native NFT-note support) if the team confirms. Removes the bearer-instrument risk by having the pool track redemption-id ownership directly. Migrate the commitment scheme away. | After protocol-level decision |

### How Phase 2b achieves "claim only Alice can route" — two orthogonal checks

The anonymizer needs to answer two independent questions at claim time:

| Question | Mechanism | What it gates |
|---|---|---|
| "Has the gateway settled this redemption?" | SafeDispatcher.`owner_of(id)` on the gateway's `redeem_request` ERC-721 — `Result::Ok` = NFT alive, `Result::Err` = burned | Should the anonymizer trigger `gateway.claim_redeem` itself, or skip (it's already done)? |
| "Who has the authority to route this redemption's funds?" | `poseidon([secret]) == stored_commitment` (Pedersen-style commitment scheme) | Refuses to fill any open note unless the caller proves they hold the secret committed at request time |

Both checks are necessary and orthogonal:

- Without the **NFT-existence check**, the anonymizer would either always call `gateway.claim_redeem` (DoS if a bot front-ran) or never call it (wait for an external service that may not exist). The check lets the anonymizer be opportunistic.
- Without the **commitment check**, Mallory could observe a public `RedemptionRequested` event, build a tx with her own open note + the same `redemption_id`, and redirect the payout to herself.

### Bearer-protection scheme (commitment ↔ secret)

To prevent id-stealing (the redemption id is observable on-chain via the gateway's `RedeemRequested` event), the anonymizer wraps the redemption with a commitment:

1. Wallet picks a random `secret: felt252`, computes `commitment = poseidon([secret])`.
2. `RequestRedeem(gateway, shares, commitment)` — anonymizer stores `(gateway, id) → commitment` after the gateway assigns the id.
3. Anonymizer emits `RedemptionRequested { gateway, redemption_id, commitment }`. Wallet reads the id from the receipt and persists `(id, secret)` locally.
4. `ClaimRedeem(gateway, id, secret, ...)` — anonymizer verifies `poseidon([secret]) == stored_commitment`, clears the commitment (CEI ordering), then opportunistically calls `gateway.claim_redeem(id)` if the NFT is still alive.

Honest limits: the **commitment is storage-visible** on the anonymizer contract (so the chain knows redemption-id → commitment), but the **secret never leaves the wallet** until claim time and isn't correlated to the wallet's address. An adversary that observes only the gateway can race-claim only by guessing the secret (infeasible for a felt252). An adversary with read access to the anonymizer's storage can see commitments but cannot brute-force secrets either. The remaining residual risk: if a wallet leaks its secret (logs, backups, etc.), anyone with that secret can route the redemption to their note — same security tier as the viewing key.

Phase 2c (native NFT-note support in the pool) would remove the bearer category entirely by having the pool track redemption-id ownership cryptographically. Out of scope for an integration-only contributor.

Phases 2a and 2b ship independently of any pool change. Phase 2c depends on a protocol-level decision.

## See also

- [Privacy pool README](../../privacy/README.md) — note model + action phases as they exist today
- [Vesu lending anonymizer](../../vesu_lending_anonymizer/README.md) — the synchronous reference case
- [ForgeYields TokenGateway](../../../../forge-contracts-cvm/packages/token_gateway/README.md) — the redemption flow we're mirroring
