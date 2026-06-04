/**
 * edit-scope.ts — Guarded Editing (MVP 4)
 *
 * Provides path validation, hash verification, and controlled file mutation
 * for the workflow_propose_edit / workflow_apply_approved_edit tools.
 *
 * Safety guarantees:
 *   - Path traversal detection (canonicalize then check prefix)
 *   - Symlink rejection by default
 *   - Protected path blocking (.pi/extensions, node_modules, .git, .env)
 *   - Base-file hash verification before applying edits (detects concurrent changes)
 *   - Plan hash binding: proposed edits are tied to the current DPAA-approved plan
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256File } from "./storage";
import type { EditScope, ProposedEdit } from "./types";

// ── Protected path patterns ───────────────────────────────────────────────────
// Paths matching any of these (relative to git root, forward-slash normalized)
// are unconditionally blocked regardless of phase or approval.

const PROTECTED_PATTERNS: RegExp[] = [
  /^(target\/)?\.pi\/extensions(\/|$)/,  // harness extension source
  /^(target\/)?\.pi\/.*\.(ts|js)$/,      // any harness TS/JS files
  /(^|\/)node_modules(\/|$)/,            // npm dependencies
  /(^|\/)\.git(\/|$)/,                   // git internals
  /(^|\/)\.env(\.|$)/,                   // .env, .env.local, etc.
  /^\.harness\/workflow-policy\.json$/,  // policy file (admin only)
];

// ── Path validation ───────────────────────────────────────────────────────────

export type PathValidationResult = { ok: true } | { ok: false; reason: string };

export function validateEditPath(
  filePath: string,
  gitRoot: string,
  allowSymlinks = false,
): PathValidationResult {
  // 1. Normalize path separators
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (!normalized) return { ok: false, reason: "Empty file path" };

  // 2. Resolve absolute path
  let abs: string;
  try {
    abs = path.resolve(gitRoot, normalized);
  } catch {
    return { ok: false, reason: `Cannot resolve path: ${filePath}` };
  }

  // 3. Path traversal: resolved path must be inside gitRoot
  const rel = path.relative(gitRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `Path traversal blocked: "${filePath}" escapes the project root` };
  }

  // 4. Symlink check (lstat the path without following links)
  if (!allowSymlinks) {
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: `Symlinks are not allowed: "${filePath}"` };
      }
    } catch {
      // File does not exist yet — acceptable for write operations
    }
  }

  // 5. Protected path check
  const relUnix = rel.replace(/\\/g, "/");
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(relUnix)) {
      return { ok: false, reason: `Protected path blocked: "${filePath}"` };
    }
  }

  return { ok: true };
}

// ── Base file hash helpers ────────────────────────────────────────────────────

/**
 * Compute SHA-256 of each proposed edit target at proposal time.
 * Files that don't exist yet (new files) are omitted from the map.
 */
export function computeBaseFileHashes(
  edits: ProposedEdit[],
  gitRoot: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const edit of edits) {
    const abs = path.resolve(gitRoot, edit.path.replace(/\\/g, "/"));
    try {
      hashes[edit.path] = sha256File(abs);
    } catch {
      // File does not exist yet — skip
    }
  }
  return hashes;
}

/**
 * Verify that files haven't changed since the edit scope was proposed.
 * Returns the list of changed (or disappeared) file paths.
 */
export function verifyBaseFileHashes(
  scope: EditScope,
  gitRoot: string,
): { ok: boolean; changed: string[] } {
  const changed: string[] = [];
  for (const [filePath, expectedHash] of Object.entries(scope.baseFileHashes)) {
    const abs = path.resolve(gitRoot, filePath.replace(/\\/g, "/"));
    try {
      const current = sha256File(abs);
      if (current !== expectedHash) changed.push(filePath);
    } catch {
      changed.push(filePath); // file disappeared
    }
  }
  return { ok: changed.length === 0, changed };
}

// ── Edit application ──────────────────────────────────────────────────────────

/**
 * Apply a single ProposedEdit to disk.
 * Caller must validate the path and verify hashes before calling this.
 */
export function applyProposedEdit(edit: ProposedEdit, gitRoot: string): void {
  const abs = path.resolve(gitRoot, edit.path.replace(/\\/g, "/"));

  switch (edit.operation) {
    case "write": {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, edit.content ?? "", "utf-8");
      break;
    }
    case "edit": {
      if (edit.oldText === undefined || edit.newText === undefined) {
        throw new Error(`edit operation requires oldText and newText for: ${edit.path}`);
      }
      const current = fs.readFileSync(abs, "utf-8");
      const index = current.indexOf(edit.oldText);
      if (index === -1) {
        throw new Error(
          `oldText not found in "${edit.path}". The file may have changed since the edit was proposed.`,
        );
      }
      // Use slice-based replacement to avoid String.replace() pattern interpretation
      // ($&, $', $1 etc. in newText would silently corrupt output with .replace())
      fs.writeFileSync(
        abs,
        current.slice(0, index) + edit.newText + current.slice(index + edit.oldText.length),
        "utf-8",
      );
      break;
    }
    case "delete": {
      fs.rmSync(abs, { force: true });
      break;
    }
    default: {
      throw new Error(`Unknown edit operation: ${(edit as ProposedEdit).operation}`);
    }
  }
}

// ── Diff formatting ───────────────────────────────────────────────────────────

/**
 * Format a human-readable diff preview for the approval dialog.
 * Keep it concise — this is shown inline in ctx.ui.confirm().
 */
export function formatEditScopeDiff(edits: ProposedEdit[], gitRoot: string): string {
  const lines: string[] = [];
  for (const edit of edits) {
    lines.push(`\n── ${edit.operation.toUpperCase()}: ${edit.path}`);
    lines.push(`   Reason: ${edit.reason}`);
    switch (edit.operation) {
      case "write": {
        const content = edit.content ?? "";
        const contentLines = content.split("\n");
        const preview = contentLines.slice(0, 10).join("\n");
        const more = contentLines.length > 10 ? `\n   … (${contentLines.length} lines total)` : "";
        lines.push(`   Content preview:\n${preview.split("\n").map((l) => `     ${l}`).join("\n")}${more}`);
        break;
      }
      case "edit": {
        const oldLines = (edit.oldText ?? "").split("\n").slice(0, 5);
        const newLines = (edit.newText ?? "").split("\n").slice(0, 5);
        const oldTotal = (edit.oldText ?? "").split("\n").length;
        const newTotal = (edit.newText ?? "").split("\n").length;
        oldLines.forEach((l) => lines.push(`   - ${l}`));
        if (oldTotal > 5) lines.push(`     … (${oldTotal} lines total)`);
        newLines.forEach((l) => lines.push(`   + ${l}`));
        if (newTotal > 5) lines.push(`     … (${newTotal} lines total)`);
        break;
      }
      case "delete":
        lines.push(`   ⚠️  File will be permanently deleted`);
        break;
    }
  }
  return lines.join("\n");
}

// ── EditScope factory ─────────────────────────────────────────────────────────

let _scopeCounter = 0;

export function createEditScope(
  edits: ProposedEdit[],
  gitRoot: string,
  sourcePlanHash: string | null,
): EditScope {
  _scopeCounter += 1;
  return {
    id: `es-${Date.now()}-${_scopeCounter}`,
    approvedBy: null,
    sourcePlanHash,
    allowedGlobs: [],
    deniedGlobs: [],
    maxFiles: 50,
    allowSymlinks: false,
    proposedEdits: edits,
    baseFileHashes: computeBaseFileHashes(edits, gitRoot),
    proposedAt: Date.now(),
    approvedAt: null,
  };
}
