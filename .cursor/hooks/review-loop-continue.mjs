import { REVIEW_TYPES, readQueue, unresolvedCount } from "./review-shared.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const incomplete = [];

for (const [type, config] of Object.entries(REVIEW_TYPES)) {
  const queue = readQueue(config.queueFile);
  if (!queue || queue.status === "completed") continue;
  const blocking = unresolvedCount(queue.findings, config.blockPolicy);
  if (blocking > 0) {
    incomplete.push(`${config.label}: 未解決 ${blocking} 件`);
  }
}

if (incomplete.length === 0) {
  process.stdout.write(JSON.stringify({}));
} else {
  process.stdout.write(
    JSON.stringify({
      decision: "continue",
      reason: [
        "レビューループが未完了です。以下の未解決指摘が残っています:",
        ...incomplete.map((s) => `  - ${s}`),
        "",
        "MCP ツール `review_orchestrate` を呼び出して、レビュー→修正→再レビューのループを継続してください。",
        "ループが完了するまで停止しないでください。",
      ].join("\n"),
    }),
  );
}
