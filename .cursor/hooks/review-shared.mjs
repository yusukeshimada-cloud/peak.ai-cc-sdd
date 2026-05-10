import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const FINDINGS_DIR = join(PROJECT_ROOT, "05_cc-sdd_specs分割", "review-findings");

const patterns = JSON.parse(readFileSync(join(__dirname, "source-code-patterns.json"), "utf-8"));
const SOURCE_CODE_EXTENSIONS = new Set(patterns.extensions);
const SOURCE_CODE_FILENAMES = new Set(patterns.filenames);

export function isSourceCodeFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return true;
  const name = basename(filePath);
  return SOURCE_CODE_FILENAMES.has(name);
}

export function hasStagedSourceCode() {
  try {
    const output = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    }).trim();
    if (!output) return false;
    return output.split("\n").some((f) => isSourceCodeFile(f));
  } catch {
    return true;
  }
}

export const REVIEW_TYPES = {
  general: {
    queueFile: join(FINDINGS_DIR, "review-queue.json"),
    blockPolicy: "critical_high",
    label: "通常レビュー",
  },
  security: {
    queueFile: join(FINDINGS_DIR, "security-review-queue.json"),
    blockPolicy: "all",
    label: "セキュリティレビュー",
  },
};

export function readQueue(queueFile) {
  if (!existsSync(queueFile)) return null;
  try {
    return JSON.parse(readFileSync(queueFile, "utf-8"));
  } catch {
    return null;
  }
}

export function countByStatus(findings) {
  const c = { open: 0, in_progress: 0, resolved: 0, re_review_failed: 0 };
  for (const f of findings) c[f.remediation_status] = (c[f.remediation_status] || 0) + 1;
  return c;
}

export function unresolvedCount(findings, policy) {
  return findings.filter((f) => {
    const unresolved =
      f.remediation_status === "open" ||
      f.remediation_status === "in_progress" ||
      f.remediation_status === "re_review_failed";
    if (!unresolved) return false;
    if (policy === "critical_high") {
      return f.severity === "critical" || f.severity === "high";
    }
    return true;
  }).length;
}

export function buildLoopStatus() {
  const results = [];
  for (const [type, config] of Object.entries(REVIEW_TYPES)) {
    const queue = readQueue(config.queueFile);
    if (!queue) {
      results.push({ type, label: config.label, phase: "not_started" });
      continue;
    }
    const counts = countByStatus(queue.findings);
    const blocking = unresolvedCount(queue.findings, config.blockPolicy);
    const hasOpen = counts.open > 0 || counts.in_progress > 0;
    const hasReviewFailed = counts.re_review_failed > 0;
    const reReviewed = !!queue.last_re_review_at;
    let phase;
    if (queue.findings.length === 0) {
      phase = "completed";
    } else if (blocking === 0 && counts.resolved === queue.findings.length && (queue.status === "completed" || reReviewed)) {
      phase = "completed";
    } else if (blocking === 0 && counts.resolved === queue.findings.length) {
      phase = "needs_re_review";
    } else if (hasOpen) {
      phase = "needs_fix";
    } else if (hasReviewFailed) {
      phase = "re_review_failed_needs_fix";
    } else if (blocking === 0 && counts.resolved > 0) {
      phase = "needs_re_review";
    } else {
      phase = "needs_fix";
    }
    results.push({ type, label: config.label, phase, blocking, counts, total: queue.findings.length });
  }
  return results;
}
