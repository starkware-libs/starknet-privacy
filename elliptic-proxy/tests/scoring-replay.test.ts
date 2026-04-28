// tests/scoring-replay.test.ts
//
// Replays recorded Elliptic responses through scoreResponse() and snapshots
// the results. If scoring logic changes, the snapshot breaks, forcing a
// deliberate review of every affected address.
//
// Usage:
//   ELLIPTIC_RESPONSES=/path/to/responses.json npm test -- scoring-replay
//
// The JSON file must be an array of raw Elliptic wallet_exposure responses,
// each containing at least: subject.hash, process_status, evaluation_detail.

import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { scoreResponse } from "../src/scoring.js";

interface EllipticRecord {
  subject: { hash: string };
  [key: string]: unknown;
}

const RESPONSES_PATH = process.env.ELLIPTIC_RESPONSES;

const records: EllipticRecord[] =
  RESPONSES_PATH && existsSync(RESPONSES_PATH)
    ? JSON.parse(readFileSync(RESPONSES_PATH, "utf-8"))
    : [];

describe.runIf(records.length > 0)(`scoring replay (${RESPONSES_PATH})`, () => {
  it("scores every record without throwing", () => {
    for (const record of records) {
      expect(() => scoreResponse(JSON.stringify(record))).not.toThrow();
    }
  });

  it("snapshot: scoring results for all addresses", () => {
    const results = records.map((record) => {
      const result = scoreResponse(JSON.stringify(record));
      return {
        address: record.subject.hash,
        blocked: result.blocked,
        reason: result.reason,
        triggeringRuleIds: result.triggeringRuleIds,
      };
    });

    expect(results).toMatchSnapshot();
  });

  it("summary: blocked vs allowed counts", () => {
    let blockedCount = 0;
    let allowedCount = 0;
    const blockedAddresses: string[] = [];

    for (const record of records) {
      const result = scoreResponse(JSON.stringify(record));
      if (result.blocked) {
        blockedCount++;
        blockedAddresses.push(record.subject.hash);
      } else {
        allowedCount++;
      }
    }

    // Log summary for manual review
    console.log(
      `Replay summary: ${records.length} records, ${blockedCount} blocked, ${allowedCount} allowed`
    );
    if (blockedAddresses.length > 0) {
      console.log(`Blocked addresses:\n  ${blockedAddresses.join("\n  ")}`);
    }

    // Sanity: counts must add up
    expect(blockedCount + allowedCount).toBe(records.length);

    // Snapshot the counts so changes to scoring logic are visible
    expect({ blockedCount, allowedCount }).toMatchSnapshot();
  });
});
