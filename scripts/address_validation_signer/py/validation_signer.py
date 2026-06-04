"""Reference SNIP-12 signer for the privacy contract's depositor validation.

Produces a signature that ``privacy::snip12::verify_depositor_validation``
accepts. The typed-data layout MUST stay in lockstep with the Cairo verifier
and with the sibling ``ts/validation_signer.ts`` — any drift on one side
breaks all three.

Usage:
    python validation_signer.py \\
        --signer-private-key 0x... \\
        --depositor 0x... \\
        --issued-at 1700000000 \\
        --chain-id SN_SEPOLIA

Or import ``sign_depositor_validation`` from another script/test.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass

from starknet_py.hash.utils import message_signature, private_to_stark_key
from starknet_py.utils.typed_data import TypedData

SNIP12_DOMAIN_NAME = "Screening"
SNIP12_DOMAIN_VERSION = "2"
PRIMARY_TYPE = "DepositorValidation"


@dataclass(frozen=True)
class SignInput:
    signer_private_key: int
    depositor: int
    issued_at: int
    chain_id: str


def _build_typed_data(depositor: int, issued_at: int, chain_id: str) -> TypedData:
    typed_data_dict = {
        "domain": {
            "name": SNIP12_DOMAIN_NAME,
            "version": SNIP12_DOMAIN_VERSION,
            "chainId": chain_id,
            "revision": "1",
        },
        "primaryType": PRIMARY_TYPE,
        "types": {
            "StarknetDomain": [
                {"name": "name", "type": "shortstring"},
                {"name": "version", "type": "shortstring"},
                {"name": "chainId", "type": "shortstring"},
                {"name": "revision", "type": "shortstring"},
            ],
            "DepositorValidation": [
                {"name": "depositor", "type": "ContractAddress"},
                {"name": "issued_at", "type": "u128"},
            ],
        },
        "message": {
            "depositor": hex(depositor),
            "issued_at": str(issued_at),
        },
    }
    return TypedData.from_dict(typed_data_dict)


def sign_depositor_validation(sign_input: SignInput) -> dict:
    signer_public_key = private_to_stark_key(sign_input.signer_private_key)
    typed_data = _build_typed_data(
        sign_input.depositor, sign_input.issued_at, sign_input.chain_id
    )
    message_hash = typed_data.message_hash(signer_public_key)
    # seed=None selects plain RFC 6979 nonce derivation (no extra entropy).
    # starknet-py's default (seed=32) folds the seed into the nonce as extra
    # entropy, which yields a different — equally valid — (r, s) than
    # starknet.js/@scure. Plain RFC 6979 keeps this signer bit-compatible with
    # the TypeScript signers, so identical inputs produce identical signatures.
    signature_r, signature_s = message_signature(
        message_hash, sign_input.signer_private_key, seed=None
    )
    return {
        "messageHash": hex(message_hash),
        "signature": {"r": hex(signature_r), "s": hex(signature_s)},
        "signerPublicKey": hex(signer_public_key),
        "input": {
            "depositor": hex(sign_input.depositor),
            "issuedAt": str(sign_input.issued_at),
            "chainId": sign_input.chain_id,
        },
    }


def _parse_int(value: str) -> int:
    return int(value, 16) if value.lower().startswith("0x") else int(value)


def _parse_args(argv: list[str]) -> SignInput:
    parser = argparse.ArgumentParser(description="Sign a DepositorValidation under SNIP-12.")
    parser.add_argument("--signer-private-key", required=True)
    parser.add_argument("--depositor", required=True)
    parser.add_argument("--issued-at", required=True)
    parser.add_argument("--chain-id", required=True)
    args = parser.parse_args(argv)
    return SignInput(
        signer_private_key=_parse_int(args.signer_private_key),
        depositor=_parse_int(args.depositor),
        issued_at=_parse_int(args.issued_at),
        chain_id=args.chain_id,
    )


def main(argv: list[str]) -> int:
    sign_input = _parse_args(argv)
    result = sign_depositor_validation(sign_input)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
