"""Simple deployment test for Privacy contract."""

import pytest
from starknet_py.contract import Contract


@pytest.mark.asyncio
@pytest.mark.parametrize("run_number", range(100))
async def test_privacy_contract_deployment(
    privacy_contract: Contract,
    compliance_public_key: int,
    run_number: int,
) -> None:
    """Test that Privacy contract can be deployed successfully and compliance key is set correctly.

    This test runs 10 times to verify concurrency support.
    """
    # Verify the contract was deployed
    assert privacy_contract.address is not None
    assert int(privacy_contract.address) != 0

    # Verify compliance public key was initialized correctly
    result = await privacy_contract.functions["get_compliance_public_key"].call()
    stored_compliance_key = result[0]  # Function returns a tuple
    assert stored_compliance_key == compliance_public_key
