// src/scoring.ts
//
// Rule-based scoring for Elliptic wallet exposure responses.
//
// Logic mirrors starknet-apps screening exactly:
//   starknet-apps/workspace/apps/starkgate/apps/screening/
//     src/services/risk-scanner/adapters/elliptic/consts.ts          (thresholds)
//     src/services/risk-scanner/adapters/elliptic/rulesMapAndFilter.ts (aggregation)
//     src/domain/risk-management/block-address.ts                    (block decision)

interface MatchedElement {
  contribution_percentage: number;
  contribution_value: { usd?: number };
  counterparty_percentage?: number;
  counterparty_value?: { usd?: number };
}

interface Evaluation {
  rule_id: string;
  risk_score?: number;
  matched_elements?: MatchedElement[];
}

interface EllipticResponse {
  process_status: string;
  evaluation_detail?: {
    source?: Evaluation[];
    destination?: Evaluation[];
  };
}

interface RuleThresholds {
  counterpartyPercentage: number;
  counterpartyUsd: number;
  contributionPercentage: number;
  contributionUsd: number;
  hardBlockUsd?: number;
}

const SEVERE_RULES_HARD_BLOCK_USD = 500;
const HARD_BLOCK_RISK_SCORE = 10;

const ILLICIT_ACTIVITY: RuleThresholds = {
  counterpartyPercentage: 0.1,
  counterpartyUsd: 0,
  contributionPercentage: 0.1,
  contributionUsd: 250,
  hardBlockUsd: 5000,
};

const SANCTIONED_ENTITY: RuleThresholds = {
  counterpartyPercentage: 0,
  counterpartyUsd: 0,
  contributionPercentage: 0.1,
  contributionUsd: 100,
  hardBlockUsd: SEVERE_RULES_HARD_BLOCK_USD,
};

const OBFUSCATING: RuleThresholds = {
  counterpartyPercentage: 0.1,
  counterpartyUsd: 0,
  contributionPercentage: 0.1,
  contributionUsd: 250,
};

const DPRK_BYBIT_EXPLOIT: RuleThresholds = {
  counterpartyPercentage: 0.00001,
  counterpartyUsd: 0,
  contributionPercentage: 0.1,
  contributionUsd: 100,
  hardBlockUsd: SEVERE_RULES_HARD_BLOCK_USD,
};

const TERRORISM: RuleThresholds = {
  counterpartyPercentage: 0,
  counterpartyUsd: 0,
  contributionPercentage: 0.1,
  contributionUsd: 10,
  hardBlockUsd: SEVERE_RULES_HARD_BLOCK_USD,
};

// Rule IDs from Elliptic, matching starknet-apps screening config
const RULES: Record<string, RuleThresholds> = {
  "ea184575-0abc-4047-a554-e647c33b0691": ILLICIT_ACTIVITY,
  "8dfb1940-b138-4cd6-af80-a574d7c1109c": SANCTIONED_ENTITY,
  "bc2541f9-cafa-43ba-bddc-427b19e46dfe": OBFUSCATING,
  "09698cee-bfa9-4bea-a8a0-b10fdf06eb7b": DPRK_BYBIT_EXPLOIT,
  "32537f83-50d7-43ee-a916-4e85301e0949": TERRORISM,
  // Rule IDs of the Elliptic ruleset that was replaced on 2026-10-14. They still show up in
  // some Elliptic responses, and unknown rules are never filtered, so keep them mapped
  "8f023e48-b9c2-41c6-8c8a-42a936eee86d": ILLICIT_ACTIVITY,
  "238fe69b-341f-4324-9c05-3cf9d2aa13d4": ILLICIT_ACTIVITY,
  "1f86dce1-166a-4749-a5df-3972fae7635a": SANCTIONED_ENTITY,
  "1e24a6cf-620a-4c89-b423-5e43b2f13614": OBFUSCATING,
  "090208b1-18e3-4da0-94d3-23e7eca5fd92": DPRK_BYBIT_EXPLOIT,
};

// Matches APP_ALLOWED_RISK_EXPOSURE default in starknet-apps
const ALLOWED_RISK_EXPOSURE = 0.01;

export interface ScoringResult {
  blocked: boolean;
  /** Why the decision was made */
  reason:
    | "clean"
    | "malformed_json"
    | "incomplete"
    | "rule_triggered"
    | "unknown_rule";
  /** Rule IDs that contributed to the block decision (empty if not blocked) */
  triggeringRuleIds: string[];
}

/**
 * Scores an Elliptic wallet exposure response. Returns a ScoringResult
 * indicating whether the address should be blocked, why, and which rules fired.
 *
 * Replicates the exact decision path of starknet-apps:
 *   1. Parse & aggregate matched_elements per evaluation
 *   2. Override risk_score to 10 for any rule whose hard block is reached
 *   3. Filter evaluations by rule thresholds (contribution OR counterparty)
 *      — unknown rule_ids pass through (starknet-apps returns true for those)
 *   4. Build trigger: percentage = totalContributionPercentage,
 *      riskScore = evaluation.risk_score
 *   5. Block if any trigger has (riskScore ?? percentage) > ALLOWED_RISK_EXPOSURE
 */
