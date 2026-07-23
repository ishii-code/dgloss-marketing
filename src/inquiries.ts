// 会社への「問い合わせ」の流入元分析。
// 自社サイトの問い合わせフォームに計測スニペット(public/inquiry-tracker.js)を貼ると、
// UTM・リファラ・ランディングページ等の流入情報が /api/inquiries/ingest に送られ、
// ここでチャネルを判定して保存する。CSV 一括取込による過去分バックフィルも可能。
import { getPool } from './db.js';

// 流入チャネル（「どこから来たか」の大分類）。
export type InquiryChannel =
  | 'organic_search' // 検索(自然)
  | 'paid_search'    // 検索広告(リスティング)
  | 'social'         // SNS
  | 'referral'       // 他サイト/紹介リンク
  | 'direct'         // 直接(URL直打ち/ブックマーク/不明)
  | 'email'          // メール/メルマガ
  | 'phone'          // 電話
  | 'event'          // 展示会/イベント
  | 'other';         // その他

export const INQUIRY_CHANNELS: readonly InquiryChannel[] = [
  'organic_search', 'paid_search', 'social', 'referral', 'direct', 'email', 'phone', 'event', 'other',
];

export const INQUIRY_CHANNEL_LABELS: Record<InquiryChannel, string> = {
  organic_search: '検索(自然)',
  paid_search: '検索広告',
  social: 'SNS',
  referral: '他サイト・紹介',
  direct: '直接・不明',
  email: 'メール',
  phone: '電話',
  event: 'イベント',
  other: 'その他',
};

// 対応ステータス（問い合わせのライフサイクル）。
export type InquiryStatus = 'new' | 'in_progress' | 'won' | 'lost';
export const INQUIRY_STATUSES: readonly InquiryStatus[] = ['new', 'in_progress', 'won', 'lost'];
export const INQUIRY_STATUS_LABELS: Record<InquiryStatus, string> = {
  new: '新規',
  in_progress: '対応中',
  won: '成約',
  lost: '失注',
};

export interface InquiryInput {
  received_at?: string | null; // ISO。未指定なら now。
  channel?: InquiryChannel | null; // 明示指定があれば優先。無ければ utm/referrer から自動判定。
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  referrer?: string | null;
  landing_page?: string | null;
  source_page?: string | null; // フォームが設置されていたページ
  company?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  region?: string | null;
  inquiry_type?: string | null;
  message?: string | null;
  status?: InquiryStatus | null;
  assignee?: string | null;
  raw?: unknown;
}

export interface InquiryRow {
  id: number;
  received_at: string;
  channel: InquiryChannel;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer: string | null;
  landing_page: string | null;
  source_page: string | null;
  company: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  industry: string | null;
  region: string | null;
  inquiry_type: string | null;
  message: string | null;
  status: InquiryStatus;
  assignee: string | null;
  created_at: string;
}

const SEARCH_HOSTS = ['google.', 'bing.', 'yahoo.', 'duckduckgo.', 'baidu.', 'ecosia.', 'yandex.'];
const SOCIAL_HOSTS = [
  'facebook.', 'fb.', 'instagram.', 'twitter.', 't.co', 'x.com', 'linkedin.', 'lnkd.in',
  'line.me', 'youtube.', 'youtu.be', 'tiktok.', 'pinterest.', 'note.com', 'threads.',
];

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesAny(host: string, needles: string[]): boolean {
  return needles.some((n) => host.includes(n));
}

