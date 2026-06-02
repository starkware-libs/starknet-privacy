# SNIP-12 reference signers

Generate signatures that the privacy contract's `verify_depositor_validation`
([packages/privacy/src/snip12.cairo](../../packages/privacy/src/snip12.cairo))
accepts. Two implementations — TypeScript and Python — kept in lockstep:
identical inputs must produce identical `messageHash` and `signerPublicKey`
across both.

These are **reference** signers, not production tooling: useful for test
vectors, off-chain signer service integration, and cross-language sanity
checks during development.

## Layout

```
scripts/address_validation_signer/
  ts/  — TypeScript implementation (uses starknet.js)
  py/  — Python implementation (uses starknet-py)
```

## TypeScript

```bash
cd ts
npm install
npm run sign -- \
  --signer-private-key 0x1234 \
  --depositor 0xABCD \
  --issued-at 1700000000 \
  --chain-id SN_SEPOLIA
```

## Python

```bash
cd py
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python validation_signer.py \
  --signer-private-key 0x1234 \
  --depositor 0xABCD \
  --issued-at 1700000000 \
  --chain-id SN_SEPOLIA
```

## Cross-language fixtures

```bash
(cd ts && npm install)
../gen_screening_fixtures.py    # from this directory; or scripts/gen_screening_fixtures.py from repo root
```

`scripts/gen_screening_fixtures.py` is the canonical producer of
`fixtures/screening-vectors.json` (repo root) — the cross-language vectors the Cairo
verifier tests consume (rendered to Cairo by `scripts/gen_cairo_screening_vectors.py`),
and the intended vector source for the off-chain screening signer. It shells out to the
TS signer's CLI for the signatures, so the TS signer stays the single signing
implementation. Signing is deterministic (RFC6979), so regeneration is idempotent and
CI fails if the committed fixture drifts. The Python signer remains a hash-only
cross-check, not a fixture source: its nonce derivation differs from starknet.js's, so
it deterministically produces different (equally valid) `(r, s)` than the committed
vectors.

## Output

Both emit identical JSON shape on stdout:

```json
{
  "messageHash": "0x...",
  "signature": { "r": "0x...", "s": "0x..." },
  "signerPublicKey": "0x...",
  "input": { "depositor": "0x...", "issuedAt": "...", "chainId": "..." }
}
```
