#! /usr/bin/env python3
from pathlib import Path
from starknet_py.net.full_node_client import FullNodeClient
from starknet_py.contract import Contract
from starknet_py.net.full_node_client import FullNodeClient
from starknet_py.net.account.account import Account
from starknet_py.net.models.chains import StarknetChainId
from starknet_py.net.signer.key_pair import KeyPair
from collections import Counter
from asyncio import run
from time import sleep

from test_utils.starknet_test_utils import Starknet

# TODO: Import from utils repo.
# from scripts.staking.upgrade.utils.utils import set_debug
# from scripts.staking.upgrade.utils.starknet_py_utils import *

STAKING_ADDRESS = "0x03745Ab04a431fc02871A139be6B93D9260b0Ff3E779AD9c8B377183B23109F1"
UPGRADE_GOVERNOR_ADDRESS = (
    "0x1c1b60b780a463c4ff2b53d0cc968ad405831d81dbd67433e746c4ef6bc96fd"
)
EVENT_NEW_STAKER = "NewStaker"
EVENT_DELETE_STAKER = "DeleteStaker"

EXPECTED_GAP = 68997070312500000000

# TODO: Replace with a public RPC.
SEPOLIA_RPC = "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_9/"
API_KEY = "INSERT_API_KEY_HERE"
DUMMY_PRIVATE_KEY = 1


async def fetch_stakers_new_delete_events(
    staking_address: str,
    node: FullNodeClient,
    from_block: int = 0,
    to_block: int | str = "latest",
) -> tuple[list[str], list[str], int]:
    print_debug(
        f"Fetching stakers new / delete events from block {from_block} to block {to_block}..."
    )
    # Convert to block to a block number.
    if isinstance(to_block, str):
        if to_block != "latest":
            raise ValueError("Invalid to_block value. Must be an integer or 'latest'.")
        to_block = await node.get_block_number()
    new_staker_events = await fetch_events(
        staking_address,
        EVENT_NEW_STAKER,
        node,
        from_block=from_block,
        to_block=to_block,
    )
    new_staker_addresses = [to_hex(event.keys[1]) for event in new_staker_events]
    delete_staker_events = await fetch_events(
        staking_address,
        EVENT_DELETE_STAKER,
        node,
        from_block=from_block,
        to_block=to_block,
    )
    deleted_addresses = [to_hex(event.keys[1]) for event in delete_staker_events]
    return new_staker_addresses, deleted_addresses, to_block


async def extract_stakers_list(node: FullNodeClient) -> list[int]:
    new_stakers, deleted_stakers, _ = await fetch_stakers_new_delete_events(
        STAKING_ADDRESS, node
    )
    active_stakers = [
        addr for addr in (Counter(new_stakers) - Counter(deleted_stakers)).elements()
    ]
    return active_stakers


async def compare_total_stake(
    staking_contract: Contract, stakers: list[int]
) -> tuple[int, int]:
    print_debug("Getting total stake...")
    (total_stake,) = await call_function(staking_contract, "get_total_stake")
    print_debug(f"Total stake: {total_stake}")
    accumulated_stake = 0
    print_debug(f"Accumulating stake...")
    for i, staker_address in enumerate(stakers):
        print_debug(f"Processing staker {staker_address} ({i + 1}/{len(stakers)})...")
        staker_address = int(staker_address, 16)
        (staker_info,) = await call_function(
            staking_contract, "staker_info_v1", [staker_address]
        )
        staker_stake = staker_info["amount_own"]
        pool_info = staker_info.get("pool_info")
        if pool_info:
            staker_stake += pool_info["amount"]
        if staker_info.get("unstake_time") is None:
            accumulated_stake += staker_stake
    print_debug(f"Accumulated stake: {accumulated_stake}")
    # Note: The total stake may change while it’s being accumulated. If this happens, you should recompute the accumulated stake. This is not relevant for devnet.
    # (total_stake_after,) = await call_function(staking_contract, "get_total_stake")
    # if total_stake != total_stake_after:
    #     return False
    return (total_stake, accumulated_stake)


async def main():
    # set_debug(True)
    # Fork Sepolia.
    devnet = Starknet(fork_network=SEPOLIA_RPC + API_KEY)
    sleep(10)
    node = devnet.get_client()
    print("Extracting stakers...")
    stakers = await extract_stakers_list(node)
    print(f"Extracted {len(stakers)} stakers.")
    # Test gap before upgrade using EIC.
    print("Comparing total stake before upgrade...")
    staking_contract = await get_contract_from_address(STAKING_ADDRESS, node)
    (total_stake, accumulated_stake) = await compare_total_stake(
        staking_contract, stakers
    )
    assert (
        accumulated_stake == total_stake - EXPECTED_GAP
    ), "Unexpected accumulated stake according to the expected gap"
    print("Gap is correct.")
    # Upgrade staking contract using EIC.
    print("Declaring EIC...")
    contract_folder = Path(__file__).parent.parent.parent.parent.parent.parent.parent
    eic_class_hash = await declare_contract(
        "StakingSepoliaEIC", contract_folder, "staking", devnet.accounts[0]
    )
    print(f"EIC declared. Class hash: {eic_class_hash}")
    print("Upgrading staking contract using EIC...")
    await node.impersonate_account(UPGRADE_GOVERNOR_ADDRESS)
    upgrade_account = Account(
        address=UPGRADE_GOVERNOR_ADDRESS,
        client=node,
        key_pair=KeyPair.from_private_key(DUMMY_PRIVATE_KEY),
        chain=StarknetChainId.SEPOLIA,
    )
    staking_contract_for_upgrade = await get_contract_from_address(
        STAKING_ADDRESS, upgrade_account
    )
    staking_class_hash = await get_class_hash_at(STAKING_ADDRESS, node)
    implementation_data = ImplementationData(
        impl_hash=int(staking_class_hash, 16),
        eic_data=EICData(
            eic_hash=int(eic_class_hash, 16),
            eic_init_data=[],
        ),
        final=False,
    )
    await upgrade_contract(staking_contract_for_upgrade, implementation_data)
    print("Staking contract upgraded.")
    # Test no gap after upgrade using EIC.
    print("Comparing total stake after upgrade...")
    (total_stake, accumulated_stake) = await compare_total_stake(
        staking_contract, stakers
    )
    assert accumulated_stake == total_stake, "Unexpected total stake after upgrade"
    print("✅Total stake is correct. No gap after upgrade.")


if __name__ == "__main__":
    run(main())