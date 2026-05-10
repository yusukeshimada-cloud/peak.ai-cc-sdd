# Qiita-style Information Sharing App

Qiita を模擬した情報共有アプリです。ユーザー登録・認証・記事・コメント・帳票出力・退会・論理削除ユーザー実削除バッチを提供します。

## 必要なツール

- **Docker** および **Docker Compose**（DB 起動用）
- **Java 17** 以上
- **Gradle 8.x** 以上（またはプロジェクトの `./gradlew` を使用。未作成の場合は `gradle wrapper` で生成）

## 構築手順

### 1. リポジトリのクローン

```bash
git clone <repository-url>
cd 05_cc-sdd_specs分割
```

### 2. データベースの起動

プロジェクトルートで以下を実行し、PostgreSQL を起動します。

```bash
docker compose up -d
```

接続設定は `.env.example` を `.env` にコピーして `DB_PASSWORD=<REPLACE_ME>` を強力なパスワードに置き換えてください（INFRA-011: ハードコードされた資格情報は使用しないこと）。

### 3. アプリケーションの起動

```bash
cd backend
./gradlew bootRun
```

Windows の場合は:

```bash
cd backend
gradlew.bat bootRun
```

API は `http://localhost:8080` で利用できます。

### 4. フロントエンドの起動（画面を開く場合）

バックエンド起動後、別ターミナルで以下を実行します。

```bash
cd frontend
npm install
npm run dev
```

ブラウザで **http://localhost:5173** を開くと、記事一覧・ログイン・投稿・コメント・プロフィール・退会などの画面を利用できます。フロントエンドは開発サーバー経由でバックエンド API（`http://localhost:8080`）にプロキシするため、バックエンドを先に起動しておいてください。

### 5. 動作確認

- ヘルス: `GET http://localhost:8080/actuator/health`
- ユーザー登録: `POST http://localhost:8080/api/auth/register`（JSON: loginId, password, displayName）
- ログイン: `POST http://localhost:8080/api/auth/login`（JSON: loginId, password）

## すべて停止する手順

起動の逆の順で止めます（フロントエンド → バックエンド → DB）。先に DB を止めるとバックエンドが接続エラーになるため、この順で実行してください。

### 1. フロントエンドを止める

フロントエンドの開発サーバー（`npm run dev`）を実行しているターミナルで:

- **Ctrl + C** を押してプロセスを終了する

### 2. バックエンドを止める

バックエンド（`./gradlew bootRun` または `gradlew.bat bootRun`）を実行しているターミナルで:

- **Ctrl + C** を押してプロセスを終了する

（Gradle の場合は続けて `Stop` を選ぶか、もう一度 Ctrl+C で終了します。）

### 3. DB（Docker）を止める

プロジェクトルートで以下を実行し、PostgreSQL コンテナを停止・削除します。

```bash
docker compose down
```

コンテナだけ止めて名前付きボリューム（データ）を残す場合は `docker compose stop` でも構いません。`down` はコンテナ削除まで行いますが、ボリュームは既定で残ります。

---

| 順番 | 対象 | 操作 |
|------|------|------|
| 1 | フロントエンド | 該当ターミナルで **Ctrl+C** |
| 2 | バックエンド | 該当ターミナルで **Ctrl+C** |
| 3 | DB | プロジェクトルートで **`docker compose down`** |

## テストの実行

```bash
cd backend
./gradlew test
```

## バッチの実行（論理削除ユーザー実削除）

日次で実行する想定です。アプリ起動中にスケジュールで動作するほか、手動実行用のエンドポイントを用意しています（運用ポリシーに応じて無効化可能）。

```bash
# アプリ起動後、手動実行する場合（例）
curl -X POST http://localhost:8080/api/admin/purge-deleted-users \
  -H "Cookie: JSESSIONID=<session-id>"
```

## 技術スタック

| レイヤー | 技術 | バージョン目安 | 備考 |
|----------|------|----------------|------|
| フロントエンド | React | 18.x | UI ライブラリ |
| | TypeScript | 5.x | 型付け |
| | Vite | 5.x | ビルド・開発サーバー |
| | React Router | 6.x | ルーティング |
| バックエンド | Java | 17+ | 言語 |
| | Spring Boot | 3.2.x | Web / JPA / Security / Actuator |
| | Spring Security | セッション認証（Cookie） | フォームログイン無効、REST 用 |
| データ | PostgreSQL | 15 | Docker で起動 |
| | Flyway | 9.x | マイグレーション（Spring Boot 管理） |
| | Spring Data JPA | - | 永続化 |
| バッチ | Spring Scheduling | - | 論理削除ユーザー実削除（cron） |
| その他 | Docker Compose | - | DB コンテナ |
| | Gradle | 8.5 | バックエンドビルド |
| | npm | - | フロントエンドパッケージ管理 |