// UTM とリファラから流入チャネルを推定する。
// 自社ドメイン(ownDomain)からのリファラは「直接(サイト内遷移)」扱い。
export function deriveChannel(input: {
  utm_source?: string | null;
  utm_medium?: string | null;
  referrer?: string | null;
  channel?: string | null;
}, ownDomain?: string | null): InquiryChannel {
  const explicit = (input.channel ?? '').trim().toLowerCase();
  if (explicit && (INQUIRY_CHANNELS as readonly string[]).includes(explicit)) {
    return explicit as InquiryChannel;
  }

  const medium = (input.utm_medium ?? '').trim().toLowerCase();
  const source = (input.utm_source ?? '').trim().toLowerCase();
  if (medium) {
    if (/(^|[-_])(cpc|ppc|paid|paidsearch|paid_search|sem)$/.test(medium) || medium === 'paid') return 'paid_search';
    if (medium.includes('paid') && medium.includes('social')) return 'social';
    if (medium.includes('email') || medium.includes('mail') || medium.includes('newsletter')) return 'email';
    if (medium.includes('social') || medium === 'sns') return 'social';
    if (medium.includes('affiliate') || medium.includes('referral')) return 'referral';
    if (medium.includes('organic')) return 'organic_search';
    if (medium.includes('event') || medium.includes('expo')) return 'event';
  }
  if (source) {
    if (matchesAny(source, SOCIAL_HOSTS) || ['facebook', 'instagram', 'twitter', 'x', 'linkedin', 'line', 'youtube', 'tiktok'].includes(source)) return 'social';
    if (matchesAny(source, SEARCH_HOSTS) || ['google', 'bing', 'yahoo'].includes(source)) {
      return medium.includes('cpc') || medium.includes('paid') ? 'paid_search' : 'organic_search';
    }
  }

  const host = hostOf(input.referrer);
  if (!host) return 'direct';
  const own = (ownDomain ?? '').toLowerCase().replace(/^www\./, '');
  if (own && (host === own || host.endsWith(`.${own}`))) return 'direct';
  if (matchesAny(host, SEARCH_HOSTS)) return 'organic_search';
  if (matchesAny(host, SOCIAL_HOSTS)) return 'social';
  return 'referral';
}

function s(v: unknown, max = 2000): string | null {
  if (v == null) return null;
  const str = String(v).trim();
  if (!str) return null;
  return str.slice(0, max);
}

