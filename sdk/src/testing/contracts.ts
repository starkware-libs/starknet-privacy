/**
 * Mock Contracts registry for testing.
 * Replaces simple ERC20s with a generic contract registry.
 */

import type { Amount, NoteId, StarknetAddress } from "../interfaces.js";
import { AddressMap, toBigInt } from "../utils/index.js";
import { assert } from "../utils/validation.js";
import type { PrivacyPool } from "./pool.js";

/** Interface for any mock contract */
export interface MockContract {
  address: StarknetAddress;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
  // Allow any other methods
  [key: string]: unknown;
}

/** Snapshot of an ERC20's balance state */
export type ERC20Snapshot = Map<bigint, Amount>;

/** Snapshot of all contracts' state */
export type ContractsSnapshot = Map<bigint, unknown>;

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

  /** Create a snapshot of the current balance state */
  snapshot(): ERC20Snapshot {
    return new Map(this.balances.entries());
  }

  /** Restore balance state from a snapshot */
  restore(snapshot: ERC20Snapshot): void {
    this.balances.clear();
    for (const [addr, amount] of snapshot) {
      this.balances.set(addr, amount);
    }
  }
}

export class MockSwapHelper implements MockContract {
  // Allow dynamic access for MockContract interface
  [key: string]: unknown;

  constructor(
    public address: StarknetAddress,
    private contracts: MockContracts
  ) {}

  snapshot(): Record<string, never> {
    return {};
  }

  restore(_snapshot: Record<string, never>): void {
    // Do nothing
  }

  swap(
    fromToken: StarknetAddress,
    toToken: StarknetAddress,
    amount: Amount,
    poolAddress: StarknetAddress,
    noteId: NoteId
  ): void {
    const balance = this.contracts.get(fromToken).balanceOf(this.address)!;
    assert(balance == amount, () => `Balance mismatch: ${balance} != ${amount}`);
    this.contracts.get(fromToken).setBalance(this.address, 0n);
    this.contracts.get(toToken).setBalance(this.address, amount * 2n);
    this.contracts
      .get<PrivacyPool>(toBigInt(poolAddress))
      .openDeposit(toBigInt(noteId), toBigInt(toToken), amount * 2n);
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
   * This is a helper for executing arbitrary calls, e.g. from FollowupCall actions.
   * It attempts to find the method on the mock contract instance and invoke it.
   */
  call(contractAddress: StarknetAddress, method: string, ...args: unknown[]): unknown {
    const contract = this.get(contractAddress);
    if (typeof contract[method] === "function") {
      return (contract[method] as (...args: unknown[]) => unknown)(...args);
    }
    throw new Error(`Method ${method} not found on contract at ${contractAddress}`);
  }

  /** Create a snapshot of all contracts' state */
  snapshot(): ContractsSnapshot {
    const result = new Map<bigint, unknown>();
    for (const [addr, contract] of this.contracts.entries()) {
      result.set(addr, contract.snapshot());
    }
    return result;
  }

  /** Restore all contracts' state from a snapshot */
  restore(snapshot: ContractsSnapshot): void {
    for (const [addr, contractSnapshot] of snapshot) {
      // We assume contracts still exist at the same addresses
      // If contracts are dynamic, we might need to recreate them here,
      // but for now we rely on the default factory in AddressMap or manual registration.
      const contract = this.contracts.get(addr);
      if (contract) {
        contract.restore(contractSnapshot);
      }
    }
  }
}
