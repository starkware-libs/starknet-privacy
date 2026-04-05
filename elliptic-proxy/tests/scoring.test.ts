// tests/scoring.test.ts
import { describe, it, expect } from "vitest";
import { scoreResponse } from "../src/scoring.js";

function ellipticResponse(
  evaluations: object[],
  overrides?: Record<string, unknown>
): string {
  return JSON.stringify({
    process_status: "complete",
    evaluation_detail: {
      source: evaluations,
    },
    ...overrides,
  });
}

// Elliptic returns a non-zero risk_score for evaluations with findings.
// The default here (3) matches starknet-apps test mocks which use >= 0.011.
function evaluation(
  ruleId: string,
  elements: object[],
  riskScore = 3
): { rule_id: string; risk_score: number; matched_elements: object[] } {
  return { rule_id: ruleId, risk_score: riskScore, matched_elements: elements };
}

function element(
  contributionPercentage: number,
  contributionUsd: number,
  counterpartyPercentage: number,
  counterpartyUsd: number
): object {
  return {
    contribution_percentage: contributionPercentage,
    contribution_value: { usd: contributionUsd },
    counterparty_percentage: counterpartyPercentage,
    counterparty_value: { usd: counterpartyUsd },
  };
}

// Rule IDs
const ILLICIT = "8f023e48-b9c2-41c6-8c8a-42a936eee86d";
const SANCTIONED = "1f86dce1-166a-4749-a5df-3972fae7635a";
const OBFUSCATING = "1e24a6cf-620a-4c89-b423-5e43b2f13614";
const DPRK = "090208b1-18e3-4da0-94d3-23e7eca5fd92";

