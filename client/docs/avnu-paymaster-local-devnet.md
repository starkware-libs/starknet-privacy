# Testing `AvnuPaymaster` against a real (self-hosted) AVNU paymaster

`AvnuPaymaster` (`client/src/paymaster.ts`) speaks the SNIP-29 paymaster JSON-RPC to AVNU. Our
devnet e2e tests **mock** the paymaster (inject a fake `Paymaster` that broadcasts the proven
`apply_actions` with an ordinary account), so they never exercise the real AVNU **wire format** — the
part where bugs like decimal-vs-hex felts live. This note records how the wire format *can* be
validated against AVNU's own software, for whoever picks up a live-paymaster e2e later. (No such test
exists yet — this is parked reference, not a plan of record.)

## Key finding: our request is native to AVNU's open-source paymaster

AVNU's paymaster is open-source and self-hostable: <https://github.com/avnu-labs/paymaster>
(docs: <https://docs.out-of-gas.xyz>). It **natively** supports the privacy-pool flow we use — the
README lists *"Privacy pool integration with sponsored, gasless, and sponsored-private fee modes."*
Confirmed from the source (`crates/paymaster-rpc`):

- **Methods:** `paymaster_buildTransaction`, `paymaster_executeTransaction` (+ `paymaster_health`,
  `paymaster_isAvailable`, `paymaster_getSupportedTokens`).
- **Fee mode wire shape** (`#[serde(tag = "mode", rename_all = "snake_case")]`):
  `{ "mode": "sponsored_private", "pool_fee_token": "0x…", "tip": "normal" }` — matches our
  `PaymasterFeeMode`.
- **Transaction types:** `apply_action` / `invoke_and_apply_action` are real wire names, e.g.
  `{ "type": "apply_action", "apply_action": { "pool_address": "0x…" } }` — matches our `PaymasterBuild`.

So a locally-run AVNU paymaster is an authoritative oracle for the exact request `AvnuPaymaster` sends.

## Running it against a local devnet

AVNU's own integration tests do exactly this (a devnet container + `ChainID::Sepolia`), so the pattern
is proven upstream.

1. **Deploy** (writes the profile; signs one multicall with a prefunded master account):
   ```
   paymaster-cli quick-setup --chain-id=sepolia --rpc-url=<devnet-rpc> \
     --master-address=<funded devnet acct> --master-pk=<pk> --force --profile=paymaster.json
   ```
   This deploys a forwarder, gas tank, estimate account, and 2 relayers on devnet.
2. **Run** the service on port **12777** (default):
   ```
   docker run --rm -d -p 12777:12777 -e PAYMASTER_PROFILE=/p.json -v $PWD/paymaster.json:/p.json avnulabs/paymaster:latest
   # or: cargo run --release --bin paymaster-service --profile=paymaster.json
   ```
3. **Deploy the privacy pool yourself** (quick-setup does NOT), then merge a `privacy` block into the
   profile with its address, and restart.
4. Point the client at it: `new AvnuPaymaster({ url: "http://localhost:12777", apiKey, feeMode: { mode: "sponsored_private", poolFeeToken } })`.

### Minimal profile shape (assembled from the Rust `Configuration` structs — no combined example ships)

```json
{
  "rpc": { "port": 12777 },
  "starknet": { "chain_id": "sepolia", "endpoint": "http://127.0.0.1:5050/rpc/v0_9" },
  "privacy": { "pool": "0x<POOL>", "pool_fee_amount": "1000000000000000", "gas_overhead": 80000000 },
  "relayers": { "private_key": "0x…", "addresses": ["0x…", "0x…"], "lock": { "mode": "seggregated" } },
  "sponsoring": { "mode": "self", "api_key": "paymaster_<KEY>" }
  /* + forwarder / gas_tank / estimate_account / price — all populated by quick-setup */
}
```

## Gotchas (why this must be an opt-in / non-hermetic test)

- **chain-id is a closed enum** (`sepolia`/`mainnet` only). Devnet's default chain-id (`TESTNET`)
  resolves to the same `SN_SEPOLIA` felt, so use `chain_id: "sepolia"` and **don't** override devnet's
  chain-id. There is no live cross-check, so a mismatch silently yields invalid signatures.
- **API key required** for `sponsored_private` — self-sponsor keys must start with `paymaster_`. Set
  `AvnuPaymaster.apiKey` accordingly.
- **Price oracle needs network egress** (Coingecko / AVNU). There is no offline price provider
  selectable via config, and `sponsored_private` converts the STRK pool fee into `pool_fee_token` at
  build time — so this **cannot run in a hermetic/offline CI**. (Possibly avoidable by setting
  `poolFeeToken = STRK` to skip the conversion — unverified.)
- **Relayers start at 0 STRK**; a rebalancing pass funds them from the gas tank. `buildTransaction`
  returns `ServiceNotAvailable` until a relayer clears `min_relayer_balance` — poll `paymaster_isAvailable`
  (not `/health`, which only means the HTTP server is up) before firing test traffic.
- **Privacy pool is out-of-band:** quick-setup deploys relayer infra but never a pool.
- AVNU's own devnet-backed CI for this flow is currently **skipped upstream** — treat a live-paymaster
  e2e as first-of-its-kind.

## Sources

- <https://github.com/avnu-labs/paymaster> (crates: `paymaster-rpc`, `paymaster-starknet`,
  `paymaster-cli`; `docs/private-transactions.md`)
- <https://docs.out-of-gas.xyz>
- SNIP-29: <https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-29.md>
- starknet-devnet: <https://github.com/0xSpaceShard/starknet-devnet>
