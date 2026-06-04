#!/usr/bin/env python3
"""Produces fixtures/screening-vectors.json for the cross-language tests using
the reference Python signer (scripts/address_validation_signer/py), the single
fixture producer.

Usage (requires starknet-py — see scripts/address_validation_signer/README.md
for the venv setup):
    scripts/address_validation_signer/py/.venv/bin/python scripts/gen_screening_fixtures.py
"""

import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY_SIGNER_DIR = os.path.join(REPO_ROOT, "scripts", "address_validation_signer", "py")
OUTPUT_PATH = os.path.join(REPO_ROOT, "fixtures", "screening-vectors.json")

sys.path.insert(0, PY_SIGNER_DIR)
try:
    from validation_signer import SignInput, sign_depositor_validation
except ImportError as import_error:
    raise SystemExit(
        f"cannot import the reference signer ({import_error}) — set up the venv per "
        f"scripts/address_validation_signer/README.md and rerun with "
        f"{os.path.join(PY_SIGNER_DIR, '.venv', 'bin', 'python')}"
    )

# Test-only reference signing key — never a production key.
SIGNER_PRIVATE_KEY = "0xCAFEBABE"

INPUTS = [
    {"name": "test_vector", "depositor": "0x1234", "issued_at": 1700000000, "chain_id": "TEST"},
    {
        "name": "sepolia_deposit",
        "depositor": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "issued_at": 1716579600,
        "chain_id": "SN_SEPOLIA",
    },
    {
        "name": "mainnet_deposit",
        "depositor": "0x06f3a1e2c5d40b9a78e2417b3c2d1e0f00112233445566778899aabbccddeeff",
        "issued_at": 1716580000,
        "chain_id": "SN_MAIN",
    },
]


def encode_short_string(text: str) -> str:
    """Cairo short-string encoding: ASCII bytes packed big-endian into a felt."""
    return hex(int.from_bytes(text.encode("ascii"), "big"))


def sign_with_reference_signer(canonical_input: dict) -> dict:
    return sign_depositor_validation(
        SignInput(
            signer_private_key=int(SIGNER_PRIVATE_KEY, 16),
            depositor=int(canonical_input["depositor"], 16),
            issued_at=canonical_input["issued_at"],
            chain_id=canonical_input["chain_id"],
        )
    )


def main() -> None:
    vectors = []
    # The public key depends only on the private key, not on any message, so any
    # signer invocation reports the same value.
    signer_public_key = ""
    for canonical_input in INPUTS:
        signed = sign_with_reference_signer(canonical_input)
        signer_public_key = signed["signerPublicKey"]
        vectors.append(
            {
                "name": canonical_input["name"],
                "chain_id_str": canonical_input["chain_id"],
                "chain_id": encode_short_string(canonical_input["chain_id"]),
                "depositor": signed["input"]["depositor"],
                "issued_at": canonical_input["issued_at"],
                "message_hash": signed["messageHash"],
                "sig_r": signed["signature"]["r"],
                "sig_s": signed["signature"]["s"],
            }
        )
    output = {
        "scheme": "SNIP-12 revision 1 DepositorValidation; STARK-curve ECDSA (RFC6979)",
        "signer_private_key": SIGNER_PRIVATE_KEY,
        "signer_public_key": signer_public_key,
        "vectors": vectors,
    }
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    # newline="\n" keeps the committed fixture LF-only on Windows too.
    open(OUTPUT_PATH, "w", newline="\n").write(json.dumps(output, indent=2) + "\n")
    print(f"wrote {len(vectors)} vectors -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
