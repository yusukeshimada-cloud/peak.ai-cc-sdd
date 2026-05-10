import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const FINDINGS_DIR = join(PROJECT_ROOT, "review-findings");
const PROMPT_FILE = join(__dirname, "review-prompt.md");
const SECURITY_PROMPT_FILE = join(__dirname, "security-review-prompt.md");

const ENV_FILE = join(PROJECT_ROOT, ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (!existsSync(FINDINGS_DIR)) mkdirSync(FINDINGS_DIR, { recursive: true });

const REPO_ROOT = join(PROJECT_ROOT, "..");
const _scPatterns = JSON.parse(readFileSync(join(REPO_ROOT, ".cursor", "hooks", "source-code-patterns.json"), "utf-8"));
const SOURCE_CODE_EXTENSIONS = new Set(_scPatterns.extensions);
const SOURCE_CODE_FILENAMES = new Set(_scPatterns.filenames);

function isSourceCodeFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return true;
  return SOURCE_CODE_FILENAMES.has(basename(filePath));
}

function hasStagedSourceCode() {
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

const REVIEW_TYPES = {
  general: {
    queueFile: join(FINDINGS_DIR, "review-queue.json"),
    filePrefix: "ai_review_refact-",
    label: "通常レビュー",
    blockPolicy: "critical_high",
  },
  security: {
    queueFile: join(FINDINGS_DIR, "security-review-queue.json"),
    filePrefix: "ai_security_review-",
    label: "セキュリティレビュー",
    blockPolicy: "all",
  },
};

const reviewTypeSchema = z
  .enum(["general", "security"])
  .default("general")
  .describe("レビュー種別: general(通常) / security(セキュリティ)");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getConfig(type) {
  return REVIEW_TYPES[type] ?? REVIEW_TYPES.general;
}

function readQueue(type) {
  const { queueFile } = getConfig(type);
  if (!existsSync(queueFile)) return null;
  try {
    return JSON.parse(readFileSync(queueFile, "utf-8"));
  } catch {
    return null;
  }
}

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

function writeQueue(type, data) {
  const { queueFile } = getConfig(type);
  atomicWriteJSON(queueFile, data);
}

function nextFilename(type) {
  const { filePrefix } = getConfig(type);
  const today = new Date().toISOString().split("T")[0];
  const prefix = `${filePrefix}${today}-`;
  const files = existsSync(FINDINGS_DIR) ? readdirSync(FINDINGS_DIR) : [];
  const nums = files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/-(\d+)\.json$/);
      return m ? parseInt(m[1]) : 0;
    });
  const n = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(n).padStart(3, "0")}.json`;
}

const REVIEW_BASE_BRANCH = process.env.REVIEW_BASE_BRANCH || "develop";

function branchDiff(targetPath) {
  const args = ["diff", `${REVIEW_BASE_BRANCH}...HEAD`];
  if (targetPath) args.push("--", targetPath);
  return execFileSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function currentBranchName() {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readProjectFile(relPath) {
  const full = join(PROJECT_ROOT, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf-8");
}

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

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "review-server",
  version: "1.0.0",
});

// ---- 0. review_gate ---------------------------------------------------------

function buildLoopStatus() {
  const results = [];
  for (const [type, config] of Object.entries(REVIEW_TYPES)) {
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

server.tool(
  "review_gate",
  "git commit 前にレビュー状態を判定し、次に実行すべきアクションを返す。通常レビューは Critical/High 全解決、セキュリティレビューは全件解決が必要。",
  {},
  async () => {
    const hasStagedChanges = (() => {
      try {
        return execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
        }).trim().length > 0;
      } catch {
        return false;
      }
    })();

    if (!hasStagedChanges) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            commit_allowed: true,
            reason: "staged 変更がありません。git commit をそのまま実行できます。",
          }, null, 2),
        }],
      };
    }

    if (!hasStagedSourceCode()) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            commit_allowed: true,
            reason: "staged にソースコードが含まれていません（ドキュメント・画像等のみ）。レビュー不要で git commit を実行できます。",
          }, null, 2),
        }],
      };
    }

    const statuses = buildLoopStatus();
    const allCompleted = statuses.every((s) => s.phase === "completed");

    if (allCompleted) {
      for (const type of Object.keys(REVIEW_TYPES)) {
        const queue = readQueue(type);
        if (queue && queue.status !== "completed") {
          writeQueue(type, { ...queue, status: "completed" });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            commit_allowed: true,
            reason: "通常レビュー・セキュリティレビューの両方を通過しました。git commit を実行してください。",
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          commit_allowed: false,
          message: "レビューループが未完了です。`review_orchestrate` を呼び出して自動ループを開始してください。",
          next_action: "review_orchestrate",
        }, null, 2),
      }],
    };
  },
);

// ---- 0b. review_orchestrate -------------------------------------------------

server.tool(
  "review_orchestrate",
  "レビュー→修正→再レビューの自動ループを制御するオーケストレーター。現在の状態を判定し、次に実行すべきアクションを具体的に返す。ループが完了するまで繰り返し呼び出すこと。",
  {},
  async () => {
    const statuses = buildLoopStatus();
    const allCompleted = statuses.every((s) => s.phase === "completed");

    if (allCompleted) {
      return {
        content: [{
          type: "text",
          text: [
            "## ループ完了",
            "通常レビュー・セキュリティレビューの両方が完了しました。",
            "`git commit` を実行してコミットしてください。",
          ].join("\n"),
        }],
      };
    }

    const steps = [];
    steps.push("## レビュー自動ループ — 現在の状態と次のアクション");
    steps.push("");

    for (const s of statuses) {
      steps.push(`### ${s.label} (${s.type})`);
      if (s.counts) {
        steps.push(`  open: ${s.counts.open} | in_progress: ${s.counts.in_progress} | resolved: ${s.counts.resolved} | re_review_failed: ${s.counts.re_review_failed} | total: ${s.total}`);
      }

      switch (s.phase) {
        case "not_started":
          steps.push(`  状態: 未実施`);
          if (s.type === "general") {
            steps.push(`  **次のアクション**: \`review_start\` を呼び出してレビューを実行し、結果を \`review_save_findings({ review_type: 'general' })\` で保存してください。`);
          } else {
            steps.push(`  **次のアクション**: \`security_review_start\` を呼び出してレビューを実行し、結果を \`review_save_findings({ review_type: 'security' })\` で保存してください。`);
          }
          break;

        case "needs_fix":
          steps.push(`  状態: 未修正の指摘あり (ブロック中: ${s.blocking} 件)`);
          steps.push(`  **次のアクション**: \`review_list_findings({ review_type: '${s.type}', status: 'open' })\` を呼び出し、各指摘を順番に修正してください。`);
          steps.push(`  修正フロー: \`review_claim_finding\` → コード修正 → \`review_resolve_finding\` を各指摘に対して繰り返す。`);
          break;

        case "re_review_failed_needs_fix":
          steps.push(`  状態: 再レビューで不合格の指摘あり (${s.counts.re_review_failed} 件)`);
          steps.push(`  **次のアクション**: \`review_list_findings({ review_type: '${s.type}', status: 're_review_failed' })\` を呼び出し、不合格指摘を修正してください。`);
          steps.push(`  修正フロー: \`review_claim_finding\` → コード修正 → \`review_resolve_finding\` を各指摘に対して繰り返す。`);
          break;

        case "needs_re_review":
          steps.push(`  状態: 全ブロック指摘が resolved — 再レビュー待ち`);
          steps.push(`  **次のアクション**: \`re_review_start({ review_type: '${s.type}' })\` を呼び出して再レビューを実行してください。`);
          steps.push(`  不合格があれば \`review_reopen_finding\` で差し戻し、再度修正ループに入ります。`);
          break;

        case "completed":
          steps.push(`  状態: 完了 ✓`);
          break;
      }
      steps.push("");
    }

    const notStarted = statuses.filter((s) => s.phase === "not_started");
    const needsFix = statuses.filter((s) => s.phase === "needs_fix" || s.phase === "re_review_failed_needs_fix");
    const needsReReview = statuses.filter((s) => s.phase === "needs_re_review");

    steps.push("## 実行指示");
    steps.push("以下の順序で**自動的に**実行してください。各ステップ完了後は `review_orchestrate` を再度呼び出して次のアクションを確認してください。");
    steps.push("");

    if (notStarted.length > 0) {
      const first = notStarted[0];
      steps.push(`**今すぐ実行**: ${first.label}のレビューを開始 → ${first.type === "general" ? "review_start" : "security_review_start"}`);
    } else if (needsFix.length > 0) {
      const first = needsFix[0];
      const statusFilter = first.phase === "re_review_failed_needs_fix" ? "re_review_failed" : "open";
      steps.push(`**今すぐ実行**: ${first.label}の指摘を修正 → review_list_findings({ review_type: '${first.type}', status: '${statusFilter}' })`);
    } else if (needsReReview.length > 0) {
      const first = needsReReview[0];
      steps.push(`**今すぐ実行**: ${first.label}の再レビュー → re_review_start({ review_type: '${first.type}' })`);
    }

    steps.push("");
    steps.push("**重要**: 各アクション完了後、必ず `review_orchestrate` を呼び出してループを継続してください。ループが完了するまで停止しないでください。");

    return { content: [{ type: "text", text: steps.join("\n") }] };
  },
);