設計上のレイヤー・コンポーネント対応は `.kiro/specs/qiita-style-info-sharing-app/design.md` の「Technology Stack」を参照してください。

## 構成

- **backend**: Spring Boot アプリ（REST API、Flyway マイグレーション、バッチ）
- **frontend**: React + TypeScript + Vite の SPA（記事一覧・詳細・作成・編集・コメント・プロフィール・退会・CSV 出力）
- **docker-compose.yml**: PostgreSQL コンテナ定義
- **DB マイグレーション**: `backend/src/main/resources/db/migration/` を Flyway が管理

詳細な API 仕様は `.kiro/specs/qiita-style-info-sharing-app/design.md` を参照してください。

## AI レビュー自動化（Cursor Hook + MCP サーバー）

本ブランチでは、`git commit` 時に AI レビュー（通常レビュー＋セキュリティレビュー）を自動実行し、未解決の指摘がある間はコミットをブロックする仕組みを導入しています。

### 概要

| コンポーネント | 役割 |
|---|---|
| **MCP review-server** | レビュー状態の管理・オーケストレーション（Node.js） |
| **Cursor Hook（beforeShellExecution）** | `git commit` をインターセプトしレビュー未完了ならブロック |
| **Cursor Hook（stop）** | エージェント停止時にループ未完了なら続行指示 |
| **Husky pre-commit** | サードパーティ Git クライアント向けコミットゲート |
| **Husky post-commit** | コミット成功後にステータスファイルを自動削除 |

### コミットフロー

```
git commit
  ├─ [Cursor] auto-review-gate.mjs
  │    ├─ ステータスファイルなし/未完了 → ブロック → 次アクションを即座に指示
  │    └─ 両方 completed → 通過
  ├─ [Husky] pre-commit
  │    ├─ ステータスファイルなし → ブロック
  │    ├─ 未解決指摘あり → ブロック
  │    └─ 全条件クリア → 通過
  └─ コミット成功
       └─ [Husky] post-commit → ステータスファイル削除
            → 次回コミットは新しいレビューが必須
```

### レビュー対象（差分の取得方法）

レビューは **ベースブランチと現在のブランチの全ファイル差分** を対象とします（staged 変更ではなくブランチ間差分）。

```
git diff develop...HEAD
```

デフォルトのベースブランチは `develop` です。変更するには `.cursor/mcp.json` の環境変数を編集してください。

```json
{
  "mcpServers": {
    "review-server": {
      "command": "node",
      "args": ["05_cc-sdd_specs分割/.cursor/mcp-review-server/server.mjs"],
      "env": {
        "REVIEW_BASE_BRANCH": "main"
      }
    }
  }
}
```

変更後は Cursor を再起動して MCP サーバーを再読み込みしてください。

### ブロック基準

| レビュー種別 | ブロック解除条件 |
|---|---|
| 通常レビュー | Critical / High がすべて resolved |
| セキュリティレビュー | 全 severity（Low 含む）がすべて resolved |

### レビュースキップ条件

staged ファイルにソースコードが **1 つも含まれない場合** はレビューをスキップし、そのままコミットが通過します。ドキュメントや画像のみの変更を素早くコミットできます。

**ソースコードと判定される拡張子**:

`.java`, `.kt`, `.scala`, `.groovy`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rb`, `.go`, `.rs`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.swift`, `.vue`, `.svelte`, `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`, `.sql`, `.sh`, `.bash`, `.zsh`, `.properties`, `.yml`, `.yaml`, `.xml`, `.gradle`, `.toml`, `.graphql`, `.proto`

**ソースコードと判定されるファイル名**:

`Dockerfile`, `Makefile`, `Jenkinsfile`, `Vagrantfile`, `Rakefile`, `Gemfile`

上記に該当しないファイル（`.md`, `.txt`, `.png`, `.jpg`, `.json`, `.csv` 等）のみの変更ではレビューが不要です。

### セットアップ手順

#### 1. Node.js 依存パッケージのインストール

