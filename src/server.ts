// dgloss-marketing 問い合わせ流入分析 サーバ（Express）。
// - 公開: /api/inquiries/ingest（計測タグ/フォームからの受信・トークン認証・CORS）
// - 認証(共通パスワード): 集計・一覧・更新・CSV取込・設定
// - / でダッシュボード HTML、/inquiry-tracker.js で計測タグを配信。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import { hasDbConfigured, getPool } from './db.js';
import {
  initInquirySchema,
  insertInquiry,
  listInquiries,
  getInquirySummary,
  updateInquiry,
  deleteInquiry,
  parseCsv,
  csvRowsToInputs,
  INQUIRY_CHANNELS,
  INQUIRY_CHANNEL_LABELS,
  INQUIRY_STATUSES,
  INQUIRY_STATUS_LABELS,
  type InquiryStatus,
} from './inquiries.js';
import {
  checkPassword,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  getSessionToken,
  verifyToken,
} from './auth.js';

// --- 最小 .env ローダ（依存を増やさない） ---
function loadEnv(): void {
  try {
    const txt = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* .env が無ければ環境変数のみ使用 */ }
}
loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERCEL = !!process.env.VERCEL;

function str(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function loadFile(rel: string): string {
  const candidates = [
    join(__dirname, '../public', rel),
    join(process.cwd(), 'public', rel),
    join(process.cwd(), 'dist/public', rel),
  ];
  for (const p of candidates) {
    try { return readFileSync(p, 'utf-8'); } catch { /* try next */ }
  }
  return '';
}
const DASHBOARD_HTML = loadFile('dashboard.html') || '<!doctype html><h1>dashboard.html not found</h1>';
const TRACKER_JS = loadFile('inquiry-tracker.js') || '/* inquiry-tracker.js not found */';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));

// ---- ヘルス / DB診断 ----
// DB接続を実際に試し、失敗時は原因メッセージ(db_error)とヒント(hint)を返す。
// ブラウザで /api/health を開けば、ログを掘らなくてもDBの不調原因が分かる。
app.get('/api/health', async (_req, res) => {
  let db_connected = false;
  let db_error: string | null = null;
  let hint: string | null = null;
  if (!hasDbConfigured()) {
    db_error = 'SUPABASE_DATABASE_URL / DATABASE_URL が未設定です';
  } else {
    try {
      await getPool().query('SELECT 1');
      db_connected = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db_error = msg.slice(0, 300);
      if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) hint = '接続先が見つかりません。Supabaseの「直接接続(db.xxx.supabase.co)」ではなく「Transaction pooler(...pooler.supabase.com:6543)」のURLに変えてください。';
      else if (/password authentication failed/i.test(msg)) hint = 'パスワードが違います。接続URLの [YOUR-PASSWORD] を実際のDBパスワードに置換したか確認（記号入りはURLエンコードが必要）。';
      else if (/Tenant or user not found/i.test(msg)) hint = 'poolerのユーザー名が違います。postgres.<プロジェクトID> の形（例 postgres.krsnvjuxzfscaenkrvoc）か確認してください。';
      else if (/SASL|SCRAM|client password must be a string/i.test(msg)) hint = 'パスワードが空か不正です。接続URLにパスワードが入っているか確認してください。';
      else if (/self-signed|certificate/i.test(msg)) hint = 'SSL証明書エラー。DATABASE_SSL=true を設定してみてください。';
    }
  }
  res.status(db_connected ? 200 : 503).json({ ok: true, db_connected, db_error, hint, time: new Date().toISOString() });
});

// ---- ログイン（共通パスワード） ----
const loginHits = new Map<string, { count: number; resetAt: number }>();
function clientIp(req: Request): string {
  return (req.header('x-forwarded-for') || '').split(',')[0]?.trim() || req.ip || 'unknown';
}
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = loginHits.get(ip);
  if (!e || e.resetAt < now) { loginHits.set(ip, { count: 1, resetAt: now + 15 * 60_000 }); return false; }
  e.count++;
  return e.count > 10;
}