// ---- 1a. review_start -------------------------------------------------------

server.tool(
  "review_start",
  `ベースブランチ（${REVIEW_BASE_BRANCH}）との差分を取得し通常レビュープロンプトと共に返す。Opus モデルでのレビュー実行用。`,
  { target_path: z.string().max(512).optional().describe("レビュー対象パス（省略時は全ファイル差分）") },
  async ({ target_path }) => {
    const branch = currentBranchName();
    const diff = branchDiff(target_path);
    if (!diff.trim()) {
      return { content: [{ type: "text", text: `${REVIEW_BASE_BRANCH} と現在のブランチ (${branch}) に差分がありません。` }] };
    }
    const prompt = existsSync(PROMPT_FILE) ? readFileSync(PROMPT_FILE, "utf-8") : "";
    const targetDesc = target_path ?? "全ファイル差分";
    return {
      content: [{
        type: "text",
        text: [
          "## モデル指定",
          "このレビューは **Opus モデル** で実行してください。read-only で修正は行わないでください。",
          "",
          `## 通常レビュー対象: ${targetDesc}`,
          `比較: \`${REVIEW_BASE_BRANCH}...${branch}\``,
          "",
          "## レビュープロンプト",
          prompt,
          "",
          `## Branch Diff (${REVIEW_BASE_BRANCH}...${branch})`,
          "```diff",
          diff,
          "```",
          "",
          "## 出力指示",
          "レビュー完了後、`review_save_findings` ツールを呼び出して結果を保存してください。",
          "**review_type は 'general' を指定してください。**",
          "各 finding には以下のフィールドを含めてください:",
          "id, review_area, severity(critical/high/medium/low), category, title, file_path, line_range, description, evidence, suggested_fix",
          "",
          "## コミットブロック基準",
          "通常レビューでは **Critical と High** がすべて resolved になるまでコミットがブロックされます。Medium/Low は推奨修正です。",
          "",
          "## 次のステップ（自動実行）",
          "保存完了後、`review_orchestrate` を呼び出して次のアクションを取得し、ループを継続してください。",
        ].join("\n"),
      }],
    };
  },
);

