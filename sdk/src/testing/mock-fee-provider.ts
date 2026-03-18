/**
 * MockFeeProvider — Deterministic FeeProviderInterface for unit/integration tests.
 * No network, no caching — returns the schedule provided at construction.
 */

import type { FeeProviderInterface, FeeSchedule, StarknetAddress } from "../interfaces.js";

type GetFeeQuoteCall = { method: "getFeeQuote"; token: StarknetAddress };

export class MockFeeProvider implements FeeProviderInterface {
  readonly calls: GetFeeQuoteCall[] = [];

  constructor(private schedule: FeeSchedule) {}

  async getFeeQuote(token: StarknetAddress): Promise<FeeSchedule> {
    this.calls.push({ method: "getFeeQuote", token });
    return this.schedule;
  }
}
