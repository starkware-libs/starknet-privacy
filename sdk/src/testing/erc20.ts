/**
 * Mock ERC20 token implementation for testing.
 */

import type { Amount, StarknetAddress } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { assert } from "../utils/validation.js";

/** Snapshot of an ERC20's balance state */
export type ERC20Snapshot = Map<bigint, Amount>;

/** Snapshot of all ERC20 tokens' state */
export type ERC20sSnapshot = Map<bigint, ERC20Snapshot>;

export class ERC20 {
  private balances = new AddressMap<Amount>(() => 0n);
  constructor(public address: StarknetAddress) {}

  transfer(from: StarknetAddress, to: StarknetAddress, amount: Amount): void {
    assert(this.balances.get(from)! >= amount, `Insufficient balance`);
    this.balances.set(from, this.balances.get(from)! - amount);
    this.balances.set(to, this.balances.get(to)! + amount);
  }

  balanceOf(address: StarknetAddress): Amount {
    return this.balances.get(address)!;
  }

  setBalance(address: StarknetAddress, amount: Amount): void {
    this.balances.set(address, amount);
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

export class ERC20s {
  private erc20s = new AddressMap<ERC20>((address) => new ERC20(address));

  get(address: StarknetAddress): ERC20 {
    return this.erc20s.get(address)!;
  }

  /** Create a snapshot of all ERC20 tokens' state */
  snapshot(): ERC20sSnapshot {
    const result = new Map<bigint, ERC20Snapshot>();
    for (const [addr, erc20] of this.erc20s.entries()) {
      result.set(addr, erc20.snapshot());
    }
    return result;
  }

  /** Restore all ERC20 tokens' state from a snapshot */
  restore(snapshot: ERC20sSnapshot): void {
    for (const [addr, erc20Snapshot] of snapshot) {
      this.erc20s.get(addr)!.restore(erc20Snapshot);
    }
  }
}