// ---- 1b. security_review_start ----------------------------------------------

server.tool(
  "security_review_start",
  `ベースブランチ（${REVIEW_BASE_BRANCH}）との差分をセキュリティ観点で専門レビューする。認証・認可・API設計のセキュリティに特化。Opus モデル推奨。`,
  { target_path: z.string().max(512).optional().describe("レビュー対象パス（省略時は全ファイル差分）") },
  async ({ target_path }) => {
    const branch = currentBranchName();
    const diff = branchDiff(target_path);
    if (!diff.trim()) {
      return { content: [{ type: "text", text: `${REVIEW_BASE_BRANCH} と現在のブランチ (${branch}) に差分がありません。` }] };
    }
    const secPrompt = existsSync(SECURITY_PROMPT_FILE) ? readFileSync(SECURITY_PROMPT_FILE, "utf-8") : "";
    const targetDesc = target_path ?? "全ファイル差分";
    return {
      content: [{
        type: "text",
        text: [
          "## モデル指定",
          "このセキュリティレビューは **Opus モデル** で実行してください。read-only で修正は行わないでください。",
          "",
          `## セキュリティレビュー対象: ${targetDesc}`,
          `比較: \`${REVIEW_BASE_BRANCH}...${branch}\``,
          "",
          "## セキュリティレビュープロンプト",
          secPrompt,
          "",
          `## Branch Diff (${REVIEW_BASE_BRANCH}...${branch})`,
          "```diff",
          diff,
          "```",
          "",
          "## 出力指示",
          "セキュリティレビュー完了後、`review_save_findings` ツールを呼び出して結果を保存してください。",
          "**review_type は 'security' を指定してください。**",
          "各 finding には以下のフィールドを含めてください:",
          "id (SEC-NNN 形式), review_area: 'security', severity(critical/high/medium/low), category, title, file_path, line_range, description, evidence, suggested_fix",
          "",
          "category には以下のいずれかを使用してください:",
          "authn_bypass, authz_missing, secret_exposure, injection, cors_misconfiguration, input_validation, rate_limiting, session_management, data_exposure, dependency_vulnerability, other_security",
          "",
          "## コミットブロック基準",
          "セキュリティレビューでは **全 severity（Low 含む）** がすべて resolved になるまでコミットがブロックされます。",
          "",
          "## 次のステップ（自動実行）",
          "保存完了後、`review_orchestrate` を呼び出して次のアクションを取得し、ループを継続してください。",
        ].join("\n"),
      }],
    };
  },
);

