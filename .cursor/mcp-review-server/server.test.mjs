import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { extname, basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function countByStatus(findings) {
  const c = { open: 0, in_progress: 0, resolved: 0, re_review_failed: 0 };
  for (const f of findings) c[f.remediation_status] = (c[f.remediation_status] || 0) + 1;
  return c;
}

function unresolvedCount(findings, policy) {
  return findings.filter((f) => {
    const isUnresolved =
      f.remediation_status === "open" ||
      f.remediation_status === "in_progress" ||
      f.remediation_status === "re_review_failed";
    if (!isUnresolved) return false;
    if (policy === "critical_high") {
      return f.severity === "critical" || f.severity === "high";
    }
    return true;
  }).length;
}

function buildLoopStatus(reviewTypes, readQueue) {
  const results = [];
  for (const [type, config] of Object.entries(reviewTypes)) {
    const queue = readQueue(type);
    if (!queue) {
      results.push({ type, label: config.label, phase: "not_started", blocking: 0, counts: null });
      continue;
    }
    const counts = countByStatus(queue.findings);
    const blocking = unresolvedCount(queue.findings, config.blockPolicy);
    const hasReviewFailed = counts.re_review_failed > 0;
    const hasOpen = counts.open > 0 || counts.in_progress > 0;
    let phase;
    const reReviewed = !!queue.last_re_review_at;
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

describe("unresolvedCount", () => {
  const findings = [
    { remediation_status: "open", severity: "critical" },
    { remediation_status: "open", severity: "low" },
    { remediation_status: "resolved", severity: "high" },
    { remediation_status: "in_progress", severity: "medium" },
    { remediation_status: "re_review_failed", severity: "high" },
  ];

  it("policy=all counts all unresolved", () => {
    assert.equal(unresolvedCount(findings, "all"), 4);
  });

  it("policy=critical_high counts only critical/high unresolved", () => {
    assert.equal(unresolvedCount(findings, "critical_high"), 2);
  });

  it("returns 0 for all resolved", () => {
    const resolved = [{ remediation_status: "resolved", severity: "critical" }];
    assert.equal(unresolvedCount(resolved, "all"), 0);
  });

  it("returns 0 for empty array", () => {
    assert.equal(unresolvedCount([], "all"), 0);
  });
});

describe("countByStatus", () => {
  it("counts each status correctly", () => {
    const findings = [
      { remediation_status: "open" },
      { remediation_status: "open" },
      { remediation_status: "resolved" },
      { remediation_status: "in_progress" },
      { remediation_status: "re_review_failed" },
    ];
    const result = countByStatus(findings);
    assert.deepEqual(result, { open: 2, in_progress: 1, resolved: 1, re_review_failed: 1 });
  });

  it("handles empty array", () => {
    assert.deepEqual(countByStatus([]), { open: 0, in_progress: 0, resolved: 0, re_review_failed: 0 });
  });
});

describe("buildLoopStatus", () => {
  const config = {
    general: { label: "通常", blockPolicy: "critical_high" },
    security: { label: "セキュリティ", blockPolicy: "all" },
  };

  it("returns not_started when queue is null", () => {
    const result = buildLoopStatus(config, () => null);
    assert.equal(result[0].phase, "not_started");
    assert.equal(result[1].phase, "not_started");
  });

  it("returns needs_re_review when all resolved but no re-review done", () => {
    const queue = { status: "in_progress", findings: [{ remediation_status: "resolved", severity: "high" }] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "needs_re_review");
  });

  it("returns completed when all resolved and status=completed", () => {
    const queue = { status: "completed", findings: [{ remediation_status: "resolved", severity: "high" }] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "completed");
  });

  it("returns completed when all resolved and last_re_review_at set", () => {
    const queue = { status: "in_progress", last_re_review_at: "2026-04-16T00:00:00Z", findings: [{ remediation_status: "resolved", severity: "high" }] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "completed");
  });

  it("returns needs_fix when open findings exist", () => {
    const queue = { findings: [{ remediation_status: "open", severity: "high" }] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "needs_fix");
  });

  it("returns needs_re_review when all resolved but not re-reviewed (critical_high policy)", () => {
    const queue = {
      status: "in_progress",
      findings: [
        { remediation_status: "resolved", severity: "high" },
        { remediation_status: "resolved", severity: "low" },
      ],
    };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "needs_re_review");
  });

  it("returns re_review_failed_needs_fix when re_review_failed exists", () => {
    const queue = { findings: [{ remediation_status: "re_review_failed", severity: "high" }] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "re_review_failed_needs_fix");
  });

  it("prioritizes open over re_review_failed when both exist", () => {
    const queue = {
      findings: [
        { remediation_status: "open", severity: "high" },
        { remediation_status: "re_review_failed", severity: "medium" },
      ],
    };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "needs_fix");
  });

  it("returns needs_re_review for security when all resolved but not re-reviewed", () => {
    const queue = {
      status: "in_progress",
      findings: [
        { remediation_status: "resolved", severity: "low" },
        { remediation_status: "resolved", severity: "high" },
      ],
    };
    const result = buildLoopStatus({ security: config.security }, () => queue);
    assert.equal(result[0].phase, "needs_re_review");
  });

  it("returns completed when findings array is empty (0 findings)", () => {
    const queue = { status: "in_progress", findings: [] };
    const result = buildLoopStatus({ general: config.general }, () => queue);
    assert.equal(result[0].phase, "completed");
  });

  it("returns completed for security when re-reviewed", () => {
    const queue = {
      status: "in_progress",
      last_re_review_at: "2026-04-16T00:00:00Z",
      findings: [
        { remediation_status: "resolved", severity: "low" },
        { remediation_status: "resolved", severity: "high" },
      ],
    };
    const result = buildLoopStatus({ security: config.security }, () => queue);
    assert.equal(result[0].phase, "completed");
  });
});

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const _patterns = JSON.parse(readFileSync(join(__test_dirname, "..", "..", "..", ".cursor", "hooks", "source-code-patterns.json"), "utf-8"));
const SOURCE_CODE_EXTENSIONS = new Set(_patterns.extensions);
const SOURCE_CODE_FILENAMES = new Set(_patterns.filenames);

function isSourceCodeFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return true;
  return SOURCE_CODE_FILENAMES.has(basename(filePath));
}

