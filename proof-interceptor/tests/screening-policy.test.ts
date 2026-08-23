// tests/screening-policy.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { silenceErrorLog } from "./pool-call.js";
import {
  DEFAULT_POLICY_TIMEOUT_MS,
  DEFAULT_POLICY_TTL_MS,
  MAX_CACHED_POLICIES,
  OpenNoteScreeningPolicyClient,
  type OpenNoteScreeningPolicy,
} from "../src/screening-policy.js";

const POOL_ADDR = "0x9001";
const DEPOSITOR = "0xa11ce";
// keccak("get_open_note_screening_policy"), masked to a selector. Committed here so a typo in the
// entrypoint name the client asks for fails this test instead of every policy read in production.
const GET_POLICY_SELECTOR =
  "0x19ffd9b0ff9d97560bf4426e5a7682651f5f7a4210dab7771376b52e6720e";

const POLICIES: OpenNoteScreeningPolicy[] = ["Required", "Exempt", "Delegated"];

/**
 * What a node answers when the called contract has no such entrypoint: dedicated JSON-RPC error 21
 * (`ENTRYPOINT_NOT_FOUND`), distinct from 20 (no contract) and 40 (a revert). A pool answering it
 * predates the policy list.
 */
const ENTRYPOINT_NOT_FOUND_ANSWER: RpcAnswer = {
  body: {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: 21,
      message: "Requested entrypoint does not exist in the contract",
    },
  },
};

/** What the fake node does with one `starknet_call`: answer a body, an HTTP status, or nothing. */
type RpcAnswer = { body: unknown } | { status: number } | "no answer";

/** The answer to the `requestNumber`-th call the fake node receives, counting from 1. */
type RpcResponder = (requestNumber: number) => RpcAnswer;

let rpcServer: Server;
let rpcUrl: string;
let requests: unknown[];
let respond: RpcResponder;

/** A `starknet_call` result carrying `policy`, serialized as the pool's enum is: its variant index. */
function policyAnswer(policy: OpenNoteScreeningPolicy): RpcAnswer {
  const index = POLICIES.indexOf(policy);
  return {
    body: { jsonrpc: "2.0", id: 1, result: ["0x" + index.toString(16)] },
  };
}

beforeEach(async () => {
  requests = [];
  respond = () => policyAnswer("Exempt");
  rpcServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const answer = respond(requests.length);
      if (answer === "no answer") return;
      if ("status" in answer) {
        response.writeHead(answer.status);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => rpcServer.listen(0, resolve));
  rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve, reject) =>
    rpcServer.close((error) => (error ? reject(error) : resolve()))
  );
});

function newClient(
  overrides: { ttlMs?: number; timeoutMs?: number } = {}
): OpenNoteScreeningPolicyClient {
  return new OpenNoteScreeningPolicyClient({
    rpcUrl,
    poolAddress: POOL_ADDR,
    ttlMs: DEFAULT_POLICY_TTL_MS,
    timeoutMs: DEFAULT_POLICY_TIMEOUT_MS,
    ...overrides,
  });
}

const OVERFLOW_DEPOSITOR = "0xfffffff";
/** These tests run on the client's own default TTL, so the advances below are relative to it. */
const TTL_MS = DEFAULT_POLICY_TTL_MS;

/** Caches one policy per slot, leaving the cache full and "0x1" its least recently used entry. */
async function fillCache(client: OpenNoteScreeningPolicyClient): Promise<void> {
  for (let entry = 1; entry <= MAX_CACHED_POLICIES; entry++) {
    await client.getPolicy("0x" + entry.toString(16));
  }
}

/**
 * Starts a test on a clock it can move. The cache ages entries by `Date.now()`, so faking time
 * expires them without waiting; the local HTTP the client talks to is I/O, and runs regardless.
 */
function useMovableClock(): void {
  vi.useFakeTimers({ now: Date.now() });
}

/** Silences the line a pre-policy-pool read logs, and returns the spy to assert on. */
function silencePolicyLog(): ReturnType<
  typeof vi.spyOn<typeof console, "log">