// ---- 2. review_save_findings ------------------------------------------------

server.tool(
  "review_save_findings",
  "レビュー結果をJSONファイルに保存しキューを更新する。review_type で通常/セキュリティを切り替え。",
  {
    review_type: reviewTypeSchema,
    target_path: z.string().max(512).optional().describe("レビュー対象パス"),
    findings: z.array(z.object({
      id: z.string(),
      review_area: z.string().optional(),
      severity: z.enum(["critical", "high", "medium", "low"]),
      category: z.string().optional(),
      title: z.string(),
      file_path: z.string().optional(),
      line_range: z.string().optional(),
      description: z.string(),
      evidence: z.string().optional(),
      suggested_fix: z.string().optional(),
    })).describe("レビュー指摘の配列"),
  },
  async ({ review_type, target_path, findings }) => {
    const config = getConfig(review_type);
    const filename = nextFilename(review_type);
    const sevSummary = { critical: 0, high: 0, medium: 0, low: 0 };
    const enriched = findings.map((f) => {
      sevSummary[f.severity]++;
      return {
        ...f,
        remediation_status: "open",
        claimed_at: null,
        resolved_at: null,
        remediation_files: [],
      };
    });

    const reviewFile = {
      review_metadata: {
        review_type,
        target: target_path ?? PROJECT_ROOT,
        date: new Date().toISOString().split("T")[0],
        session_id: filename.replace(".json", ""),
        total_findings: findings.length,
        severity_summary: sevSummary,
        block_policy: config.blockPolicy,
      },
      findings: enriched,
    };

    writeFileSync(join(FINDINGS_DIR, filename), JSON.stringify(reviewFile, null, 2), "utf-8");

    writeQueue(review_type, {
      session_id: reviewFile.review_metadata.session_id,
      review_type,
      status: "in_progress",
      created_at: new Date().toISOString(),
      review_file: `review-findings/${filename}`,
      block_policy: config.blockPolicy,
      findings: enriched.map((f) => ({
        id: f.id,
        severity: f.severity,
        title: f.title,
        file_path: f.file_path ?? null,
        remediation_status: "open",
        claimed_at: null,
        resolved_at: null,
        remediation_files: [],
      })),
    });

    const policyDesc = config.blockPolicy === "critical_high"
      ? "Critical/High がすべて resolved でコミット可能"
      : "全件 resolved でコミット可能";

    return {
      content: [{
        type: "text",
        text: [
          `【${config.label}】${findings.length} 件の指摘を保存しました。`,
          `ファイル: review-findings/${filename}`,
          `Critical: ${sevSummary.critical}, High: ${sevSummary.high}, Medium: ${sevSummary.medium}, Low: ${sevSummary.low}`,
          `ブロック基準: ${policyDesc}`,
          "",
          "## 次のアクション（自動実行）",
          "`review_orchestrate` を呼び出して次のステップを取得し、修正フェーズに進んでください。",
          "**停止せずにループを継続してください。**",
        ].join("\n"),
      }],
    };
  },
);

// ---- 3. review_list_findings ------------------------------------------------

