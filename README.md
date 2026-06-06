# 健康ルーティーン管理ツール — Cloudflare デプロイ手順

## 必要なもの（すべて無料）

| ツール | 用途 |
|--------|------|
| Cloudflareアカウント | Workers / D1のホスティング |
| GitHubアカウント | コードの置き場所 + CI/CD |
| Node.js（ローカル） | 初回セットアップのみ |

---

## STEP 1 — Node.js と Wrangler をインストール

```bash
# Node.js (https://nodejs.org) をインストール後:
npm install -g wrangler

# Cloudflareにログイン（ブラウザが開く）
wrangler login
```

---

## STEP 2 — D1データベースを作成

```bash
# データベースを作成（名前は health-tracker-db 固定）
wrangler d1 create health-tracker-db
```

出力例:
```
✅ Successfully created DB 'health-tracker-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

この `database_id` をコピーして `wrangler.toml` の該当行に貼り付ける:

```toml
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← ここ
```

---

## STEP 3 — テーブルを作成

```bash
# ローカルのDBにテーブルを作成（確認用）
wrangler d1 execute health-tracker-db --local --file=schema.sql

# 本番DBにも反映
wrangler d1 execute health-tracker-db --remote --file=schema.sql
```

---

## STEP 4 — GitHubリポジトリを作成してpush

```bash
git init
git add .
git commit -m "initial commit"

# GitHubで新規リポジトリを作成後:
git remote add origin https://github.com/あなたのユーザー名/health-tracker.git
git branch -M main
git push -u origin main
```

---

## STEP 5 — GitHub Secrets に APIトークンを登録

1. Cloudflareダッシュボード → 右上アイコン → **My Profile**
2. **API Tokens** → **Create Token**
3. テンプレート「**Edit Cloudflare Workers**」を選択 → 作成
4. トークン文字列をコピー

5. GitHubリポジトリ → **Settings** → **Secrets and variables** → **Actions**
6. **New repository secret** をクリック
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: 上でコピーしたトークン

7. 同じ画面で、CloudflareのアカウントIDも登録
   - Name: `CLOUDFLARE_ACCOUNT_ID`
   - Value: Cloudflareダッシュボード右側などに表示される Account ID

---

## STEP 6 — 自動デプロイ確認

GitHubのリポジトリページ → **Actions** タブを開く。
緑のチェックマークが付けばデプロイ完了。

デプロイ後のURL:
```
https://health-tracker.あなたのサブドメイン.workers.dev
```

このURLをスマホのホーム画面に追加すればアプリとして使える。

---

## Gemini伴走相談を使う場合

「伴走相談」タブを使うには、Cloudflare WorkerにGemini APIキーをSecretとして登録します。

1. Google AI StudioなどでGemini APIキーを作成
2. Cloudflareダッシュボード → **Workers & Pages** → **health-tracker**
3. **Settings** → **Variables and Secrets**
4. **Add** → **Secret** を選択
5. 以下を登録
   - Name: `GEMINI_API_KEY`
   - Value: 作成したGemini APIキー
6. 保存後、必要に応じてGitHub Actionsを再実行

標準では `gemini-1.5-flash` を使います。モデル名を変えたい場合は、あとでWorkerの環境変数 `GEMINI_MODEL` を追加してください。

この機能は診断や治療判断ではなく、記録に基づく生活改善の整理を目的にしています。異常値や症状がある場合は医師に相談してください。

---

## 日常的な使い方

コードを変更したい場合は `git push origin main` するだけで自動デプロイされる。

```bash
# 例: index.htmlを編集後
git add public/index.html
git commit -m "update UI"
git push origin main
# → GitHub Actionsが自動でCloudflareにデプロイ
```

---

## データのバックアップ

アプリ内の「設定・保存」→「JSONでエクスポート」でローカルにバックアップできる。

D1から直接バックアップする場合:
```bash
wrangler d1 export health-tracker-db --remote --output=backup.sql
```

---

## 料金

| リソース | 無料枠 | このアプリの想定使用量 |
|----------|--------|----------------------|
| Workers リクエスト | 10万/日 | ~100/日 → **問題なし** |
| D1 読み取り | 500万/日 | ~500/日 → **問題なし** |
| D1 書き込み | 10万/日 | ~50/日 → **問題なし** |
| D1 ストレージ | 5GB | ~1MB/年 → **問題なし** |

**実質完全無料で運用できる。**
