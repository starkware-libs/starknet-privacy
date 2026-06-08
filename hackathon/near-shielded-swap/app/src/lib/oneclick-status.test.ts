import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  OneClickService,
  GetExecutionStatusResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import {
  fetchExecutionStatus,
  isRefund,
  isSettling,
  isTerminal,
  startStatusPoller,
  type FetchStatusResult,
} from "./oneclick-status";

// Status enum aliases — used to keep the assertion table tight.
const S = GetExecutionStatusResponse.status;

describe("status classifiers", () => {
  it("treats SUCCESS / REFUNDED / FAILED as terminal", () => {
    expect(isTerminal(S.SUCCESS)).toBe(true);
    expect(isTerminal(S.REFUNDED)).toBe(true);
    expect(isTerminal(S.FAILED)).toBe(true);
  });

  it("treats in-flight states as non-terminal", () => {
    expect(isTerminal(S.KNOWN_DEPOSIT_TX)).toBe(false);
    expect(isTerminal(S.PENDING_DEPOSIT)).toBe(false);
    expect(isTerminal(S.INCOMPLETE_DEPOSIT)).toBe(false);
    expect(isTerminal(S.PROCESSING)).toBe(false);
  });

  it("isRefund only matches REFUNDED and FAILED", () => {
    expect(isRefund(S.REFUNDED)).toBe(true);
    expect(isRefund(S.FAILED)).toBe(true);
    expect(isRefund(S.SUCCESS)).toBe(false);
    expect(isRefund(S.PROCESSING)).toBe(false);
  });

  it("isSettling matches the four mid-flight statuses", () => {
    expect(isSettling(S.KNOWN_DEPOSIT_TX)).toBe(true);
    expect(isSettling(S.PENDING_DEPOSIT)).toBe(true);
    expect(isSettling(S.INCOMPLETE_DEPOSIT)).toBe(true);
    expect(isSettling(S.PROCESSING)).toBe(true);
    expect(isSettling(S.SUCCESS)).toBe(false);
    expect(isSettling(S.REFUNDED)).toBe(false);
  });
});

describe("fetchExecutionStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to OneClickService.getExecutionStatus and surfaces the status", async () => {
    // CancelablePromise — caller awaits it directly, no need to mock the
    // cancel() method for this happy path.
    const fakeResponse = {
      correlationId: "test-corr",
      status: S.PROCESSING,
      updatedAt: "2024-01-01T00:00:00Z",
      quoteResponse: {} as never,
      swapDetails: {} as never,
    };
    const spy = vi
      .spyOn(OneClickService, "getExecutionStatus")
      .mockReturnValue(Promise.resolve(fakeResponse) as never);

    const result = await fetchExecutionStatus("0xdeadbeef");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("0xdeadbeef");
    expect(result.status).toBe(S.PROCESSING);
    expect(result.raw).toBe(fakeResponse);
  });

  it("propagates errors from the SDK without wrapping", async () => {
    vi.spyOn(OneClickService, "getExecutionStatus").mockReturnValue(
      Promise.reject(new Error("network down")) as never,
    );
    await expect(fetchExecutionStatus("0xfeed")).rejects.toThrow(
      "network down",
    );
  });
});

describe("startStatusPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Returns a fetcher that hands out the next sequence value on each call.
  // The poller's `tick` is async so we need to flush microtasks between
  // timer advances; helper below does that.
  function sequencedFetcher(sequence: readonly FetchStatusResult[]) {
    let i = 0;
    return vi.fn(async () => {
      const value = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      if (!value) throw new Error("sequence exhausted");
      return value;
    });
  }

  // Drain a single poll tick: advance the timer and flush microtasks until
  // the fetcher's promise has settled.
  async function pumpTick(intervalMs: number) {
    await vi.advanceTimersByTimeAsync(intervalMs);
  }

  it("polls on the interval until a terminal status arrives and then stops", async () => {
    const fetcher = sequencedFetcher([
      { status: S.PROCESSING, raw: {} as never },
      { status: S.PROCESSING, raw: {} as never },
      { status: S.SUCCESS, raw: {} as never },
    ]);
    const statuses: GetExecutionStatusResponse.status[] = [];
    let settled: GetExecutionStatusResponse.status | null = null;

    const handle = startStatusPoller(
      "0xabc",
      1_000,
      {
        onStatus: (s) => statuses.push(s),
        onError: () => {},
        onSettled: (s) => {
          settled = s;
        },
      },
      fetcher,
    );

    // Flush the immediate first call (kicked off synchronously inside
    // startStatusPoller, but resolves on the microtask queue).
    await vi.advanceTimersByTimeAsync(0);
    await pumpTick(1_000);
    await pumpTick(1_000);

    expect(statuses).toEqual([S.PROCESSING, S.PROCESSING, S.SUCCESS]);
    expect(settled).toBe(S.SUCCESS);

    // Once settled, the poller cancels its own interval — further timer
    // advances must not invoke the fetcher again.
    const callsAtSettlement = fetcher.mock.calls.length;
    await pumpTick(5_000);
    expect(fetcher.mock.calls.length).toBe(callsAtSettlement);

    handle.cancel();
  });

  it("surfaces transient errors but keeps polling", async () => {
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("flaky network");
      return { status: S.PROCESSING, raw: {} as never };
    });
    const statuses: GetExecutionStatusResponse.status[] = [];
    let lastError: string | null = null;

    const handle = startStatusPoller(
      "0xabc",
      500,
      {
        onStatus: (s) => statuses.push(s),
        onError: (m) => {
          lastError = m;
        },
        onSettled: () => {},
      },
      fetcher,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(lastError).toBe("flaky network");
    expect(statuses).toEqual([]);

    await pumpTick(500);
    expect(statuses).toEqual([S.PROCESSING]);

    handle.cancel();
  });

  it("recognises REFUNDED as terminal", async () => {
    const fetcher = sequencedFetcher([
      { status: S.REFUNDED, raw: {} as never },
    ]);
    let settled: GetExecutionStatusResponse.status | null = null;
    const handle = startStatusPoller(
      "0xabc",
      1_000,
      {
        onStatus: () => {},
        onError: () => {},
        onSettled: (s) => {
          settled = s;
        },
      },
      fetcher,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(S.REFUNDED);
    handle.cancel();
  });

  it("cancel() stops scheduled callbacks", async () => {
    const fetcher = sequencedFetcher([
      { status: S.PROCESSING, raw: {} as never },
      { status: S.PROCESSING, raw: {} as never },
    ]);
    const handle = startStatusPoller(
      "0xabc",
      1_000,
      {
        onStatus: () => {},
        onError: () => {},
        onSettled: () => {},
      },
      fetcher,
    );
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeCancel = fetcher.mock.calls.length;
    handle.cancel();
    await pumpTick(5_000);
    expect(fetcher.mock.calls.length).toBe(callsBeforeCancel);
  });
});