server.tool(
  "review_list_findings",
  "指摘一覧を返す。修正作業用（Sonnet モデル推奨）。",
  {
    review_type: reviewTypeSchema,
    status: z.enum(["open", "in_progress", "resolved", "re_review_failed"]).optional().describe("フィルタするステータス"),
  },
  async ({ review_type, status }) => {
    const config = getConfig(review_type);
    const queue = readQueue(review_type);
    if (!queue) {
      return { content: [{ type: "text", text: `${config.label}のキューが空です。先に該当の review_start を実行してください。` }] };
    }

    let filtered = queue.findings;
    if (status) filtered = filtered.filter((f) => f.remediation_status === status);

    let fullFindings = [];
    const reviewFilePath = join(PROJECT_ROOT, queue.review_file);
    if (existsSync(reviewFilePath)) {
      fullFindings = JSON.parse(readFileSync(reviewFilePath, "utf-8")).findings;
    }

    const detailed = filtered.map((f) => {
      const full = fullFindings.find((ff) => ff.id === f.id);
      return full ? { ...full, remediation_status: f.remediation_status } : f;
    });

    const counts = countByStatus(queue.findings);
    const policyDesc = config.blockPolicy === "critical_high"
      ? "Critical/High がすべて resolved でコミット可能"
      : "全件 resolved でコミット可能";

    return {
      content: [{
        type: "text",
        text: [
          `## ${config.label} — セッション: ${queue.session_id}`,
          `全 ${queue.findings.length} 件 | open: ${counts.open} | in_progress: ${counts.in_progress} | resolved: ${counts.resolved} | re_review_failed: ${counts.re_review_failed}`,
          `ブロック基準: ${policyDesc}`,
          "",
          "## 指摘一覧",
          JSON.stringify(detailed, null, 2),
          "",
          "## 修正ワークフロー（自動実行）",
          "以下を **各指摘に対して自動的に繰り返し** てください:",
          `1. \`review_claim_finding({ review_type: '${review_type}', finding_id: '...' })\` で指摘を claim`,
          "2. ファイルを読み込み、指摘に従ってコードを修正",
          `3. \`review_resolve_finding({ review_type: '${review_type}', finding_id: '...' })\` で完了報告`,
          "",
          "**全指摘の修正完了後、`review_orchestrate` を呼び出してループを継続してください。停止しないでください。**",
        ].join("\n"),
      }],
    };
  },
);

// ---- 4. review_claim_finding ------------------------------------------------

server.tool(
  "review_claim_finding",
  "指摘を修正中(in_progress)に更新する。",
  {
    review_type: reviewTypeSchema,
    finding_id: z.string().max(64).regex(/^[\w-]+$/).describe("指摘 ID"),
  },
  async ({ review_type, finding_id }) => {
    const queue = readQueue(review_type);
    if (!queue) return { content: [{ type: "text", text: "キューが空です。" }], isError: true };

    const f = queue.findings.find((x) => x.id === finding_id);
    if (!f) return { content: [{ type: "text", text: `指摘 ${finding_id} が見つかりません。` }], isError: true };

    f.remediation_status = "in_progress";
    f.claimed_at = new Date().toISOString();
    writeQueue(review_type, queue);

    return { content: [{ type: "text", text: `${finding_id} を in_progress にマークしました。` }] };
  },
);

// ---- 5. review_resolve_finding ----------------------------------------------

server.tool(
  "review_resolve_finding",
  "指摘を修正完了(resolved)に更新する。",
  {
    review_type: reviewTypeSchema,
    finding_id: z.string().max(64).regex(/^[\w-]+$/).describe("指摘 ID"),
    remediation_files: z.array(z.string().max(512)).optional().describe("修正したファイルパスの配列"),
  },
  async ({ review_type, finding_id, remediation_files }) => {
    const config = getConfig(review_type);
    const queue = readQueue(review_type);
    if (!queue) return { content: [{ type: "text", text: "キューが空です。" }], isError: true };

    const f = queue.findings.find((x) => x.id === finding_id);
    if (!f) return { content: [{ type: "text", text: `指摘 ${finding_id} が見つかりません。` }], isError: true };

    f.remediation_status = "resolved";
    f.resolved_at = new Date().toISOString();
    f.remediation_files = remediation_files ?? [];

    const reviewFilePath = join(PROJECT_ROOT, queue.review_file);
    if (existsSync(reviewFilePath)) {
      const full = JSON.parse(readFileSync(reviewFilePath, "utf-8"));
      const fullF = full.findings.find((x) => x.id === finding_id);
      if (fullF) {
        fullF.remediation_status = "resolved";
        fullF.resolved_at = f.resolved_at;
        fullF.remediation_files = f.remediation_files;
        atomicWriteJSON(reviewFilePath, full);
      }
    }

    writeQueue(review_type, queue);
    const blocking = unresolvedCount(queue.findings, config.blockPolicy);

    const remainingOpen = queue.findings.filter(
      (x) => x.remediation_status === "open" || x.remediation_status === "in_progress" || x.remediation_status === "re_review_failed",
    );

    let nextStep;
    if (remainingOpen.length > 0) {
      const next = remainingOpen[0];
      nextStep = `残り ${remainingOpen.length} 件。次の指摘 \`${next.id}\` を修正してください: \`review_claim_finding({ review_type: '${review_type}', finding_id: '${next.id}' })\``;
    } else {
      nextStep = `全指摘が resolved です。\`review_orchestrate\` を呼び出してループを継続してください（再レビューフェーズへ進みます）。`;
    }

    return {
      content: [{
        type: "text",
        text: [
          `${finding_id} を resolved にマークしました。`,
          config.blockPolicy === "critical_high"
            ? `コミットブロック中の未解決(Critical/High): ${blocking} 件`
            : `コミットブロック中の未解決(全件): ${blocking} 件`,
          "",
          `## 次のアクション（自動実行）`,
          nextStep,
        ].join("\n"),
      }],
    };
  },
);

