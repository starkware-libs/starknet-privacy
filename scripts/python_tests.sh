#!/bin/bash
# TODO: Add a way to specify the number of workers.
# TODO: Add a way to not be verbose.
# TODO: Add a way to not compile contracts.
set -e  # exit on first failure

pushd $(dirname "$0")/..

# Color variables
COLOR_OFF="\033[0m"
RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
PURPLE='\033[1;35m'

# Configuration variables
CORES=$(nproc)
DEVNET_LOG="devnet.log"
DEVNET_PID=""

# Check if venv exists, create if it doesn't
if [ ! -d "venv" ]; then
    printf "${YELLOW}Virtual environment not found. Creating venv...\n"
    python3 -m venv venv
    printf "${GREEN}Virtual environment created\n"
fi

# Activate venv
source ./venv/bin/activate

# Install/upgrade requirements if venv was just created or if requirements changed
if [ ! -f "venv/.requirements_installed" ] || [ "py_requirements.txt" -nt "venv/.requirements_installed" ]; then
    printf "${YELLOW}Installing requirements...\n"
    pip install --upgrade pip
    pip install -r py_requirements.txt
    touch venv/.requirements_installed
    printf "${GREEN}Requirements installed\n"
fi

printf "${YELLOW}Detected $CORES CPU cores\n"

# Compile contracts
printf "${YELLOW}Compiling contracts with scarb...\n"
scarb --release build
printf "${GREEN}Contracts compiled\n"

# Start starknet-devnet in the background
printf "${YELLOW}Starting starknet-devnet with $CORES accounts (logging to $DEVNET_LOG)...\n"
starknet-devnet --seed 0 --accounts $CORES > "$DEVNET_LOG" 2>&1 &
DEVNET_PID=$!

# Cleanup function to kill devnet on exit
cleanup() {
    printf "${YELLOW}Stopping starknet-devnet (PID: $DEVNET_PID)...\n"
    kill $DEVNET_PID 2>/dev/null || true
    wait $DEVNET_PID 2>/dev/null || true
}
trap cleanup EXIT

# Give devnet a moment to start
sleep 2

printf "${YELLOW} pytest...\n"
pytest . -sv -n $CORES
printf "${GREEN}Pytest succeed\n"


# Reset
printf "${COLOR_OFF}"
popd