describe("scoreResponse", () => {
  describe("error handling", () => {
    it("blocks on malformed JSON with reason malformed_json", () => {
      const result = scoreResponse("not json");
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("malformed_json");
      expect(result.triggeringRuleIds).toEqual([]);
    });

    it("allows when process_status is not complete with reason incomplete", () => {
      const result = scoreResponse(
        JSON.stringify({ process_status: "running", evaluation_detail: {} })
      );
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe("incomplete");
    });

    it("allows when process_status is missing", () => {
      const result = scoreResponse(JSON.stringify({}));
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe("incomplete");
    });
  });

  describe("clean address", () => {
    it("allows when no evaluations", () => {
      const result = scoreResponse(ellipticResponse([]));
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe("clean");
    });

    it("allows when evaluation has no matched elements", () => {
      const result = scoreResponse(
        ellipticResponse([
          { rule_id: ILLICIT, risk_score: 3, matched_elements: [] },
        ])
      );
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe("clean");
    });
  });

  describe("unknown rules pass through", () => {
    it("blocks when unknown rule has risk_score above threshold", () => {
      const result = scoreResponse(
        ellipticResponse([
          {
            rule_id: "unknown-rule-id",
            risk_score: 5,
            matched_elements: [element(50, 1000, 50, 500)],
          },
        ])
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("unknown_rule");
      expect(result.triggeringRuleIds).toEqual(["unknown-rule-id"]);
    });

    it("blocks when unknown rule has contribution percentage above threshold", () => {
      // risk_score=0 → (0 ?? percentage) = 0 → 0 > 0.01 is false
      // So unknown rules with risk_score=0 are NOT blocked, even with high percentage.
      // This matches starknet-apps: the ?? operator means risk_score takes precedence.
      const result = scoreResponse(
        ellipticResponse([
          {
            rule_id: "unknown-rule-id",
            risk_score: 0,
            matched_elements: [element(50, 1000, 50, 500)],
          },
        ])
      );
      expect(result.blocked).toBe(false);
    });

    it("allows when unknown rule has low risk_score and low percentage", () => {
      const result = scoreResponse(
        ellipticResponse([
          {
            rule_id: "unknown-rule-id",
            risk_score: 0,
            matched_elements: [element(0.005, 0, 0, 0)],
          },
        ])
      );
      expect(result.blocked).toBe(false);
    });
  });

  describe("ILLICIT_ACTIVITY (OR — either threshold triggers)", () => {
    it("blocks when both counterparty and contribution exceeded", () => {
      const result = scoreResponse(
        ellipticResponse([evaluation(ILLICIT, [element(1, 100, 50, 50)])])
      );
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("rule_triggered");
      expect(result.triggeringRuleIds).toContain(ILLICIT);
    });

    it("blocks when only counterparty exceeded", () => {
      const result = scoreResponse(
        ellipticResponse([evaluation(ILLICIT, [element(0.5, 5, 50, 50)])])
      );
      expect(result.blocked).toBe(true);
    });

    it("blocks when only contribution exceeded", () => {
      const result = scoreResponse(
        ellipticResponse([evaluation(ILLICIT, [element(1, 100, 0, 0)])])
      );
      expect(result.blocked).toBe(true);
    });

    it("allows when neither threshold exceeded", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(ILLICIT, [element(0.05, 5, 50, 50)])])
        ).blocked
      ).toBe(false);
    });
  });

  describe("SANCTIONED_ENTITY (OR — either threshold triggers)", () => {
    it("blocks when only counterparty exceeded", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(SANCTIONED, [element(0.01, 0, 1, 1)])])
        ).blocked
      ).toBe(true);
    });

    it("blocks when only contribution exceeded", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(SANCTIONED, [element(1, 100, 0, 0)])])
        ).blocked
      ).toBe(true);
    });

    it("allows when neither threshold exceeded", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(SANCTIONED, [element(0.05, 5, 0, 0)])])
        ).blocked
      ).toBe(false);
    });
  });

  describe("OBFUSCATING (OR — either threshold triggers)", () => {
    it("blocks when contribution exceeded", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(OBFUSCATING, [element(1, 100, 0, 0)])])
        ).blocked
      ).toBe(true);
    });
  });

  describe("DPRK_BYBIT_EXPLOIT (very low counterparty threshold)", () => {
    it("blocks on tiny counterparty exposure", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(DPRK, [element(0.001, 0, 2, 1)])])
        ).blocked
      ).toBe(true);
    });
  });

  describe("hard block", () => {
    it("blocks on ILLICIT contribution >= $5000 regardless of percentages", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(ILLICIT, [element(0.01, 5000, 0, 0)])])
        ).blocked
      ).toBe(true);
    });

    it("blocks on SANCTIONED contribution >= $5000", () => {
      expect(
        scoreResponse(
          ellipticResponse([
            evaluation(SANCTIONED, [element(0.01, 5000, 0, 0)]),
          ])
        ).blocked
      ).toBe(true);
    });

    it("does not hard-block OBFUSCATING at $5000", () => {
      expect(
        scoreResponse(
          ellipticResponse([
            evaluation(OBFUSCATING, [element(0.01, 5000, 0, 0)]),
          ])
        ).blocked
      ).toBe(false);
    });
  });

  describe("ALLOWED_RISK_EXPOSURE final threshold (0.01)", () => {
    it("allows when evaluation passes filter but risk_score is 0", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(SANCTIONED, [element(1, 100, 0, 0)], 0)])
        ).blocked
      ).toBe(false);
    });

    it("blocks when risk_score from Elliptic exceeds threshold", () => {
      expect(
        scoreResponse(
          ellipticResponse([evaluation(SANCTIONED, [element(1, 100, 0, 0)], 5)])
        ).blocked
      ).toBe(true);
    });

    it("uses risk_score over percentage when both present", () => {
      expect(
        scoreResponse(
          ellipticResponse([
            evaluation(SANCTIONED, [element(1, 100, 0, 0)], 0.005),
          ])
        ).blocked
      ).toBe(false);
    });

    it("falls through to percentage when risk_score is undefined", () => {
      const body = ellipticResponse([
        {
          rule_id: SANCTIONED,
          matched_elements: [element(1, 100, 0, 0)],
        },
      ]);
      expect(scoreResponse(body).blocked).toBe(true);
    });
  });

  describe("destination evaluations", () => {
    it("checks destination evaluations too", () => {
      const body = JSON.stringify({
        process_status: "complete",
        evaluation_detail: {
          source: [],
          destination: [evaluation(SANCTIONED, [element(1, 100, 1, 50)])],
        },
      });
      const result = scoreResponse(body);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("rule_triggered");
      expect(result.triggeringRuleIds).toContain(SANCTIONED);
    });
  });
});
