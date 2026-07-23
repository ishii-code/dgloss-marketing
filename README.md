# dgloss-marketing 問い合わせ流入分析ツール

会社への問い合わせが「どこから来ているか」を可視化・分析する単独 Web アプリ。
チャネル / 参照元(UTM) / キャンペーン / 流入元ページ / 業種 / 地域 / 月次推移 /
対応ステータス（新規→対応中→成約/失注）を1画面で集計表示する。

- スタック: Express + PostgreSQL(Supabase) + バニラJS ダッシュボード
- デプロイ: Vercel（`api/index.ts` がサーバーレス関数）
- 認証: 共通パスワードによるログイン（受信APIはトークンで別途保護）

## セットアップ（ローカル）

```bash
npm install
cp .env.example .env   # 値を編集
npm run server         # http://localhost:3000
```

### 必要な環境変数（最低限）

| 変数 | 用途 |
|---|---|
| `SUPABASE_DATABASE_URL` または `DATABASE_URL` | Postgres 接続文字列 |
| `DASHBOARD_PASSWORD` | ダッシュボード閲覧パスワード |
| `AUTH_SECRET` | セッションCookieの署名鍵（32文字以上推奨） |
| `INQUIRY_INGEST_TOKEN` | 問い合わせ受信を有効化するトークン（計測タグの `data-token` と同じ値） |
| `INQUIRY_OWN_DOMAIN` | 自社ドメイン（既定 `dgloss.co.jp`。ここからのリファラは「直接」扱い） |

## データの入れ方（2通り）

1. **計測タグをサイトに設置（推奨・自動計測）**
   - `INQUIRY_INGEST_TOKEN` を設定。
   - ダッシュボード下部の **計測タグの設置** に表示されるスニペットを、問い合わせフォームの
     ページ（例 `dgloss.co.jp/contact/`）に貼るだけ。UTM・リファラ・ランディングページを
     自動取得し、フォーム送信時に送信する（`public/inquiry-tracker.js`）。
   - 氏名・メール等を送信したくない場合はタグに `data-collect-fields="false"` を追加。

2. **CSV 一括取込（過去分のバックフィル）**
   - ダッシュボードの **CSV 取込** にCSVを貼り付け／ファイル選択で一括登録。
   - 対応ヘッダ（日本語可）: `received_at/日時`, `channel/流入元`, `utm_source/参照元`,
     `utm_campaign/キャンペーン`, `company/会社名`, `email/メール`, `industry/業種`,
     `region/地域`, `status/対応状況`, `message/内容` など。

## 流入チャネルの自動判定

UTM とリファラから `検索(自然) / 検索広告 / SNS / 他サイト・紹介 / 直接・不明 /
メール / 電話 / イベント / その他` を自動分類（`src/inquiries.ts` の `deriveChannel`）。
`channel` を明示指定した場合はそれを優先。

## API

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| POST | `/api/inquiries/ingest` | インジェストトークン | フォーム/計測タグからの受信（公開・CORS対応） |
| POST | `/api/login` / `/api/logout` | — | ログイン / ログアウト |
| GET | `/api/inquiries/summary` | ログイン | 集計サマリ（各軸＋月次） |
| GET | `/api/inquiries` | ログイン | 一覧（期間・チャネル・ステータスで絞込） |
| PATCH | `/api/inquiries/:id` | ログイン | ステータス/担当/業種/地域の更新 |
| DELETE | `/api/inquiries/:id` | ログイン | 削除 |
| POST | `/api/inquiries/import` | ログイン | CSV一括取込 |
| GET | `/api/inquiries/config` | ログイン | 計測タグ設置情報 |

## Vercel デプロイ

1. GitHub 連携で本リポジトリを Vercel にインポート。
2. 環境変数（上表）を設定。
3. Build Command / Output は `vercel.json` に定義済み。全リクエストは `api/index` に集約される。
