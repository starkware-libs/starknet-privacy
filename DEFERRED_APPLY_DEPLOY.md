# Deferred-apply variant — deploy guide

This branch (`hackathon/yoni/delayed-proofs`) adds `store_actions` /
`apply_stored_actions` to the privacy pool: the actions can be committed
to storage in one transaction (no proof) and applied later with a fresh
proof, so the proof's validity window does not need to cover the time
between intent and execution.

The Cairo, SDK, and demo changes are committed locally. To get a working
preview you need to:

1. **Declare + deploy the new pool on Sepolia.**
2. **Point a new demo build at the new pool + push to Vercel.**

Both steps require credentials that aren't checked in.

---

## 1. Build artifacts (already done if you ran `scarb --release build`)

```bash
cd /home/yonatan/workspace/starknet-privacy2
scarb --release build
# → target/release/privacy_Privacy.contract_class.json
# → target/release/privacy_Privacy.compiled_contract_class.json
```

## 2. Declare + deploy on Sepolia

The new script lives in `e2e/scripts/deploy-privacy-pool.ts` and the
`deploy-privacy-pool` npm script in `e2e/package.json` wires it up.

### Required env (`e2e/.env`)

```bash
VITE_RPC_URL=<your sepolia RPC>
# Admin account funded with enough STRK to declare + deploy.
ACCOUNTS=[{"name":"admin","address":"0x...","privateKey":"0x...","admin":true}]
# Optional — defaults shown.
VITE_COMPLIANCE_PUBLIC_KEY=0x650017a7a62969b7c5735b5fe5725db27471eda81a57541ffd3c3b92c76cae4
VITE_PROOF_VALIDITY_BLOCKS=450
# Optional: pin a deterministic address. Random if omitted.
DEPLOY_SALT=0x<your salt>
```

Reuse the auditor public key / proof validity from the existing demo so
the discovery-service indexer continues to work without redeployment.

### Run

```bash
cd e2e
npm install                  # if you haven't already
npm run deploy-privacy-pool
```

Output ends with:

```
Update demo/.env.testnet.local:
  VITE_POOL_CLASS_HASH=0x...
  VITE_POOL_ADDRESS=0x...
```

## 3. Update the demo env

Edit `demo/.env.testnet.local`:

- Set `VITE_POOL_CLASS_HASH` to the printed class hash.
- Set `VITE_POOL_ADDRESS` to the printed pool address.
- Leave all other vars (indexer URL, Ekubo, Vesu, tokens) untouched — the
  helper contracts are reused.

Then verify locally:

```bash
cd sdk && npm install && npm run build && cd ..
cd demo && npm install && npm run build:testnet
npm run dev   # http://localhost:5173
```

In the UI, the **Config** panel now has a `Deferred apply  [2-step]`
checkbox. Toggle it on and any action runs as:

1. `Submit store_actions` — regular tx, no proof.
2. `Submit apply_stored_actions` — tx with proof; calls
   `apply_stored_actions(actions_hash)`.

The two steps appear as separate entries in the status timeline.

## 4. Deploy the demo to Vercel

The repo's `demo/.vercel/` is already linked to the production project.
For an isolated preview of this variant, deploy under a new alias:

```bash
cd demo
npx vercel link --yes        # if not already linked locally
# Push the new pool address to the deploy env (preview).
# Replace the two values with the ones printed above.
echo "0x<your new class hash>" | npx vercel env add VITE_POOL_CLASS_HASH preview
echo "0x<your new pool address>" | npx vercel env add VITE_POOL_ADDRESS preview

npx vercel pull --environment=preview
npx vercel build
npx vercel deploy --prebuilt
```

The deploy URL printed at the end is your new demo instance.

## 5. Verify the new instance

1. Open the deploy URL in a fresh tab.
2. Import a throwaway account JSON with a funded Sepolia address.
3. Toggle **Deferred apply** in the Config panel.
4. Run **Mint → Deposit**. Confirm the timeline shows two on-chain
   transactions (`store_actions` then `apply_stored_actions`) and that
   the private balance updates after the second one settles.
5. Reload — state should clear on mainnet builds. (Testnet keeps it.)

## Rollback

The new contract address is independent — the previous pool at
`0x00c3b88b2dcecdc70b4d1ce8c6bacfa69222d520335a7ba8a780056355ef5574`
keeps working. To rollback, restore the original
`VITE_POOL_ADDRESS` / `VITE_POOL_CLASS_HASH` in `demo/.env.testnet.local`
and on Vercel, then redeploy.
