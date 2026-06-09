import type { WorkflowInstance } from "../types";

export type AmbiguityGateStrictness = "advisory" | "standard" | "strict";

export type AmbiguityGatePolicy = {
  strictness: AmbiguityGateStrictness;
  reason: string;
  requiresPlan: boolean;
  blocksDpaaFail: boolean;
  blocksSbadrFail: boolean;
};

const STRICT_PATTERNS = [
  /\b(api|endpoint|contract|schema|migration|database|db|auth|security|permission|role|payment|billing|money|delete|destructive|privacy|pii|token|secret|credential|docker|ci|deploy|release)\b/i,
  /\bbreaking\s+change\b/i,
  /\bdata\s+(loss|deletion|migration)\b/i,
];

const ADVISORY_PATTERNS = [
  /\b(spike|explore|investigate|research|analy[sz]e|check|inspect|review\s+only)\b/i,
  /\b(docs?|readme|comment|typo|copy|text|wording|style|cosmetic|theme|color|spacing|formatting)\b/i,
  /\b(small|minor|tiny|quick|simple)\b/i,
];

export function classifyAmbiguityGatePolicy(workflow: WorkflowInstance, planText = ""): AmbiguityGatePolicy {
  const titleSource = workflow.title;
  const strictSource = `${workflow.title}\n${planText}`;
  if (STRICT_PATTERNS.some((pattern) => pattern.test(strictSource))) {
    return {
      strictness: "strict",
      reason: "High-risk/API/schema/security/data/deployment keyword detected.",
      requiresPlan: true,
      blocksDpaaFail: true,
      blocksSbadrFail: true,
    };
  }

  if (ADVISORY_PATTERNS.some((pattern) => pattern.test(titleSource))) {
    return {
      strictness: "advisory",
      reason: "Low-risk, documentation/cosmetic, or discovery-oriented keyword detected.",
      requiresPlan: false,
      blocksDpaaFail: false,
      blocksSbadrFail: false,
    };
  }

  return {
    strictness: "standard",
    reason: "Default feature/workflow ambiguity policy.",
    requiresPlan: true,
    blocksDpaaFail: true,
    blocksSbadrFail: true,
  };
}

export function formatAmbiguityGatePolicy(policy: AmbiguityGatePolicy): string {
  return `Ambiguity policy: ${policy.strictness} (${policy.reason})`;
}
