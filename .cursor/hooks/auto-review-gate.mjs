import { buildLoopStatus, hasStagedSourceCode } from "./review-shared.mjs";

function buildNextAction(statuses) {
  const lines = [];
  lines.push("## レビュー自動ループ — 現在の状態");
  lines.push("");

  for (const s of statuses) {
    lines.push(`### ${s.label} (${s.type})`);
    if (s.counts) {
      lines.push(`  open: ${s.counts.open} | in_progress: ${s.counts.in_progress} | resolved: ${s.counts.resolved} | re_review_failed: ${s.counts.re_review_failed} | total: ${s.total}`);
    }
    switch (s.phase) {
      case "not_started":
        lines.push("  状態: 未実施");
        break;
      case "needs_fix":
        lines.push(`  状態: 未修正の指摘あり (ブロック中: ${s.blocking} 件)`);
        break;
      case "re_review_failed_needs_fix":
        lines.push(`  状態: 再レビューで不合格 (${s.counts.re_review_failed} 件)`);
        break;
      case "needs_re_review":
        lines.push("  状態: 全ブロック指摘が resolved — 再レビュー待ち");
        break;
      case "completed":
        lines.push("  状態: 完了 ✓");
        break;
    }
    lines.push("");
  }

  const notStarted = statuses.filter((s) => s.phase === "not_started");
  const needsFix = statuses.filter((s) => s.phase === "needs_fix" || s.phase === "re_review_failed_needs_fix");
  const needsReReview = statuses.filter((s) => s.phase === "needs_re_review");

  lines.push("## 今すぐ実行するアクション");

  if (notStarted.length > 0) {
    const first = notStarted[0];
    if (first.type === "general") {
      lines.push("MCP ツール `review_start` を呼び出してレビューを実行し、結果を `review_save_findings({ review_type: 'general' })` で保存してください。");
    } else {
      lines.push("MCP ツール `security_review_start` を呼び出してレビューを実行し、結果を `review_save_findings({ review_type: 'security' })` で保存してください。");
    }
  } else if (needsFix.length > 0) {
    const first = needsFix[0];
    const statusFilter = first.phase === "re_review_failed_needs_fix" ? "re_review_failed" : "open";
    lines.push(`MCP ツール \`review_list_findings({ review_type: '${first.type}', status: '${statusFilter}' })\` を呼び出し、各指摘を修正してください。`);
    lines.push(`修正フロー: \`review_claim_finding\` → コード修正 → \`review_resolve_finding\` を各指摘に対して繰り返す。`);
  } else if (needsReReview.length > 0) {
    const first = needsReReview[0];
    lines.push(`MCP ツール \`re_review_start({ review_type: '${first.type}' })\` を呼び出して再レビューを実行してください。`);
  }

  lines.push("");
  lines.push("各アクション完了後は `review_orchestrate` を呼び出して次のステップを取得してください。");
  lines.push("ループが完了するまで停止しないでください。各フェーズを自動的に連続実行してください。");

  return lines.join("\n");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

if (!hasStagedSourceCode()) {
  process.stdout.write(JSON.stringify({}));
} else {
  const statuses = buildLoopStatus();
  const allCompleted = statuses.every((s) => s.phase === "completed");

  if (allCompleted) {
    process.stdout.write(JSON.stringify({}));
  } else {
    const nextAction = buildNextAction(statuses);
    process.stdout.write(
      JSON.stringify({
        permission: "deny",
        user_message: "コミット前レビューゲート: レビュー未完了のためブロックし、自動ループを開始します。",
        agent_message: [
          "git commit がフックによりブロックされました。",
          "",
          nextAction,
        ].join("\n"),
      }),
    );
  }
}
