<meta>
description: ブランチ差分を分析し、テンプレートに沿ったPRを自動発行する
argument-hint: [base-branch (default: develop)]
</meta>

# PR 自動発行

<background_information>
- **Mission**: 現在のブランチとマージ先ブランチの差分を分析し、PRテンプレートに沿った本文を生成して GitHub にプルリクエストを発行する。
- **Success Criteria**: テンプレートの全セクションが差分に基づいて具体的に記載され、`gh pr create` でPRが発行される。
</background_information>

## 手順

1. MCP ツール `generate_pr_body` を呼び出す。引数にユーザーが指定した base_branch を渡す（未指定なら develop）。
2. 返されたブランチ間差分・コミット履歴・レビュー記録を分析する。
3. PRテンプレートの各セクションを **差分から読み取れる事実** に基づいて埋める。推測で書かず、読み取れない項目は「要確認」と記載する。
4. PRタイトルを差分の主な変更内容から簡潔に生成する。
5. MCP ツール `create_pull_request` を呼び出してPRを発行する。
6. 発行されたPR URLをユーザーに報告する。

## 注意事項
- `gh auth login` が未実施の場合はユーザーに認証を依頼する。
- push できない場合はエラーメッセージを表示する。
- レビュー記録（review-findings/）がある場合はテスト/検証セクションに反映する。
