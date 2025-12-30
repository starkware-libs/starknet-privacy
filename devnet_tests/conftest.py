import json
import os
import time
from pathlib import Path

import pytest
import requests

from starknet_py.contract import Contract
from starknet_py.net.full_node_client import FullNodeClient
from starknet_py.net.account.account import Account
from starknet_py.net.signer.stark_curve_signer import KeyPair, StarkCurveSigner
from starknet_py.net.models.chains import StarknetChainId
from starknet_py.net.client_models import ResourceBounds, ResourceBoundsMapping

from test_utils.starknet_test_utils import StarknetTestUtils

# ----------------------------
# Devnet (Docker) - session scoped
# ----------------------------


@pytest.fixture(scope="session", autouse=True)
def devnet():
    """
    Starts Devnet in Docker for the whole test session.
    Sets STARKNET_RPC_URL, DEVNET_ACCOUNT_ADDRESS, DEVNET_ACCOUNT_PRIVATE_KEY.
    """
    devnet = StarknetTestUtils()

    host = container.get_container_host_ip()
    port = int(container.get_exposed_port(5050))
    base = f"http://{host}:{port}"

    # Wait until ready
    for _ in range(80):
        try:
            r = requests.get(f"{base}/is_alive", timeout=0.5)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(0.25)
    else:
        container.stop()
        raise RuntimeError("Devnet did not become ready")

    # Some devnet builds expose JSON-RPC at /rpc, others directly at /
    # We'll detect:
    rpc_url = f"{base}/rpc"
    try:
        requests.post(
            rpc_url,
            json={"jsonrpc": "2.0", "id": 0, "method": "starknet_chainId", "params": []},
            timeout=0.5,
        ).raise_for_status()
    except Exception:
        rpc_url = base

    os.environ["STARKNET_RPC_URL"] = rpc_url

    # Get a predeployed account from devnet (common endpoint on devnet-rs)
    # If your devnet doesn’t support this endpoint, hardcode account creds instead.
    acct = requests.get(f"{base}/predeployed_accounts", timeout=2).json()[0]
    os.environ["DEVNET_ACCOUNT_ADDRESS"] = acct["address"]
    os.environ["DEVNET_ACCOUNT_PRIVATE_KEY"] = acct["private_key"]

    yield

    container.stop()


# ----------------------------
# Starknet.py fixtures
# ----------------------------


@pytest.fixture(scope="session")
def client() -> FullNodeClient:
    return FullNodeClient(node_url=os.environ["STARKNET_RPC_URL"])


@pytest.fixture(scope="session")
def account(client: FullNodeClient) -> Account:
    addr = int(os.environ["DEVNET_ACCOUNT_ADDRESS"], 16)
    priv = int(os.environ["DEVNET_ACCOUNT_PRIVATE_KEY"], 16)

    key_pair = KeyPair.from_private_key(priv)

    # Devnet commonly uses the Sepolia chain id.
    # If your devnet is configured differently, change this.
    chain = StarknetChainId.SEPOLIA
    signer = StarkCurveSigner(account_address=addr, key_pair=key_pair, chain_id=chain)

    return Account(client=client, address=addr, signer=signer, chain=chain)


def _resource_bounds_for_devnet() -> ResourceBoundsMapping:
    # Devnet is permissive; these are “big enough” defaults for v3 txs.
    return ResourceBoundsMapping(
        l1_gas=ResourceBounds(max_amount=int(1e6), max_price_per_unit=int(1e13)),
        l2_gas=ResourceBounds(max_amount=int(1e10), max_price_per_unit=int(1e17)),
        l1_data_gas=ResourceBounds(max_amount=int(1e6), max_price_per_unit=int(1e13)),
    )


def _load_scarb_artifacts(contract_stem: str) -> tuple[str, str, list | None]:
    """
    Expects Scarb artifacts:
      target/dev/<contract_stem>.contract_class.json
      target/dev/<contract_stem>.compiled_contract_class.json
    Adjust names if your output differs.
    """
    base = Path("target/dev")
    sierra_path = base / f"{contract_stem}.contract_class.json"
    casm_path = base / f"{contract_stem}.compiled_contract_class.json"

    compiled_contract = sierra_path.read_text()
    compiled_contract_casm = casm_path.read_text()

    abi = json.loads(compiled_contract).get("abi")
    return compiled_contract, compiled_contract_casm, abi


async def declare_and_deploy_v3(
    account: Account,
    contract_stem: str,
    constructor_args: dict | None = None,
) -> Contract:
    compiled_contract, compiled_contract_casm, _abi = _load_scarb_artifacts(contract_stem)
    resource_bounds = _resource_bounds_for_devnet()

    declare_result = await Contract.declare_v3(
        account=account,
        compiled_contract=compiled_contract,
        compiled_contract_casm=compiled_contract_casm,
        resource_bounds=resource_bounds,
    )
    await declare_result.wait_for_acceptance()

    deploy_result = await declare_result.deploy_v3(
        constructor_args=constructor_args or {},
        resource_bounds=resource_bounds,
    )
    await deploy_result.wait_for_acceptance()
    return deploy_result.deployed_contract


# ----------------------------
# Per-test: declare + deploy 2 contracts
# ----------------------------


@pytest.fixture(scope="function")
async def two_contracts(account: Account):
    """
    Declares + deploys BOTH contracts at the beginning of EACH test.
    Replace 'contract_a'/'contract_b' with your artifact stems.
    """
    c1 = await declare_and_deploy_v3(account, "contract_a", constructor_args={})
    c2 = await declare_and_deploy_v3(account, "contract_b", constructor_args={})
    return c1, c2
