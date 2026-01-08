"""Helper functions for compiling contracts before tests."""

from pathlib import Path


def get_contract_artifact_path(contract_name: str, target: str = "release") -> Path:
    """Get the path to a compiled contract artifact."""
    project_root = Path(__file__).parent.parent.parent
    target_dir = project_root / "target" / target
    pattern = f"{contract_name}_*.contract_class.json"
    matches = list(target_dir.glob(pattern))
    if not matches:
        raise FileNotFoundError(f"Could not find contract class file for {contract_name}")
    return matches[0]


def get_contract_casm_path(contract_name: str, target: str = "release") -> Path:
    """Get the path to a compiled contract CASM file."""
    project_root = Path(__file__).parent.parent.parent
    target_dir = project_root / "target" / target
    pattern = f"{contract_name}_*.compiled_contract_class.json"
    matches = list(target_dir.glob(pattern))
    if not matches:
        raise FileNotFoundError(f"Could not find CASM file for {contract_name}")
    return matches[0]
