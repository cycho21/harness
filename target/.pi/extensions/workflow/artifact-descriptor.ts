import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ArtifactKind =
  | "spec"
  | "plan"
  | "review"
  | "trace"
  | "verification"
  | "dpaa-report"
  | "field-log"
  | "handoff"
  | "other";

export type ArtifactRetention = "until-completion" | "persistent" | "debug-only";

export type ArtifactProducer = {
  system: "harness";
  component: string;
};

export type ArtifactDescriptor = {
  kind: ArtifactKind;
  path: string;
  createdAt: string;
  producer: ArtifactProducer;
  retention: ArtifactRetention;
  sizeBytes: number;
  sha256: string;
  summary?: string;
};

export const DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES = 8 * 1024;

export type ArtifactHandoff =
  | { mode: "inline"; body: string; sizeBytes: number }
  | { mode: "descriptor"; descriptor: ArtifactDescriptor; summary: string; sizeBytes: number };

export function describeArtifact(options: {
  kind: ArtifactKind;
  filePath: string;
  producer: ArtifactProducer;
  retention: ArtifactRetention;
  summary?: string;
}): ArtifactDescriptor {
  const bytes = fs.readFileSync(options.filePath);
  return {
    kind: options.kind,
    path: path.resolve(options.filePath),
    createdAt: new Date().toISOString(),
    producer: options.producer,
    retention: options.retention,
    sizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    summary: options.summary,
  };
}

export function createArtifactHandoff(options: {
  body: string;
  thresholdBytes?: number;
  descriptorFactory: () => ArtifactDescriptor;
  summary?: string;
}): ArtifactHandoff {
  const sizeBytes = Buffer.byteLength(options.body, "utf8");
  const threshold = options.thresholdBytes ?? DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES;
  if (sizeBytes <= threshold) return { mode: "inline", body: options.body, sizeBytes };
  const descriptor = options.descriptorFactory();
  return {
    mode: "descriptor",
    descriptor,
    sizeBytes,
    summary: options.summary ?? summarizeForDescriptor(options.body),
  };
}

export function writeTextArtifact(options: {
  filePath: string;
  content: string;
  kind: ArtifactKind;
  producer: ArtifactProducer;
  retention: ArtifactRetention;
  summary?: string;
}): ArtifactDescriptor {
  fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
  fs.writeFileSync(options.filePath, options.content, "utf8");
  return describeArtifact({
    kind: options.kind,
    filePath: options.filePath,
    producer: options.producer,
    retention: options.retention,
    summary: options.summary,
  });
}

function summarizeForDescriptor(body: string): string {
  const firstLines = body.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 6).join("\n");
  return firstLines.length > 600 ? `${firstLines.slice(0, 597)}...` : firstLines;
}