// ---- 6. review_reopen_finding -----------------------------------------------

server.tool(
  "review_reopen_finding",
  "再レビューで不合格の指摘を re_review_failed に差し戻す。",
  {
    review_type: reviewTypeSchema,
    finding_id: z.string().max(64).regex(/^[\w-]+$/).describe("指摘 ID"),
    reason: z.string().max(2000).describe("差し戻し理由"),
  },
  async ({ review_type, finding_id, reason }) => {
    const queue = readQueue(review_type);
    if (!queue) return { content: [{ type: "text", text: "キューが空です。" }], isError: true };

    const f = queue.findings.find((x) => x.id === finding_id);
    if (!f) return { content: [{ type: "text", text: `指摘 ${finding_id} が見つかりません。` }], isError: true };

    f.remediation_status = "re_review_failed";
    f.reopen_reason = reason;
    f.resolved_at = null;

    const reviewFilePath = join(PROJECT_ROOT, queue.review_file);
    if (existsSync(reviewFilePath)) {
      const full = JSON.parse(readFileSync(reviewFilePath, "utf-8"));
      const fullF = full.findings.find((x) => x.id === finding_id);
      if (fullF) {
        fullF.remediation_status = "re_review_failed";
        fullF.reopen_reason = reason;
        fullF.resolved_at = null;
        atomicWriteJSON(reviewFilePath, full);
      }
    }

    writeQueue(review_type, queue);
    const reopenedCount = queue.findings.filter((x) => x.remediation_status === "re_review_failed").length;
    return {
      content: [{
        type: "text",
        text: [
          `${finding_id} を re_review_failed に差し戻しました。理由: ${reason}`,
          `現在の差し戻し件数: ${reopenedCount} 件`,
          "",
          "再レビュー対象のすべての指摘を判定したら、`review_orchestrate` を呼び出してループを継続してください。",
        ].join("\n"),
      }],
    };
  },
);

// ---- 7. review_get_status ---------------------------------------------------

server.tool(
  "review_get_status",
  "レビューキューの進捗サマリーを返す。review_type 省略時は両方を表示。",
  {
    review_type: z.enum(["general", "security", "all"]).default("all").describe("表示対象"),
  },
  async ({ review_type }) => {
    const types = review_type === "all" ? ["general", "security"] : [review_type];
    const sections = [];

    for (const t of types) {
      const config = getConfig(t);
      const queue = readQueue(t);
      if (!queue) {
        sections.push(`### ${config.label}\nアクティブなセッションなし`);
        continue;
      }
      const counts = countByStatus(queue.findings);
      const blocking = unresolvedCount(queue.findings, config.blockPolicy);
      const policyDesc = config.blockPolicy === "critical_high"
        ? "Critical/High 全解決"
        : "全件解決";

      sections.push([
        `### ${config.label} — ${queue.session_id}`,
        `ステータス: ${queue.status} | ブロック基準: ${policyDesc}`,
        `コミットブロック中: ${blocking > 0 ? `${blocking} 件` : "なし（通過可能）"}`,
        "",
        "| ステータス | 件数 |",
        "|---|---|",
        `| open | ${counts.open} |`,
        `| in_progress | ${counts.in_progress} |`,
        `| resolved | ${counts.resolved} |`,
        `| re_review_failed | ${counts.re_review_failed} |`,
        `| **合計** | **${queue.findings.length}** |`,
      ].join("\n"));
    }

    return { content: [{ type: "text", text: sections.join("\n\n") }] };
  },
);

// ---- 8. re_review_start -----------------------------------------------------

