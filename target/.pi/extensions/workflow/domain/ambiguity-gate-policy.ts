import type { WorkflowInstance } from "../types";

export type AmbiguityGateStrictness = "advisory" | "standard" | "strict";

export type AmbiguityGatePolicy = {
  strictness: AmbiguityGateStrictness;
  reason: string;
  requiresPlan: boolean;
  blocksDpaaFail: boolean;
  blocksSbadrFail: boolean;
};

type AmbiguityPolicyMetadata = {
  ambiguityGate?: AmbiguityGateStrictness;
  risk?: "low" | "normal" | "high";
  workType?: string;
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

const STRICT_WORK_TYPES = new Set(["api", "contract", "schema", "security", "migration", "database", "data", "deploy", "release"]);
const ADVISORY_WORK_TYPES = new Set(["docs", "documentation", "cosmetic", "discovery", "research", "spike", "style", "theme"]);

export function classifyAmbiguityGatePolicy(workflow: WorkflowInstance, planText = ""): AmbiguityGatePolicy {
  const metadata = parseAmbiguityPolicyMetadata(planText);
  const metadataPolicy = policyFromMetadata(metadata);
  if (metadataPolicy) return metadataPolicy;

  const titleSource = workflow.title;
  const strictSource = `${workflow.title}\n${planText}`;
  if (STRICT_PATTERNS.some((pattern) => pattern.test(strictSource))) {
    return buildPolicy(
      "strict",
      "High-risk/API/schema/security/data/deployment keyword detected.",
    );
  }

  if (ADVISORY_PATTERNS.some((pattern) => pattern.test(titleSource))) {
    return buildPolicy(
      "advisory",
      "Low-risk, documentation/cosmetic, or discovery-oriented keyword detected.",
    );
  }

  return buildPolicy("standard", "Default feature/workflow ambiguity policy.");
}

function policyFromMetadata(metadata: AmbiguityPolicyMetadata): AmbiguityGatePolicy | undefined {
  if (metadata.risk === "high") {
    return buildPolicy("strict", "Explicit plan metadata marked risk as high.");
  }
  if (metadata.workType && workTypeHasSignal(metadata.workType, STRICT_WORK_TYPES)) {
    return buildPolicy("strict", `Explicit plan metadata marked work type '${metadata.workType}' as high risk.`);
  }
  if (metadata.ambiguityGate === "strict") {
    return buildPolicy("strict", "Explicit plan metadata selected ambiguity gate 'strict'.");
  }
  if (metadata.ambiguityGate) {
    return buildPolicy(metadata.ambiguityGate, `Explicit plan metadata selected ambiguity gate '${metadata.ambiguityGate}'.`);
  }
  if (metadata.risk === "low") {
    return buildPolicy("advisory", "Explicit plan metadata marked risk as low.");
  }
  if (metadata.workType && workTypeHasSignal(metadata.workType, ADVISORY_WORK_TYPES)) {
    return buildPolicy("advisory", `Explicit plan metadata marked work type '${metadata.workType}' as low risk.`);
  }
  if (metadata.risk === "normal") {
    return buildPolicy("standard", "Explicit plan metadata marked risk as normal.");
  }
  return undefined;
}

function workTypeHasSignal(workType: string, signals: Set<string>): boolean {
  if (signals.has(workType)) return true;
  return workType.split("-").some((part) => signals.has(part));
}

function parseAmbiguityPolicyMetadata(planText: string): AmbiguityPolicyMetadata {
  const metadata: AmbiguityPolicyMetadata = {};
  for (const line of planText.split(/\r?\n/).slice(0, 40)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(risk|work\s*type|ambiguity\s*gate)\s*:\s*([^#]+?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/\s+/g, " ");
    const value = normalizeMetadataValue(match[2]);
    if (key === "ambiguity gate" && isAmbiguityGateStrictness(value)) metadata.ambiguityGate = value;
    if (key === "risk" && isRiskValue(value)) metadata.risk = value;
    if (key === "work type") metadata.workType = value;
  }
  return metadata;
}

function normalizeMetadataValue(value: string): string {
  return value.trim().toLowerCase().replace(/^['"]|['"]$/g, "").replace(/[_.\s]+/g, "-");
}

function isAmbiguityGateStrictness(value: string): value is AmbiguityGateStrictness {
  return value === "advisory" || value === "standard" || value === "strict";
}

function isRiskValue(value: string): value is "low" | "normal" | "high" {
  return value === "low" || value === "normal" || value === "high";
}

function buildPolicy(strictness: AmbiguityGateStrictness, reason: string): AmbiguityGatePolicy {
  const blocks = strictness !== "advisory";
  return {
    strictness,
    reason,
    requiresPlan: strictness !== "advisory",
    blocksDpaaFail: blocks,
    blocksSbadrFail: blocks,
  };
}

export function formatAmbiguityGatePolicy(policy: AmbiguityGatePolicy): string {
  return `Ambiguity policy: ${policy.strictness} (${policy.reason})`;
}