export async function initInquirySchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      channel TEXT NOT NULL DEFAULT 'direct',
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      referrer TEXT,
      landing_page TEXT,
      source_page TEXT,
      company TEXT,
      contact_name TEXT,
      email TEXT,
      phone TEXT,
      industry TEXT,
      region TEXT,
      inquiry_type TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      assignee TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inquiries_received_at ON inquiries(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inquiries_channel ON inquiries(channel);
    CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
  `);
}

const OWN_DOMAIN = process.env.INQUIRY_OWN_DOMAIN || 'dgloss.co.jp';

export async function insertInquiry(input: InquiryInput): Promise<InquiryRow> {
  const p = getPool();
  const channel = deriveChannel({
    utm_source: input.utm_source ?? null,
    utm_medium: input.utm_medium ?? null,
    referrer: input.referrer ?? null,
    channel: input.channel ?? null,
  }, OWN_DOMAIN);

  const status: InquiryStatus =
    input.status && (INQUIRY_STATUSES as readonly string[]).includes(input.status) ? input.status : 'new';

  let receivedAt: string | null = null;
  if (input.received_at) {
    const t = Date.parse(input.received_at);
    if (Number.isFinite(t)) receivedAt = new Date(t).toISOString();
  }

  const r = await p.query<InquiryRow>(
    `INSERT INTO inquiries
       (received_at, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        referrer, landing_page, source_page, company, contact_name, email, phone,
        industry, region, inquiry_type, message, status, assignee, raw)
     VALUES
       (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21)
     RETURNING id, received_at, channel, utm_source, utm_medium, utm_campaign, utm_term,
               utm_content, referrer, landing_page, source_page, company, contact_name,
               email, phone, industry, region, inquiry_type, message, status, assignee, created_at`,
    [
      receivedAt,
      channel,
      s(input.utm_source, 300), s(input.utm_medium, 300), s(input.utm_campaign, 300),
      s(input.utm_term, 300), s(input.utm_content, 300),
      s(input.referrer, 1000), s(input.landing_page, 1000), s(input.source_page, 1000),
      s(input.company, 300), s(input.contact_name, 200), s(input.email, 320), s(input.phone, 60),
      s(input.industry, 200), s(input.region, 200), s(input.inquiry_type, 200), s(input.message, 8000),
      status, s(input.assignee, 200),
      input.raw != null ? JSON.stringify(input.raw).slice(0, 20000) : null,
    ],
  );
  return r.rows[0]!;
}

export interface InquiryFilter {
  from?: string | null; // YYYY-MM-DD
  to?: string | null;   // YYYY-MM-DD (inclusive)
  channel?: string | null;
  status?: string | null;
  limit?: number;
}

// received_at のフィルタ用に [from 00:00, to+1day 00:00) を UTC ではなく JST 基準の日付として扱う。
// 簡潔化のため received_at::date で比較する（TIMESTAMPTZ→サーバ時刻依存を避けるため date キャストを利用）。
function buildRange(f: InquiryFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (f.from && ISO.test(f.from)) {
    params.push(f.from);
    clauses.push(`received_at >= $${params.length}::date`);
  }
  if (f.to && ISO.test(f.to)) {
    params.push(f.to);
    clauses.push(`received_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (f.channel && (INQUIRY_CHANNELS as readonly string[]).includes(f.channel)) {
    params.push(f.channel);
    clauses.push(`channel = $${params.length}`);
  }
  if (f.status && (INQUIRY_STATUSES as readonly string[]).includes(f.status)) {
    params.push(f.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

export async function listInquiries(f: InquiryFilter): Promise<InquiryRow[]> {
  const p = getPool();
  const { where, params } = buildRange(f);
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  const r = await p.query<InquiryRow>(
    `SELECT id, received_at, channel, utm_source, utm_medium, utm_campaign, utm_term,
            utm_content, referrer, landing_page, source_page, company, contact_name,
            email, phone, industry, region, inquiry_type, message, status, assignee, created_at
     FROM inquiries ${where}
     ORDER BY received_at DESC
     LIMIT ${limit}`,
    params,
  );
  return r.rows;
}

export interface BucketCount { key: string; count: number; won: number }

async function groupBy(column: string, f: InquiryFilter): Promise<BucketCount[]> {
  const p = getPool();
  const { where, params } = buildRange(f);
  const r = await p.query<{ key: string | null; count: string; won: string }>(
    `SELECT ${column} AS key,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE status = 'won')::int AS won
     FROM inquiries ${where}
     GROUP BY ${column}
     ORDER BY count DESC`,
    params,
  );
  return r.rows.map((row) => ({ key: row.key ?? '(未設定)', count: Number(row.count), won: Number(row.won) }));
}

export interface InquirySummary {
  total: number;
  won: number;
  in_progress: number;
  lost: number;
  new_count: number;
  win_rate: number;
  by_channel: BucketCount[];
  by_source: BucketCount[];
  by_campaign: BucketCount[];
  by_landing: BucketCount[];
  by_industry: BucketCount[];
  by_region: BucketCount[];
  by_status: BucketCount[];
  monthly: Array<{ month: string; count: number; won: number }>;
}

export async function getInquirySummary(f: InquiryFilter): Promise<InquirySummary> {
  const p = getPool();
  const { where, params } = buildRange(f);

  const totalsQ = p.query<{ total: string; won: string; in_progress: string; lost: string; new_count: string }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='won')::int AS won,
            COUNT(*) FILTER (WHERE status='in_progress')::int AS in_progress,
            COUNT(*) FILTER (WHERE status='lost')::int AS lost,
            COUNT(*) FILTER (WHERE status='new')::int AS new_count
     FROM inquiries ${where}`,
    params,
  );
  const monthlyQ = p.query<{ month: string; count: string; won: string }>(
    `SELECT to_char(received_at, 'YYYY-MM') AS month,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE status='won')::int AS won
     FROM inquiries ${where}
     GROUP BY month
     ORDER BY month ASC`,
    params,
  );

  const [totals, monthly, byChannel, bySource, byCampaign, byLanding, byIndustry, byRegion, byStatus] =
    await Promise.all([
      totalsQ,
      monthlyQ,
      groupBy('channel', f),
      groupBy(`COALESCE(NULLIF(utm_source, ''), '(なし)')`, f),
      groupBy(`COALESCE(NULLIF(utm_campaign, ''), '(なし)')`, f),
      groupBy(`COALESCE(NULLIF(landing_page, ''), '(なし)')`, f),
      groupBy(`COALESCE(NULLIF(industry, ''), '(未設定)')`, f),
      groupBy(`COALESCE(NULLIF(region, ''), '(未設定)')`, f),
      groupBy('status', f),
    ]);

  const t = totals.rows[0]!;
  const total = Number(t.total);
  const won = Number(t.won);
  return {
    total,
    won,
    in_progress: Number(t.in_progress),
    lost: Number(t.lost),
    new_count: Number(t.new_count),
    win_rate: total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
    by_channel: byChannel,
    by_source: bySource,
    by_campaign: byCampaign,
    by_landing: byLanding,
    by_industry: byIndustry,
    by_region: byRegion,
    by_status: byStatus,
    monthly: monthly.rows.map((m) => ({ month: m.month, count: Number(m.count), won: Number(m.won) })),
  };
}

export async function updateInquiry(
  id: number,
  fields: { status?: InquiryStatus; assignee?: string | null; industry?: string | null; region?: string | null },
): Promise<boolean> {
  const p = getPool();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.status && (INQUIRY_STATUSES as readonly string[]).includes(fields.status)) {
    params.push(fields.status);
    sets.push(`status = $${params.length}`);
  }
  if (fields.assignee !== undefined) {
    params.push(s(fields.assignee, 200));
    sets.push(`assignee = $${params.length}`);
  }
  if (fields.industry !== undefined) {
    params.push(s(fields.industry, 200));
    sets.push(`industry = $${params.length}`);
  }
  if (fields.region !== undefined) {
    params.push(s(fields.region, 200));
    sets.push(`region = $${params.length}`);
  }
  if (sets.length === 0) return false;
  params.push(id);
  const r = await p.query(`UPDATE inquiries SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteInquiry(id: number): Promise<boolean> {
  const p = getPool();
  const r = await p.query('DELETE FROM inquiries WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---- CSV 取込（過去分バックフィル） ----

// RFC4180 相当の簡易 CSV パーサ（ダブルクオート内のカンマ・改行に対応）。
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

// CSV のヘッダ名 → InquiryInput のフィールドへの対応（日本語ヘッダにも対応）。
const CSV_HEADER_MAP: Record<string, keyof InquiryInput> = {
  received_at: 'received_at', date: 'received_at', 日時: 'received_at', 受信日時: 'received_at', 問い合わせ日: 'received_at',
  channel: 'channel', チャネル: 'channel', 流入元: 'channel',
  utm_source: 'utm_source', source: 'utm_source', 参照元: 'utm_source',
  utm_medium: 'utm_medium', medium: 'utm_medium', メディア: 'utm_medium',
  utm_campaign: 'utm_campaign', campaign: 'utm_campaign', キャンペーン: 'utm_campaign',
  utm_term: 'utm_term', utm_content: 'utm_content',
  referrer: 'referrer', リファラ: 'referrer', 参照ページ: 'referrer',
  landing_page: 'landing_page', landing: 'landing_page', ランディングページ: 'landing_page',
  source_page: 'source_page', フォームページ: 'source_page',
  company: 'company', 会社名: 'company', 企業名: 'company',
  contact_name: 'contact_name', name: 'contact_name', 氏名: 'contact_name', 担当者: 'contact_name', お名前: 'contact_name',
  email: 'email', mail: 'email', メール: 'email', メールアドレス: 'email',
  phone: 'phone', tel: 'phone', 電話: 'phone', 電話番号: 'phone',
  industry: 'industry', 業種: 'industry',
  region: 'region', 地域: 'region', 都道府県: 'region',
  inquiry_type: 'inquiry_type', type: 'inquiry_type', 種別: 'inquiry_type', 問い合わせ種別: 'inquiry_type',
  message: 'message', body: 'message', 本文: 'message', 内容: 'message', 問い合わせ内容: 'message',
  status: 'status', ステータス: 'status', 対応状況: 'status',
  assignee: 'assignee', 担当: 'assignee',
};

// 日本語ステータス → 内部コード。
const STATUS_ALIASES: Record<string, InquiryStatus> = {
  new: 'new', 新規: 'new', 未対応: 'new',
  in_progress: 'in_progress', 対応中: 'in_progress', 進行中: 'in_progress',
  won: 'won', 成約: 'won', 受注: 'won',
  lost: 'lost', 失注: 'lost', 見送り: 'lost',
};

export function csvRowsToInputs(rows: string[][]): { inputs: InquiryInput[]; skipped: number } {
  if (rows.length < 2) return { inputs: [], skipped: 0 };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  const inputs: InquiryInput[] = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const rec: Record<string, unknown> = {};
    let hasAny = false;
    for (let c = 0; c < header.length; c++) {
      const key = CSV_HEADER_MAP[header[c]] || CSV_HEADER_MAP[rows[0][c]?.trim()];
      if (!key) continue;
      const val = (cells[c] ?? '').trim();
      if (!val) continue;
      hasAny = true;
      if (key === 'status') {
        rec.status = STATUS_ALIASES[val.toLowerCase()] || STATUS_ALIASES[val] || undefined;
      } else if (key === 'channel') {
        const cl = val.toLowerCase();
        rec.channel = (INQUIRY_CHANNELS as readonly string[]).includes(cl) ? cl : undefined;
      } else {
        rec[key] = val;
      }
    }
    if (!hasAny) { skipped++; continue; }
    inputs.push(rec as InquiryInput);
  }
  return { inputs, skipped };
}