プロジェクトルート（リポジトリ直下）で実行します。Husky と MCP SDK がインストールされます。

```bash
npm install
```

#### 2. Husky の有効化

```bash
npx husky install
```

> Git の `core.hooksPath` が `.husky` に設定され、`pre-commit` / `post-commit` フックが有効になります。

#### 3. MCP サーバーの依存パッケージインストール

```bash
cd 05_cc-sdd_specs分割/.cursor/mcp-review-server
npm install
cd ../../..
```

#### 4. Cursor の MCP サーバー登録確認

`.cursor/mcp.json` に以下の設定が含まれていることを確認してください（リポジトリに同梱済み）。

```json
{
  "mcpServers": {
    "review-server": {
      "command": "node",
      "args": ["05_cc-sdd_specs分割/.cursor/mcp-review-server/server.mjs"]
    }
  }
}
```

Cursor を開いた状態で **MCP サーバーが認識されていない場合**、Cursor を再起動してください。

#### 5. Cursor Hook の確認

`.cursor/hooks.json` がリポジトリに同梱済みです。以下のフックが登録されていることを確認してください。

- `beforeShellExecution`: `git commit` 時に `auto-review-gate.mjs` を実行
- `stop`: エージェント停止時に `review-loop-continue.mjs` を実行

#### 6. 動作確認

```bash
# ステータスファイルがない状態でコミットを試行 → ブロックされることを確認
git add -A
git commit -m "test"
# → 「レビュー未実施: コミットをブロックしました」と表示されれば成功

# Cursor チャットで review_orchestrate を実行してレビューループを開始
```

### ファイル構成

```
.cursor/
├── hooks.json                    # Cursor Hook 定義
├── hooks/
│   ├── auto-review-gate.mjs      # git commit ブロック + 次アクション指示
│   ├── review-loop-continue.mjs  # stop 時のループ継続判定
│   ├── review-shared.mjs         # 共通ロジック（状態判定等）
│   └── block-dangerous-shell.mjs # 危険コマンドブロック
├── mcp.json                      # MCP サーバー登録
.husky/
├── pre-commit                    # サードパーティ Git クライアント向けゲート
├── post-commit                   # コミット成功後ステータス削除
05_cc-sdd_specs分割/
├── .cursor/
│   ├── mcp-review-server/
│   │   ├── server.mjs            # MCP サーバー本体
│   │   ├── server.test.mjs       # ユニットテスト
│   │   ├── review-prompt.md      # 通常レビュープロンプト
│   │   ├── security-review-prompt.md # セキュリティレビュープロンプト
│   │   └── package.json
│   └── commands/
│       └── pr/create.md          # /pr create コマンド定義
├── review-findings/              # ステータスファイル（git管理外）
│   ├── review-queue.json
│   └── security-review-queue.json
```

### MCP ツール一覧

| ツール名 | 用途 |
|---|---|
| `review_orchestrate` | レビューループの状態判定と次アクション指示 |
| `review_start` | 通常レビューの開始（staged diff + プロンプト） |
| `security_review_start` | セキュリティレビューの開始 |
| `review_save_findings` | レビュー結果の保存 |
| `review_list_findings` | 指摘一覧の取得 |
| `review_claim_finding` | 指摘の修正開始マーク |
| `review_resolve_finding` | 指摘の修正完了マーク |
| `review_reopen_finding` | 再レビュー不合格の差し戻し |
| `re_review_start` | 再レビューの開始 |
| `review_gate` | コミット可否の判定 |
| `review_get_status` | レビュー進捗サマリー |
| `generate_pr_body` | ブランチ差分からPR本文を生成 |
| `create_pull_request` | GitHub PR の発行 |

### トラブルシューティング

| 症状 | 対処 |
|---|---|
| MCP ツールが見つからない | Cursor を再起動して MCP サーバーを再読み込み |
| `npm install` でエラー | Node.js 18 以上がインストールされているか確認 |
| Husky フックが動かない | `npx husky install` を再実行、`.husky/pre-commit` に実行権限があるか確認（`chmod +x .husky/pre-commit .husky/post-commit`） |
| レビュー完了後もコミットがブロックされる | `review_orchestrate` を呼び出して状態を確認。MCP サーバーのコード変更後は Cursor 再起動が必要 |

## プルリクエスト自動発行（Cursor コマンド + MCP ツール）

