/**
 * Mock ERC20 token implementation for testing.
 */

import type { Amount, StarknetAddress } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { assert } from "console";

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
}

export class ERC20s {
  private erc20s = new AddressMap<ERC20>((address) => new ERC20(address));

  get(address: StarknetAddress): ERC20 {
    return this.erc20s.get(address)!;
  }
}
