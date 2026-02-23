#!/bin/bash

echo "Starting Anvil..."
anvil --host 0.0.0.0 --port 8545 --block-time 1 > /dev/null &
ANVIL_PID=$!

until cast block-number --rpc-url http://localhost:8545 > /dev/null 2>&1; do
  sleep 1
done

mkdir -p /tmp/project/src
cd /tmp/project
cat > foundry.toml <<TOML
[profile.default]
src = "src"
out = "out"
solc = "0.8.19"
TOML

# STRICT TYPING CONTRACT
cat > src/StarknetCore.sol <<SOL
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract StarknetCore {
    // Genesis Root (Must match what Pathfinder expects)
    uint256 constant ROOT = 0x68bcf9e9257ab6bffd9425833a208aaab6b85649fd21c787a546cb7cb9abf;
    uint256 constant BLOCK_HASH = 0x450ba2f9ffd8117bdb83faea02d3fc9ffa8e9465964b87042736ac4e3172d9;

    function stateRoot() external pure returns (uint256) { return ROOT; }
    function stateBlockNumber() external pure returns (uint256) { return 0; }
    function stateBlockHash() external pure returns (uint256) { return BLOCK_HASH; }

    // Fallback for robustness
    fallback() external {
        uint256 r = ROOT;
        assembly {
            mstore(0, r)
            return(0, 32)
        }
    }
}
SOL

echo "Compiling..."
forge build --no-git 2>&1 | grep -v "Warning"

BYTECODE=$(forge inspect StarknetCore deployedBytecode)
if [ -z "$BYTECODE" ] || [ ${#BYTECODE} -lt 10 ]; then
   echo "CRITICAL ERROR: Failed to extract bytecode."
   exit 1
fi

CONTRACT_ADDR="0x4fA369fEBf0C574ea05EC12bC0e1Bc9Cd461Dd0f"

# Injection Loop
echo "Starting Injection Loop..."
while true; do
   CODE_SIZE=$(cast code "$CONTRACT_ADDR" --rpc-url http://localhost:8545)
   if [ "$CODE_SIZE" = "0x" ]; then
      echo "Injecting code..."
      cast rpc anvil_setCode "$CONTRACT_ADDR" "$BYTECODE" --rpc-url http://localhost:8545 > /dev/null
   fi
   sleep 2
done
