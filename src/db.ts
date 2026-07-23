import pg from 'pg';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    // Supabase(SUPABASE_DATABASE_URL)を優先。無ければ DATABASE_URL。
    const connectionString = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('SUPABASE_DATABASE_URL / DATABASE_URL is not set');
    }
    const isSupabase = /supabase\.(co|com)/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: (isSupabase || process.env.DATABASE_SSL === 'true') ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

// ヘルスチェック用: DB に到達できるかを返す（例外は握りつぶして false）。
export async function checkDbConnection(): Promise<boolean> {
  try {
    if (!process.env.SUPABASE_DATABASE_URL && !process.env.DATABASE_URL) return false;
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export function hasDbConfigured(): boolean {
  return !!(process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL);
}