> {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("OpenNoteScreeningPolicyClient", () => {
  it("resolves every policy the pool can answer with", async () => {
    for (const policy of POLICIES) {
      respond = () => policyAnswer(policy);
      // A fresh client per policy: one client would answer the second one from its cache.
      expect(await newClient().getPolicy(DEPOSITOR)).toBe(policy);
    }
  });

  it("asks the pool for the depositor's policy at the latest block", async () => {
    await newClient().getPolicy(DEPOSITOR);

    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        // starknet.js numbers its own requests.
        id: expect.any(Number),
        method: "starknet_call",
        params: {
          request: {
            contract_address: POOL_ADDR,
            entry_point_selector: GET_POLICY_SELECTOR,
            calldata: [DEPOSITOR],
          },
          block_id: "latest",
        },
      },
    ]);
  });

  it("declares exactly the policies the pool ABI does", () => {
    // The union is hand-written while the decode reads the ABI, so they are pinned to each other
    // here; `scripts/check_screening_policies.py` pins both to the Cairo enum that owns the list.
    const abi = PrivacyPoolABI as readonly {
      type: string;
      name?: string;
      variants?: readonly { name: string; type: string }[];
    }[];
    const policyEnum = abi.find(
      (item) =>
        item.type === "enum" &&
        item.name === "privacy::objects::OpenNoteScreeningPolicy"
    );

    expect(policyEnum?.variants?.map((variant) => variant.name)).toEqual(
      POLICIES
    );
    // None of them carries data, which is why one felt is the whole answer.
    expect(policyEnum?.variants?.map((variant) => variant.type)).toEqual([
      "()",
      "()",
      "()",
    ]);
  });

  it("keys the cache by the normalized address", async () => {
    const client = newClient();
    expect(await client.getPolicy("0x0000a11ce")).toBe("Exempt");
    expect(await client.getPolicy("0xA11CE")).toBe("Exempt");

    expect(requests).toHaveLength(1);
  });

  it("reads a policy once per depositor within the TTL", async () => {
    const client = newClient();
    await client.getPolicy(DEPOSITOR);
    await client.getPolicy(DEPOSITOR);
    await client.getPolicy("0xb0b");

    expect(requests).toHaveLength(2);
  });

  it("reads again once the TTL expires, so a policy change propagates", async () => {
    useMovableClock();
    respond = (requestNumber) =>
      policyAnswer(requestNumber === 1 ? "Exempt" : "Required");
    const client = newClient();
    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");

    await vi.advanceTimersByTimeAsync(TTL_MS + 1);

    expect(await client.getPolicy(DEPOSITOR)).toBe("Required");
    expect(requests).toHaveLength(2);
  });

  it("holds a policy for the whole TTL, not a moment less", async () => {
    useMovableClock();
    respond = (requestNumber) =>
      policyAnswer(requestNumber === 1 ? "Exempt" : "Required");
    const client = newClient();
    await client.getPolicy(DEPOSITOR);

    await vi.advanceTimersByTimeAsync(TTL_MS - 1);

    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");
    expect(requests).toHaveLength(1);
  });

  it("evicts the least recently used policy once the cache is full", async () => {
    const client = newClient();
    await fillCache(client);
    // One depositor more than the cache holds, so the least recently used entry is evicted.
    await client.getPolicy(OVERFLOW_DEPOSITOR);
    const readsBeforeEviction = requests.length;

    await client.getPolicy("0x1");
    await client.getPolicy(OVERFLOW_DEPOSITOR);

    expect(requests).toHaveLength(readsBeforeEviction + 1);
  });

  it("keeps a policy that keeps being read over one that stopped being read", async () => {
    // What least-recently-used buys over evicting in insertion order: a flood of transactions to
    // distinct targets costs re-reads of itself, not of the few targets real deposits go through.
    const client = newClient();
    await fillCache(client);
    await client.getPolicy("0x1");
    await client.getPolicy(OVERFLOW_DEPOSITOR);
    const readsBeforeEviction = requests.length;

    // "0x1" was read last of the filled entries, so "0x2" is the one that went.
    await client.getPolicy("0x1");
    expect(requests).toHaveLength(readsBeforeEviction);
    await client.getPolicy("0x2");
    expect(requests).toHaveLength(readsBeforeEviction + 1);
  });

  it("issues one read for concurrent calls on the same depositor", async () => {
    const client = newClient();

    const policies = await Promise.all(
      Array.from({ length: 10 }, () => client.getPolicy(DEPOSITOR))
    );

    expect(policies).toEqual(Array(10).fill("Exempt"));
    expect(requests).toHaveLength(1);
  });

  it("keeps concurrent reads for different depositors apart", async () => {
    respond = (requestNumber) =>
      policyAnswer(requestNumber === 1 ? "Exempt" : "Delegated");
    const client = newClient();

    const [first, second] = await Promise.all([
      client.getPolicy(DEPOSITOR),
      client.getPolicy("0xb0b"),
    ]);

    // Coalescing is per address: sharing one read across addresses would answer both the same.
    expect([first, second]).toEqual(["Exempt", "Delegated"]);
    expect(requests).toHaveLength(2);
  });

  it("reads again after a shared read fails, rather than reusing the failure", async () => {
    const errorSpy = silenceErrorLog();
    respond = (requestNumber) =>
      requestNumber === 1 ? { status: 503 } : policyAnswer("Required");
    const client = newClient();

    const failed = await Promise.all([
      client.getPolicy(DEPOSITOR),
      client.getPolicy(DEPOSITOR),
    ]);
    expect(failed).toEqual([null, null]);
    expect(requests).toHaveLength(1);

    // The in-flight entry is cleared when the read settles, failure included, so the next caller
    // starts a new one instead of awaiting a promise that already resolved to null.
    expect(await client.getPolicy(DEPOSITOR)).toBe("Required");
    expect(requests).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it("answers Exempt for every depositor of a pool without the policy entrypoint", async () => {
    const errorSpy = silenceErrorLog();
    const logSpy = silencePolicyLog();
    respond = () => ENTRYPOINT_NOT_FOUND_ANSWER;
    const client = newClient();

    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");
    expect(await client.getPolicy("0xb0b")).toBe("Exempt");
    // A missing entrypoint is an answer, not a failure: nothing goes to the error log.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("caches the missing-entrypoint answer like a policy", async () => {
    const logSpy = silencePolicyLog();
    respond = () => ENTRYPOINT_NOT_FOUND_ANSWER;
    const client = newClient();

    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");
    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");
    expect(requests).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("keeps the depositor out of the pre-policy-pool log", async () => {
    const logSpy = silencePolicyLog();
    respond = () => ENTRYPOINT_NOT_FOUND_ANSWER;

    await newClient().getPolicy(DEPOSITOR);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = String(logSpy.mock.calls[0][0]);
    expect(logged).toContain("pre_policy_pool");
    expect(logged).not.toContain("a11ce");
    logSpy.mockRestore();
  });

  it("honors a pool upgrade that adds the policy entrypoint within one TTL", async () => {
    const logSpy = silencePolicyLog();
    useMovableClock();
    respond = (requestNumber) =>
      requestNumber === 1
        ? ENTRYPOINT_NOT_FOUND_ANSWER
        : policyAnswer("Required");
    const client = newClient();
    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");

    await vi.advanceTimersByTimeAsync(TTL_MS + 1);

    expect(await client.getPolicy(DEPOSITOR)).toBe("Required");
    expect(requests).toHaveLength(2);
    logSpy.mockRestore();
  });

  it("fails closed when no contract answers at the pool address", async () => {
    // Only the entrypoint miss reads as a pre-policy pool. An undeployed address is a
    // misconfiguration, not an old pool, and stays a failed read.
    const errorSpy = silenceErrorLog();
    respond = () => ({
      body: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 20, message: "Contract not found" },
      },
    });

    expect(await newClient().getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("returns null on an RPC error response", async () => {
    const errorSpy = silenceErrorLog();
    respond = () => ({
      body: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 40, message: "Contract error" },
      },
    });

    expect(await newClient().getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("returns null on a non-2xx response", async () => {
    const errorSpy = silenceErrorLog();
    respond = () => ({ status: 503 });

    expect(await newClient().getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("returns null for a variant index the pool's enum does not have", async () => {
    const errorSpy = silenceErrorLog();
    respond = () => ({ body: { jsonrpc: "2.0", id: 1, result: ["0x7"] } });

    expect(await newClient().getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("returns null for a result that is not one felt of policy", async () => {
    const errorSpy = silenceErrorLog();
    for (const result of [[], ["0x1", "0x1"], "Exempt", [1], null]) {
      respond = () => ({ body: { jsonrpc: "2.0", id: 1, result } });
      expect(await newClient().getPolicy(DEPOSITOR)).toBeNull();
    }
    errorSpy.mockRestore();
  });

  it("returns null when the RPC does not answer within the timeout", async () => {
    const errorSpy = silenceErrorLog();
    respond = () => "no answer";

    expect(await newClient({ timeoutMs: 50 }).getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("does not cache a failed read", async () => {
    const errorSpy = silenceErrorLog();
    respond = (requestNumber) =>
      requestNumber === 1 ? { status: 503 } : policyAnswer("Delegated");
    const client = newClient();

    expect(await client.getPolicy(DEPOSITOR)).toBeNull();
    expect(await client.getPolicy(DEPOSITOR)).toBe("Delegated");
    errorSpy.mockRestore();
  });

  it("reports a policy it can no longer read as unresolvable, not as its last value", async () => {
    const errorSpy = silenceErrorLog();
    useMovableClock();
    respond = (requestNumber) =>
      requestNumber === 1 ? policyAnswer("Exempt") : { status: 503 };
    const client = newClient();
    expect(await client.getPolicy(DEPOSITOR)).toBe("Exempt");

    await vi.advanceTimersByTimeAsync(TTL_MS + 1);

    expect(await client.getPolicy(DEPOSITOR)).toBeNull();
    errorSpy.mockRestore();
  });

  it("keeps the depositor out of the log when a read fails", async () => {
    const errorSpy = silenceErrorLog();
    respond = () => ({ status: 503 });

    await newClient().getPolicy(DEPOSITOR);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain("screening_policy_unavailable");
    expect(logged).not.toContain("a11ce");
    errorSpy.mockRestore();
  });
});
