#!/usr/bin/env python3
"""Produces fixtures/screening-vectors.json for the cross-language tests by
shelling out to the reference TS signer (scripts/address_validation_signer/ts),
the single signing implementation.

Usage (requires `npm install` in scripts/address_validation_signer/ts first):
    scripts/gen_screening_fixtures.py
"""

import json
import os
import shutil
import subprocess

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_SIGNER_DIR = os.path.join(REPO_ROOT, "scripts", "address_validation_signer", "ts")
TS_SIGNER_BIN_DIR = os.path.join(TS_SIGNER_DIR, "node_modules", ".bin")
OUTPUT_PATH = os.path.join(REPO_ROOT, "fixtures", "screening-vectors.json")

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


def find_tsx_binary() -> str:
    """Resolves the tsx launcher, letting shutil.which pick the platform-appropriate
    executable name (tsx, tsx.cmd, ...)."""
    tsx_binary = shutil.which("tsx", path=TS_SIGNER_BIN_DIR)
    if tsx_binary is None:
        raise SystemExit(
            f"tsx not found in {TS_SIGNER_BIN_DIR} — run `npm install` in {TS_SIGNER_DIR} first"
        )
    return tsx_binary


def sign_with_ts_signer(tsx_binary: str, canonical_input: dict) -> dict:
    command = [
        tsx_binary,
        "validation_signer.ts",
        "--signer-private-key",
        SIGNER_PRIVATE_KEY,
        "--depositor",
        canonical_input["depositor"],
        "--issued-at",
        str(canonical_input["issued_at"]),
        "--chain-id",
        canonical_input["chain_id"],
    ]
    signer_process = subprocess.run(
        command, cwd=TS_SIGNER_DIR, capture_output=True, text=True, check=True
    )
    return json.loads(signer_process.stdout)


def main() -> None:
    tsx_binary = find_tsx_binary()
    vectors = []
    # The public key depends only on the private key, not on any message, so any
    # signer invocation reports the same value.
    signer_public_key = ""
    for canonical_input in INPUTS:
        signed = sign_with_ts_signer(tsx_binary, canonical_input)
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
