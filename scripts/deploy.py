#!/usr/bin/env python3
"""
Simple deployment script for the Privacy contract using starknet_py.

Usage:
    # Devnet (chain-id required to specify fork type)
    python scripts/deploy.py --network devnet --governance-admin <ADDRESS> --compliance-key <KEY> --chain-id SEPOLIA
    python scripts/deploy.py --network devnet --governance-admin <ADDRESS> --compliance-key <KEY> --chain-id MAINNET
    
    # Testnet (uses SEPOLIA automatically)
    python scripts/deploy.py --network testnet --governance-admin <ADDRESS> --compliance-key <KEY> --private-key <KEY> --account-address <ADDRESS>
    
    # Mainnet (uses MAINNET automatically)
    python scripts/deploy.py --network mainnet --governance-admin <ADDRESS> --compliance-key <KEY> --private-key <KEY> --account-address <ADDRESS>
"""

import argparse
import asyncio
from pathlib import Path
from typing import Optional

from starknet_py.contract import Contract
from starknet_py.net.account.account import Account
from starknet_py.net.full_node_client import FullNodeClient
from starknet_py.net.signer.key_pair import KeyPair
from starknet_py.net.models.chains import StarknetChainId


async def deploy_contract(
    network: str,
    governance_admin: str,
    compliance_public_key: str,
    private_key: Optional[str] = None,
    account_address: Optional[str] = None,
    rpc_url: Optional[str] = None,
    chain_id: Optional[StarknetChainId] = None,
) -> str:
    """
    Deploy the Privacy contract.

    Args:
        network: Network to deploy to ('devnet', 'testnet', or 'mainnet')
        governance_admin: Governance admin address (hex string)
        compliance_public_key: Compliance public key (hex string or decimal)
        private_key: Private key for the deployer account (optional for devnet)
        account_address: Account address for the deployer (optional for devnet)
        rpc_url: Custom RPC URL (optional, will use defaults if not provided)
        chain_id: Chain ID (required for devnet only, to specify fork type: SEPOLIA or MAINNET)

    Returns:
        Deployed contract address
    """
    # Determine network URLs and chain IDs
    if network == "devnet":
        if rpc_url is None:
            rpc_url = "http://localhost:5050/rpc"
        if chain_id is None:
            raise ValueError("--chain-id is required for devnet (specify SEPOLIA or MAINNET to indicate the fork type)")
    elif network == "testnet":
        if rpc_url is None:
            rpc_url = "https://starknet-sepolia.public.blastapi.io/rpc/v0_7"
        # Always use SEPOLIA for testnet
        chain_id = StarknetChainId.SEPOLIA
    elif network == "mainnet":
        if rpc_url is None:
            rpc_url = "https://starknet-mainnet.public.blastapi.io/rpc/v0_7"
        # Always use MAINNET for mainnet
        chain_id = StarknetChainId.MAINNET
    else:
        raise ValueError(f"Invalid network: {network}. Must be one of ['devnet', 'testnet', 'mainnet']")

    # Always use release build
    build_type = "release"

    # Load contract class files
    project_root = Path(__file__).parent.parent
    contract_class_path = project_root / "target" / build_type / "privacy_Privacy.contract_class.json"
    compiled_class_path = project_root / "target" / build_type / "privacy_Privacy.compiled_contract_class.json"

    if not contract_class_path.exists():
        raise FileNotFoundError(
            f"Contract class file not found: {contract_class_path}\n"
            "Please run 'scarb build' first to compile the contract."
        )

    if not compiled_class_path.exists():
        raise FileNotFoundError(
            f"Compiled contract class file not found: {compiled_class_path}\n"
            "Please run 'scarb build' first to compile the contract."
        )

    # Read contract files as text
    eic_compiled_sierra = contract_class_path.read_text()
    eic_compiled_casm = compiled_class_path.read_text()

    # Setup account
    if network == "devnet" and private_key is None:
        # Use default devnet account
        private_key = "0xe3e70682c2094cac629f6fbed82c07cd"
        account_address = "0x7e00d496e324876bbc8531f2d9a82bf154d1a04a50218ee74d101b367ec4eef"
        print("Using default devnet account")

    if private_key is None or account_address is None:
        raise ValueError(
            "private_key and account_address are required for testnet/mainnet. "
            "For devnet, they are optional (default account will be used)."
        )

    # Create account
    key_pair = KeyPair.from_private_key(int(private_key, 16))
    client = FullNodeClient(rpc_url)
    account = Account(
        client=client,
        address=account_address,
        key_pair=key_pair,
        chain=chain_id,
    )

    print(f"Deploying to {network} at {rpc_url}")
    print(f"Chain ID: {chain_id.name if hasattr(chain_id, 'name') else chain_id}")
    print(f"Using account: {account_address}")

    # Prepare constructor arguments
    governance_admin_int = int(governance_admin, 16) if governance_admin.startswith("0x") else int(governance_admin)
    compliance_key_int = int(compliance_public_key, 16) if compliance_public_key.startswith("0x") else int(compliance_public_key)

    constructor_args = [governance_admin_int, compliance_key_int]

    print(f"Constructor arguments:")
    print(f"  governance_admin: {hex(governance_admin_int)}")
    print(f"  compliance_public_key: {hex(compliance_key_int)}")

    # Declare contract class
    print("\nDeclaring contract class...")
    declare_result = await Contract.declare_v3(
        account=account,
        compiled_contract=eic_compiled_sierra,
        compiled_class_hash=None,
        compiled_contract_casm=eic_compiled_casm,
        auto_estimate=True,      # estimates resource bounds
        auto_estimate_tip=True,  # (optional) estimates tip if supported
    )
    await declare_result.wait_for_acceptance()

    print(f"Class declared: {hex(declare_result.class_hash)}")

    # Deploy contract
    print("\nDeploying contract...")
    deploy_result = await declare_result.deploy_v3(
        constructor_args=constructor_args,
        auto_estimate=True,
        auto_estimate_tip=True,
    )
    await deploy_result.wait_for_acceptance()

    contract_address = deploy_result.deployed_contract.address
    print(f"\n✅ Contract deployed successfully!")
    print(f"Contract address: {hex(contract_address)}")
    print(f"Transaction hash: {hex(deploy_result.hash)}")

    return hex(contract_address)


