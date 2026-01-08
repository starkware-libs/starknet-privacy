"""Pytest fixtures for flow tests - minimal version for deployment test."""

import logging
from os import getenv

import pytest
import pytest_asyncio
from starknet_py.common import create_sierra_compiled_contract
from starknet_py.contract import Contract
from starknet_py.hash.sierra_class_hash import compute_sierra_class_hash
from starknet_py.net.account.account import Account
from starknet_py.net.client import Client
from starknet_py.net.client_errors import ClientError
from starknet_py.net.full_node_client import FullNodeClient
from starknet_py.devnet_utils.devnet_client import DevnetClient
from starknet_py.net.signer.stark_curve_signer import KeyPair

from .compile import (
    get_contract_artifact_path,
    get_contract_casm_path,
)
from .constants import (
    COMPLIANCE_PRIVATE_KEY,
)

DEVNET_URL: str = "http://localhost:5050/"

# Configure logging for flow tests
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s     %(name)s:%(filename)s:%(lineno)d %(message)s",
    force=True,
)

logger = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def worker_id() -> int:
    """Get index of the current worker."""
    return int(getenv(key="PYTEST_XDIST_WORKER", default="gw0")[2:])


@pytest_asyncio.fixture(scope="session")
async def predeployed_account(devnet: DevnetClient, worker_id: int) -> str:
    """Get predeployed account for worker."""
    return (await devnet.get_predeployed_accounts())[worker_id]


@pytest_asyncio.fixture(scope="session")
async def chain_id(client: FullNodeClient) -> str:
    """Get chain ID."""
    return await client.get_chain_id()


@pytest_asyncio.fixture(scope="session")
async def account(predeployed_account: str, chain_id: str, client: FullNodeClient) -> Account:
    """Get worker account."""
    key_pair = KeyPair.from_private_key(predeployed_account.private_key)
    address = predeployed_account.address
    return Account(address=address, client=client, key_pair=key_pair, chain=chain_id)


@pytest.fixture(scope="session")
def devnet() -> DevnetClient:
    """Get devnet client."""
    return DevnetClient(node_url=DEVNET_URL)


@pytest.fixture(scope="session")
def client() -> FullNodeClient:
    """Get full node client."""
    return FullNodeClient(node_url=DEVNET_URL)


@pytest.fixture(scope="session")
def compliance_public_key() -> int:
    """Fixed compliance public key for all tests."""
    key_pair = KeyPair.from_private_key(COMPLIANCE_PRIVATE_KEY)
    return key_pair.public_key


@pytest_asyncio.fixture
async def privacy_contract(
    account: Account,
    compliance_public_key: int,
) -> Contract:
    """Deploy a fresh Privacy contract."""
    # Load compiled contract (Sierra) as JSON string
    artifact_path = get_contract_artifact_path("privacy")
    with open(artifact_path) as f:
        compiled_contract = f.read()

    # Load CASM file for Cairo 1.0 (as JSON string)
    casm_path = get_contract_casm_path("privacy")
    with open(casm_path) as f:
        compiled_contract_casm = f.read()

    # Try to declare contract (may already be declared)
    try:
        declare_result = await Contract.declare_v3(
            account=account,
            compiled_contract=compiled_contract,
            compiled_contract_casm=compiled_contract_casm,
            auto_estimate=True,
        )
        await declare_result.wait_for_acceptance()
        class_hash = declare_result.class_hash
    except ClientError as e:
        if "already declared" in str(e):
            logger.info("Contract already declared, computing Sierra class hash for deployment")
            # If already declared, compute the Sierra class hash for deployment
            sierra_class = create_sierra_compiled_contract(compiled_contract)
            class_hash = compute_sierra_class_hash(sierra_class)
        else:
            raise

    # Deploy contract
    # Constructor requires: governance_admin (ContractAddress) and compliance_public_key (felt252)
    logger.info(
        f"Deploying contract with class hash {hex(class_hash)} and governance admin {account.address}"
    )
    governance_admin = account.address
    try:
        deploy_result = await Contract.deploy_contract_v3(
            account=account,
            class_hash=class_hash,
            constructor_args=[governance_admin, compliance_public_key],
            auto_estimate=True,
        )
        await deploy_result.wait_for_acceptance()
    except ClientError as e:
        raise RuntimeError(
            f"Failed to deploy contract with class hash {hex(class_hash)}: {e}"
        ) from e

    return deploy_result.deployed_contract