describe("isSourceCodeFile", () => {
  it("identifies Java files as source", () => {
    assert.equal(isSourceCodeFile("src/Main.java"), true);
  });

  it("identifies TypeScript/JSX files as source", () => {
    assert.equal(isSourceCodeFile("frontend/App.tsx"), true);
    assert.equal(isSourceCodeFile("utils/helper.ts"), true);
  });

  it("identifies shell scripts as source", () => {
    assert.equal(isSourceCodeFile("scripts/deploy.sh"), true);
  });

  it("identifies MJS/CJS files as source", () => {
    assert.equal(isSourceCodeFile("hooks/gate.mjs"), true);
    assert.equal(isSourceCodeFile("lib/util.cjs"), true);
  });

  it("identifies config files as source", () => {
    assert.equal(isSourceCodeFile("config/app.yml"), true);
    assert.equal(isSourceCodeFile("config/db.properties"), true);
    assert.equal(isSourceCodeFile("pom.xml"), true);
  });

  it("identifies SQL files as source", () => {
    assert.equal(isSourceCodeFile("db/V1__init.sql"), true);
  });

  it("identifies extensionless source filenames", () => {
    assert.equal(isSourceCodeFile("Dockerfile"), true);
    assert.equal(isSourceCodeFile("subdir/Makefile"), true);
    assert.equal(isSourceCodeFile("Jenkinsfile"), true);
  });

  it("rejects markdown files", () => {
    assert.equal(isSourceCodeFile("README.md"), false);
    assert.equal(isSourceCodeFile("docs/guide.md"), false);
  });

  it("rejects image files", () => {
    assert.equal(isSourceCodeFile("assets/logo.png"), false);
    assert.equal(isSourceCodeFile("photo.jpg"), false);
  });

  it("rejects JSON files", () => {
    assert.equal(isSourceCodeFile("package.json"), false);
    assert.equal(isSourceCodeFile("tsconfig.json"), false);
  });

  it("rejects dotfiles without source extension", () => {
    assert.equal(isSourceCodeFile(".gitignore"), false);
    assert.equal(isSourceCodeFile(".editorconfig"), false);
  });

  it("rejects text and PDF files", () => {
    assert.equal(isSourceCodeFile("notes.txt"), false);
    assert.equal(isSourceCodeFile("spec.pdf"), false);
  });

  it("rejects CSV files", () => {
    assert.equal(isSourceCodeFile("data/export.csv"), false);
  });
});