server.tool(
  "re_review_start",
  "resolved 済み指摘を再検証するためのコンテキストを返す。Opus モデルでの再レビュー用。",
  { review_type: reviewTypeSchema },
  async ({ review_type }) => {
    const config = getConfig(review_type);
    const queue = readQueue(review_type);
    if (!queue) return { content: [{ type: "text", text: "キューが空です。" }] };

    const resolved = queue.findings.filter((f) => f.remediation_status === "resolved");
    if (resolved.length === 0) {
      return { content: [{ type: "text", text: "resolved 済みの指摘がありません。先に修正を完了してください。" }] };
    }

    let fullFindings = [];
    const reviewFilePath = join(PROJECT_ROOT, queue.review_file);
    if (existsSync(reviewFilePath)) {
      fullFindings = JSON.parse(readFileSync(reviewFilePath, "utf-8")).findings.filter(
        (f) => f.remediation_status === "resolved",
      );
    }

    const fileContents = {};
    for (const f of fullFindings) {
      const paths = [f.file_path, ...(f.remediation_files ?? [])].filter(Boolean);
      for (const p of paths) {
        if (!fileContents[p]) {
          const content = readProjectFile(p);
          if (content) fileContents[p] = content;
        }
      }
    }

    queue.last_re_review_at = new Date().toISOString();
    writeQueue(review_type, queue);

    const promptFile = review_type === "security" ? SECURITY_PROMPT_FILE : PROMPT_FILE;
    const prompt = existsSync(promptFile) ? readFileSync(promptFile, "utf-8") : "";

    const branch = currentBranchName();
    let diff = "";
    try {
      diff = branchDiff();
    } catch { /* ignore */ }

    return {
      content: [{
        type: "text",
        text: [
          "## モデル指定",
          `この${config.label}の再レビューは **Opus モデル** で実行してください。read-only で修正は行わないでください。`,
          "",
          `## 再レビュー対象: ${config.label} — resolved 済み ${resolved.length} 件`,
          `比較: \`${REVIEW_BASE_BRANCH}...${branch}\``,
          "各指摘の修正が適切に行われたかを再検証してください。",
          "",
          "## レビュープロンプト",
          prompt,
          "",
          "## 修正済み指摘",
          JSON.stringify(fullFindings, null, 2),
          "",
          `## Branch Diff (${REVIEW_BASE_BRANCH}...${branch})`,
          "```diff",
          diff.length > 50000 ? diff.slice(0, 50000) + "\n... (truncated)" : diff,
          "```",
          "",
          "## 現在のファイル内容",
          ...Object.entries(fileContents).map(
            ([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``,
          ),
          "",
          "## 判定指示",
          "各指摘について:",
          "- 修正が適切 → 合格（操作不要）",
          `- 修正が不十分/新たな問題 → \`review_reopen_finding({ review_type: '${review_type}' })\` で差し戻し + 理由を記載`,
          "",
          "## 判定後の自動実行",
          "全指摘の判定が完了したら、`review_orchestrate` を呼び出してループを継続してください。",
          "- 全件合格 → 次のレビュータイプへ進むか、ループ完了",
          "- 不合格あり → 自動的に修正フェーズに戻る",
          "**停止せずにループを継続してください。**",
        ].join("\n"),
      }],
    };
  },
);

// ---- 9. generate_pr_body ----------------------------------------------------

const PR_TEMPLATE = `## 目的
この変更で何を解決するか

## 変更概要
何をどう変えたか

## 設計意図
なぜこの構造にしたか

## 代替案とトレードオフ
何を捨てて何を取ったか

## 影響範囲
どの機能・画面・ジョブ・データに波及するか

## テスト / 検証
実行したコマンド、確認観点、未確認事項
※単体テスト（カバレッジレポートに準じるもの）、ビルド（・静的解析・SAST）・マイグレーション・正常性、がローカルで打確まで通ったことのエビデンスをPRに添付すること

## ロールバック
失敗時にどう戻すか

## AI利用箇所
AIで生成・修正・要約した箇所と、人手で再確認した内容

## リスク分類
A / B / C / D のどれに該当するか
※C（業務上インパクトが高い部分）はAI任せにせず人が検討した、という点を記載`;

server.tool(
  "generate_pr_body",
  "ブランチ間の差分を分析し、PRテンプレートに沿った本文を生成する。gh pr create で使用。",
  {
    base_branch: z.string().max(256).regex(/^[\w.\/-]+$/).default("develop").describe("マージ先ブランチ（デフォルト: develop）"),
  },
  async ({ base_branch }) => {
    const SENSITIVE_PATTERNS = /\.(env|pem|key|p12|pfx|jks|credentials|secret)$/i;
    const execOpts = { cwd: PROJECT_ROOT, encoding: "utf-8" };
    let currentBranch, diffStat, diffContent, commitLog;
    try {
      currentBranch = execFileSync("git", ["branch", "--show-current"], execOpts).trim();
      diffStat = execFileSync("git", ["diff", `${base_branch}...HEAD`, "--stat"], { ...execOpts, maxBuffer: 5 * 1024 * 1024 });
      const changedFiles = execFileSync("git", ["diff", `${base_branch}...HEAD`, "--name-only"], execOpts).trim().split("\n").filter(Boolean);
      const sensitiveFiles = changedFiles.filter((f) => SENSITIVE_PATTERNS.test(f));
      const safeFiles = changedFiles.filter((f) => !SENSITIVE_PATTERNS.test(f));
      if (safeFiles.length > 0) {
        diffContent = execFileSync("git", ["diff", `${base_branch}...HEAD`, "--", ...safeFiles], { ...execOpts, maxBuffer: 10 * 1024 * 1024 });
      } else {
        diffContent = "";
      }
      if (sensitiveFiles.length > 0) {
        diffContent += `\n\n[FILTERED] 機密ファイル ${sensitiveFiles.length} 件を除外しました: ${sensitiveFiles.join(", ")}`;
      }
      commitLog = execFileSync("git", ["log", `${base_branch}..HEAD`, "--oneline", "--no-decorate"], execOpts);
    } catch (e) {
      return { content: [{ type: "text", text: `差分取得エラー: ${e.message}\nbase_branch '${base_branch}' が存在するか確認してください。` }] };
    }

    if (!diffContent.trim()) {
      return { content: [{ type: "text", text: `${base_branch} と HEAD に差分がありません。` }] };
    }

    const reviewFiles = [];
    try {
      const files = readdirSync(FINDINGS_DIR).filter((f) => f.endsWith(".json") && f !== "review-queue.json" && f !== "security-review-queue.json");
      for (const f of files.slice(-3)) {
        const data = JSON.parse(readFileSync(join(FINDINGS_DIR, f), "utf-8"));
        reviewFiles.push({ file: f, total: data.review_metadata?.total_findings ?? 0, severity: data.review_metadata?.severity_summary ?? {} });
      }
    } catch { /* ignore */ }

    return {
      content: [{
        type: "text",
        text: [
          "## PR本文生成指示",
          "",
          `現在のブランチ: ${currentBranch}`,
          `マージ先: ${base_branch}`,
          "",
          "以下の差分情報を分析し、PRテンプレートの各セクションを**具体的に**埋めてください。",
          "テンプレートの見出しはそのまま残し、各セクションの説明文を実際の内容に置き換えてください。",
          "推測で書かず、差分から読み取れる事実に基づいてください。読み取れない項目は「要確認」と明記してください。",
          "",
          "## PRテンプレート",
          PR_TEMPLATE,
          "",
          "## コミット履歴",
          "```",
          commitLog,
          "```",
          "",
          "## 差分サマリー",
          "```",
          diffStat,
          "```",
          "",
          "## 差分（全文）",
          "```diff",
          diffContent.length > 50000 ? diffContent.slice(0, 50000) + "\n... (truncated)" : diffContent,
          "```",
          ...(reviewFiles.length > 0
            ? [
                "",
                "## レビュー実施記録",
                JSON.stringify(reviewFiles, null, 2),
              ]
            : []),
          "",
          "## 出力指示",
          "1. PRテンプレートを埋めた本文を生成してください",
          "2. 生成後、`create_pull_request` ツールを呼び出してPRを発行してください",
        ].join("\n"),
      }],
    };
  },
);

// ---- 10. create_pull_request ------------------------------------------------

server.tool(
  "create_pull_request",
  "gh pr create で GitHub にプルリクエストを発行する。generate_pr_body で生成した本文を使用。",
  {
    title: z.string().max(256).describe("PRタイトル"),
    body: z.string().max(100000).describe("PR本文（テンプレートを埋めたもの）"),
    base_branch: z.string().max(256).regex(/^[\w.\/-]+$/).default("develop").describe("マージ先ブランチ"),
    draft: z.boolean().default(false).describe("ドラフトPRとして作成するか"),
  },
  async ({ title, body, base_branch, draft }) => {
    const execOpts = { cwd: PROJECT_ROOT, encoding: "utf-8", stdio: "pipe" };
    try {
      execFileSync("git", ["push", "-u", "origin", "HEAD"], execOpts);
    } catch (e) {
      return { content: [{ type: "text", text: `git push に失敗しました: ${e.stderr || e.message}` }], isError: true };
    }

    const args = ["pr", "create", "--base", base_branch, "--title", title, "--body", body];
    if (draft) args.push("--draft");

    try {
      const result = execFileSync("gh", args, execOpts);
      return {
        content: [{
          type: "text",
          text: `PR を作成しました:\n${result.trim()}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `gh pr create に失敗しました: ${e.stderr || e.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
