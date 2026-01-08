"""Constants for flow tests."""


def str_to_felt252(s: str) -> int:
    """Convert a string to felt252 (same as Cairo string literal conversion).

    Takes UTF-8 bytes and interprets as big-endian integer.
    """
    return int.from_bytes(s.encode("utf-8"), byteorder="big")


# Compliance key (same as Cairo tests)
COMPLIANCE_PRIVATE_KEY = str_to_felt252("COMPLIANCE_PRIVATE_KEY")