export function scoreResponse(ellipticBody: string): ScoringResult {
  let response: EllipticResponse;
  try {
    response = JSON.parse(ellipticBody);
  } catch {
    return { blocked: true, reason: "malformed_json", triggeringRuleIds: [] };
  }

  // starknet-apps returns null (not blocked) when process_status !== 'complete'
  if (response.process_status !== "complete") {
    return { blocked: false, reason: "incomplete", triggeringRuleIds: [] };
  }

  const sourceEvaluations = response.evaluation_detail?.source ?? [];
  const destinationEvaluations = response.evaluation_detail?.destination ?? [];

  // Source and destination are filtered independently, then triggers are merged
  const sourceTriggers = filterAndBuildTriggers(sourceEvaluations);
  const destinationTriggers = filterAndBuildTriggers(destinationEvaluations);
  const triggers = [...sourceTriggers, ...destinationTriggers];

  // Block if any trigger exceeds ALLOWED_RISK_EXPOSURE
  const firedTriggers = triggers.filter(
    (trigger) =>
      (trigger.riskScore ?? trigger.percentage) > ALLOWED_RISK_EXPOSURE
  );

  if (firedTriggers.length === 0) {
    return { blocked: false, reason: "clean", triggeringRuleIds: [] };
  }

  const triggeringRuleIds = [
    ...new Set(firedTriggers.map((trigger) => trigger.ruleId)),
  ];
  const hasUnknownRule = triggeringRuleIds.some((id) => !(id in RULES));
  return {
    blocked: true,
    reason: hasUnknownRule ? "unknown_rule" : "rule_triggered",
    triggeringRuleIds,
  };
}

interface Trigger {
  ruleId: string;
  percentage: number;
  riskScore?: number;
}

function filterAndBuildTriggers(evaluations: Evaluation[]): Trigger[] {
  const triggers: Trigger[] = [];

  for (const evaluation of evaluations) {
    const aggregated = aggregateElements(evaluation.matched_elements ?? []);

    let riskScore = evaluation.risk_score;
    const rule = RULES[evaluation.rule_id];
    if (
      rule?.hardBlockUsd != null &&
      aggregated.contributionUsd >= rule.hardBlockUsd
    ) {
      riskScore = HARD_BLOCK_RISK_SCORE;
    }

    // Filter: known rules checked against thresholds, unknown rules pass through
    if (rule) {
      if (!shouldFilter(aggregated, rule)) continue;
    }

    triggers.push({
      ruleId: evaluation.rule_id,
      percentage: aggregated.contributionPercentage,
      riskScore,
    });
  }

  return triggers;
}

interface Aggregated {
  counterpartyPercentage: number;
  counterpartyUsd: number;
  contributionPercentage: number;
  contributionUsd: number;
}

/**
 * Returns true if the evaluation should be included (passes thresholds).
 * Matches shouldFilterBySpecialRule in starknet-apps:
 *   shouldFilterByContribution(...) || shouldFilterByCounterparty(...)
 */
function shouldFilter(aggregated: Aggregated, rule: RuleThresholds): boolean {
  // shouldFilterByContribution: hard block check first
  if (
    rule.hardBlockUsd != null &&
    aggregated.contributionUsd >= rule.hardBlockUsd
  ) {
    return true;
  }

  // shouldFilterByContribution: normal threshold
  const contributionExceeded =
    aggregated.contributionUsd > rule.contributionUsd &&
    aggregated.contributionPercentage > rule.contributionPercentage;

  // shouldFilterByCounterparty
  const counterpartyExceeded =
    aggregated.counterpartyUsd > rule.counterpartyUsd &&
    aggregated.counterpartyPercentage > rule.counterpartyPercentage;

  return contributionExceeded || counterpartyExceeded;
}

/**
 * Aggregates matched elements into totals for threshold comparison.
 * Matches parseEvaluation in starknet-apps.
 */
function aggregateElements(elements: MatchedElement[]): Aggregated {
  let counterpartyPercentage = 0;
  let counterpartyUsd = 0;
  let contributionPercentage = 0;
  let contributionUsd = 0;

  for (const element of elements) {
    counterpartyPercentage +=
      (element.contribution_percentage / 100) *
      (element.counterparty_percentage ?? 0);
    counterpartyUsd += element.counterparty_value?.usd ?? 0;
    contributionPercentage += element.contribution_percentage;
    contributionUsd += element.contribution_value?.usd ?? 0;
  }

  return {
    counterpartyPercentage,
    counterpartyUsd,
    contributionPercentage,
    contributionUsd,
  };
}