ブランチ間の差分とコミット履歴を分析し、所定のテンプレートに沿った PR 本文を自動生成して GitHub に発行する仕組みです。

### 前提条件

- **GitHub CLI (`gh`)** がインストール済みで認証が完了していること

```bash
gh auth login
gh auth status   # 認証状態を確認
```

- リモートリポジトリに push 可能な権限があること

### 使い方

Cursor チャットで `/pr create` コマンドを実行します。

```
/pr create              # マージ先: develop（デフォルト）
/pr create main         # マージ先: main を指定
```

コマンドは以下の手順を自動的に実行します。

1. `generate_pr_body` で差分・コミット履歴・レビュー記録を収集
2. PR テンプレートの各セクションを差分の事実に基づいて記入
3. `create_pull_request` でブランチを push し `gh pr create` を実行
4. 発行された PR URL を表示

### PR テンプレート

生成される PR 本文は以下のセクションで構成されます。

| セクション | 記載内容 |
|---|---|
| **目的** | この変更で何を解決するか |
| **変更概要** | 何をどう変えたか |
| **設計意図** | なぜこの構造にしたか |
| **代替案とトレードオフ** | 何を捨てて何を取ったか |
| **影響範囲** | どの機能・画面・ジョブ・データに波及するか |
| **テスト / 検証** | 実行したコマンド、確認観点、未確認事項 |
| **ロールバック** | 失敗時にどう戻すか |
| **AI利用箇所** | AIで生成・修正・要約した箇所と、人手で再確認した内容 |
| **リスク分類** | A / B / C / D のどれに該当するか |

差分から読み取れない項目は「要確認」と記載されます。`review-findings/` にレビュー記録がある場合は、テスト / 検証セクションに自動反映されます。

### MCP ツール詳細

| ツール | 引数 | 説明 |
|---|---|---|
| `generate_pr_body` | `base_branch`（デフォルト: `develop`） | 差分・コミット履歴・レビュー記録を収集し、テンプレート記入指示を返す。機密ファイル（`.env`, `.pem` 等）の差分内容は自動除外される |
| `create_pull_request` | `title`, `body`, `base_branch`, `draft` | `git push -u origin HEAD` 実行後に `gh pr create` でPRを発行する。`draft: true` でドラフトPR作成が可能 |

### PR 発行のトラブルシューティング

| 症状 | 対処 |
|---|---|
| `gh: command not found` | GitHub CLI をインストール: `sudo apt install gh`（Ubuntu）/ `brew install gh`（macOS） |
| `gh auth login` を求められる | `gh auth login` で認証を完了させる |
| `git push` に失敗する | リモートリポジトリへの push 権限を確認。SSH 鍵または HTTPS トークンの設定を見直す |
| 差分が空と表示される | `base_branch` が正しいか確認。`git log develop..HEAD` でコミット差分が存在するか確認 |

---

## セキュリティ要件（INFRA-026）

### TLS 戦略

本アプリケーションは **TLS をリバースプロキシ層（Nginx / AWS ALB 等）で終端** する設計です。

| 区間 | 暗号化 | 備考 |
|------|--------|------|
| クライアント → リバースプロキシ | TLS 1.2 以上必須 | Nginx/ALB で Let's Encrypt 等の証明書を使用 |
| リバースプロキシ → backend | HTTP（内部ネットワーク） | Docker ネットワーク / VPC 内通信のため許容 |
| リバースプロキシ → DB | - | 直接通信なし |

本番環境では以下を必ず設定すること:

1. **HSTS ヘッダー**: Spring Security で `Strict-Transport-Security: max-age=31536000; includeSubDomains` を設定済み（`SecurityConfig.java`）。
2. **Secure Cookie**: `server.servlet.session.cookie.secure=true`（`application-prod.yml` で強制）。
3. **CORS**: `CORS_ALLOWED_ORIGINS` 環境変数で本番オリジンを明示指定（ワイルドカード禁止）。

### その他のセキュリティ設定

- **CSRF 保護**: `CookieCsrfTokenRepository.withHttpOnlyFalse()` で SPA 向けに設定済み。
- **レート制限**: ログインエンドポイントに IP ベースのレート制限（デフォルト: 60秒内5回）。
- **セッション管理**: 30分アイドルタイムアウト、ログイン時にセッションを再生成。
- **セキュリティヘッダー**: CSP / X-Frame-Options / HSTS / Referrer-Policy 等を設定済み。