app.post('/api/login', (req, res) => {
  if (loginRateLimited(clientIp(req))) { res.status(429).json({ error: 'ログイン試行が多すぎます。しばらく待って再試行してください' }); return; }
  const body = (req.body ?? {}) as { password?: unknown };
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!process.env.DASHBOARD_PASSWORD) { res.status(503).json({ error: 'DASHBOARD_PASSWORD が未設定です' }); return; }
  if (!checkPassword(pw)) { res.status(401).json({ error: 'パスワードが違います' }); return; }
  setSessionCookie(res, issueToken());
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ authenticated: verifyToken(getSessionToken(req)) }); });

// ---- 問い合わせ受信（公開・トークン認証・CORS） ----
const INGEST_RL_WINDOW_MS = 60_000;
const INGEST_RL_MAX = 60;
const ingestHits = new Map<string, { count: number; resetAt: number }>();
function ingestRateLimited(ip: string): boolean {
  const now = Date.now();
  const e = ingestHits.get(ip);
  if (!e || e.resetAt < now) { ingestHits.set(ip, { count: 1, resetAt: now + INGEST_RL_WINDOW_MS }); return false; }
  e.count++;
  return e.count > INGEST_RL_MAX;
}
function applyIngestCors(req: Request, res: Response): void {
  const allow = (process.env.INQUIRY_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.header('origin') || '';
  if (allow.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

app.options('/api/inquiries/ingest', (req, res) => { applyIngestCors(req, res); res.status(204).end(); });

app.post('/api/inquiries/ingest', async (req, res) => {
  applyIngestCors(req, res);
  const expected = process.env.INQUIRY_INGEST_TOKEN;
  if (!expected) { res.status(503).json({ error: 'ingest disabled: INQUIRY_INGEST_TOKEN 未設定' }); return; }
  if (ingestRateLimited(clientIp(req))) { res.status(429).json({ error: 'too many requests' }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = req.header('x-ingest-token') || (typeof body.token === 'string' ? body.token : '');
  if (token !== expected) { res.status(401).json({ error: 'invalid ingest token' }); return; }

  try {
    await ensureSchema();
    const row = await insertInquiry({
      received_at: typeof body.received_at === 'string' ? body.received_at : null,
      channel: typeof body.channel === 'string' ? (body.channel as never) : null,
      utm_source: str(body.utm_source), utm_medium: str(body.utm_medium), utm_campaign: str(body.utm_campaign),
      utm_term: str(body.utm_term), utm_content: str(body.utm_content),
      referrer: str(body.referrer), landing_page: str(body.landing_page), source_page: str(body.source_page),
      company: str(body.company), contact_name: str(body.contact_name), email: str(body.email), phone: str(body.phone),
      industry: str(body.industry), region: str(body.region), inquiry_type: str(body.inquiry_type), message: str(body.message),
      raw: body,
    });
    res.json({ ok: true, id: row.id, channel: row.channel });
  } catch (e) {
    res.status(500).json({ error: 'failed to record inquiry', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

// ---- 集計・一覧・更新（認証） ----
app.get('/api/inquiries/summary', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const summary = await getInquirySummary({
      from: typeof req.query.from === 'string' ? req.query.from : null,
      to: typeof req.query.to === 'string' ? req.query.to : null,
      channel: typeof req.query.channel === 'string' ? req.query.channel : null,
      status: typeof req.query.status === 'string' ? req.query.status : null,
    });
    res.json({
      summary,
      channel_labels: INQUIRY_CHANNEL_LABELS,
      status_labels: INQUIRY_STATUS_LABELS,
      channels: INQUIRY_CHANNELS,
      statuses: INQUIRY_STATUSES,
    });
  } catch (e) {
    res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

app.get('/api/inquiries', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const rows = await listInquiries({
      from: typeof req.query.from === 'string' ? req.query.from : null,
      to: typeof req.query.to === 'string' ? req.query.to : null,
      channel: typeof req.query.channel === 'string' ? req.query.channel : null,
      status: typeof req.query.status === 'string' ? req.query.status : null,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : 200,
    });
    res.json({ inquiries: rows });
  } catch (e) {
    res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

app.patch('/api/inquiries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: { status?: InquiryStatus; assignee?: string | null; industry?: string | null; region?: string | null } = {};
  if (typeof body.status === 'string' && (INQUIRY_STATUSES as readonly string[]).includes(body.status)) fields.status = body.status as InquiryStatus;
  if (typeof body.assignee === 'string') fields.assignee = body.assignee;
  if (typeof body.industry === 'string') fields.industry = body.industry;
  if (typeof body.region === 'string') fields.region = body.region;
  try {
    await ensureSchema();
    const ok = await updateInquiry(id, fields);
    if (!ok) { res.status(404).json({ error: 'not found or nothing to update' }); return; }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

app.delete('/api/inquiries/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
  try {
    await ensureSchema();
    const ok = await deleteInquiry(id);
    if (!ok) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

// CSV 一括取込（過去分バックフィル）。
app.post('/api/inquiries/import', requireAuth, async (req, res) => {
  const body = (req.body ?? {}) as { csv?: unknown };
  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (!csv.trim()) { res.status(400).json({ error: 'csv 文字列が必要です' }); return; }
  if (csv.length > 5_000_000) { res.status(400).json({ error: 'CSV が大きすぎます（5MB 以下）' }); return; }
  try {
    await ensureSchema();
    const rows = parseCsv(csv);
    const { inputs, skipped } = csvRowsToInputs(rows);
    if (inputs.length === 0) { res.status(400).json({ error: '取込可能な行がありません。ヘッダ行を確認してください。', skipped }); return; }
    if (inputs.length > 10_000) { res.status(400).json({ error: '一度に取込めるのは 10,000 件までです' }); return; }
    let inserted = 0;
    for (const input of inputs) {
      try { await insertInquiry(input); inserted++; } catch { /* 1行失敗で全体を止めない */ }
    }
    res.json({ ok: true, inserted, skipped, total: inputs.length });
  } catch (e) {
    res.status(500).json({ error: 'import 失敗', detail: (e instanceof Error ? e.message : '').slice(0, 200) });
  }
});

// 計測タグ設置用の設定情報。
app.get('/api/inquiries/config', requireAuth, (req, res) => {
  const proto = (req.header('x-forwarded-proto') || req.protocol || 'https').split(',')[0];
  const host = req.header('x-forwarded-host') || req.header('host') || '';
  const base = host ? `${proto}://${host}` : '';
  res.json({
    ingest_enabled: !!process.env.INQUIRY_INGEST_TOKEN,
    endpoint: base ? `${base}/api/inquiries/ingest` : '/api/inquiries/ingest',
    script_url: base ? `${base}/inquiry-tracker.js` : '/inquiry-tracker.js',
    own_domain: process.env.INQUIRY_OWN_DOMAIN || 'dgloss.co.jp',
  });
});

// ---- 静的配信 ----
app.get('/inquiry-tracker.js', (_req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(TRACKER_JS);
});
app.get('/', (_req, res) => { res.type('html').send(DASHBOARD_HTML); });

app.use((_req, res) => { res.status(404).json({ error: 'not found' }); });

// ---- 起動 ----
// スキーマ初期化はメモ化。失敗しても「プロセスは落とさない」。
// DB書き込み/読み取りの各ハンドラ内で await ensureSchema() し、
// 失敗時はそのリクエストだけ 500(JSON) を返す（DB不通でも / やタグ配信は生かす）。
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = initInquirySchema().catch((e) => {
      console.error('[schema] init failed:', e instanceof Error ? e.message : String(e));
      schemaReady = null; // 次回リクエストで再試行できるようにする
      throw e;
    });
  }
  return schemaReady;
}
// 起動時に先行作成を試みる。ここで throw を握りつぶし、未処理 rejection で
// 関数全体がクラッシュ(FUNCTION_INVOCATION_FAILED)しないようにする。
if (hasDbConfigured()) { void ensureSchema().catch(() => { /* handled per-request */ }); }

if (!VERCEL) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`\n📥 dgloss-marketing 問い合わせ分析: http://localhost:${port}\n`);
  });
}

export default app;