def main():
    parser = argparse.ArgumentParser(description="Deploy Privacy contract to Starknet")
    parser.add_argument(
        "--network",
        type=str,
        required=True,
        choices=["devnet", "testnet", "mainnet"],
        help="Network to deploy to",
    )
    parser.add_argument(
        "--governance-admin",
        type=str,
        required=True,
        help="Governance admin address (hex string)",
    )
    parser.add_argument(
        "--compliance-key",
        type=str,
        required=True,
        help="Compliance public key (hex string or decimal)",
    )
    parser.add_argument(
        "--private-key",
        type=str,
        default=None,
        help="Private key for deployer account (required for testnet/mainnet)",
    )
    parser.add_argument(
        "--account-address",
        type=str,
        default=None,
        help="Account address for deployer (required for testnet/mainnet)",
    )
    parser.add_argument(
        "--rpc-url",
        type=str,
        default=None,
        help="Custom RPC URL (optional, uses defaults if not provided)",
    )
    parser.add_argument(
        "--chain-id",
        type=str,
        default=None,
        choices=["MAINNET", "SEPOLIA"],
        help="Chain ID (required for devnet only, to specify if devnet is a SEPOLIA or MAINNET fork). Options: MAINNET, SEPOLIA",
    )

    args = parser.parse_args()

    # Validate chain-id usage
    if args.chain_id and args.network != "devnet":
        raise ValueError("--chain-id can only be specified for devnet. Testnet uses SEPOLIA and mainnet uses MAINNET automatically.")

    # Convert chain ID string to StarknetChainId enum
    chain_id = None
    if args.chain_id:
        chain_id_map = {
            "MAINNET": StarknetChainId.MAINNET,
            "SEPOLIA": StarknetChainId.SEPOLIA,
        }
        chain_id = chain_id_map[args.chain_id]

    asyncio.run(
        deploy_contract(
            network=args.network,
            governance_admin=args.governance_admin,
            compliance_public_key=args.compliance_key,
            private_key=args.private_key,
            account_address=args.account_address,
            rpc_url=args.rpc_url,
            chain_id=chain_id,
        )
    )


if __name__ == "__main__":
    main()
