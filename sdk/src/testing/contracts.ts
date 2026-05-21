/**
 * Mock Contracts registry for testing.
 * Replaces simple ERC20s with a generic contract registry.
 */

import type { Amount, NoteId, StarknetAddress } from "../interfaces.js";
import { AddressMap, toBigInt } from "../utils/index.js";
import { assert } from "../utils/validation.js";
import type { MockPoolContract } from "./mock-pool-contract.js";

/** Interface for any mock contract */
export interface MockContract {
  address: StarknetAddress;
  // Allow any other methods
  [key: string]: unknown;
}

export class ERC20 implements MockContract {
  private balances = new AddressMap<Amount>(() => 0n);
  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(public address: StarknetAddress) {}

  transfer(from: StarknetAddress, to: StarknetAddress, amount: Amount): void {
    assert(this.balances.get(from)! >= amount, () => `Insufficient balance`);
    this.balances.set(from, this.balances.get(from)! - amount);
    this.balances.set(to, this.balances.get(to)! + amount);
  }

  balanceOf(address: StarknetAddress): Amount {
    return this.balances.get(address)!;
  }

  setBalance(address: StarknetAddress, amount: Amount): void {
    this.balances.set(address, amount);
  }

  increaseBalance(address: StarknetAddress, amount: Amount): void {
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }
}

export class MockSwapAnonymizer implements MockContract {
  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: StarknetAddress,
    private contracts: MockContracts,
    private poolAddress: StarknetAddress
  ) {}

  privacy_invoke(
    fromToken: StarknetAddress,
    toToken: StarknetAddress,
    amount: Amount,
    noteId: NoteId
  ): void {
    const balance = this.contracts.get(fromToken).balanceOf(this.address)!;
    assert(balance == amount, () => `Balance mismatch: ${balance} != ${amount}`);
    this.contracts.get(fromToken).setBalance(this.address, 0n);
    this.contracts.get(toToken).setBalance(this.address, amount * 2n);
    this.contracts
      .get<MockPoolContract>(toBigInt(this.poolAddress))
      .openDeposit(toBigInt(noteId), toBigInt(toToken), amount * 2n, toBigInt(this.address));
  }
}

export class MockContracts {
  private contracts = new AddressMap<MockContract>((address) => new ERC20(address));

  constructor(...contracts: MockContract[]) {
    for (const contract of contracts) {
      this.register(contract);
    }
  }

  /**
   * Get a contract instance. Defaults to creating a new ERC20 if not found.
   * Can be typed with a generic if the contract type is known.
   */
  get<T extends MockContract = ERC20>(address: StarknetAddress): T {
    return this.contracts.get(address)! as T;
  }

  /**
   * Register a contract instance manually.
   */
  register(contract: MockContract): void {
    this.contracts.set(contract.address, contract);
  }

  /**
   * Execute a call on a contract.
   * This is a helper for executing arbitrary calls, e.g. from InvokeExternal actions.
   * It attempts to find the method on the mock contract instance and invoke it.
   */
  call(contractAddress: StarknetAddress, method: string, args: unknown[] = []): unknown {
    const contract = this.get(contractAddress);
    if (typeof contract[method] === "function") {
      return contract[method].call(contract, ...args);
    }
    throw new Error(`Method ${method} not found on contract at ${contractAddress}`);
  }
}
