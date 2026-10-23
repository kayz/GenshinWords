import type Database from 'better-sqlite3';

const VERSION = 'independent-rewards-v2';

/** 新规则只清零奖励；学习卡片、复习日志、收藏与旧答题记录均保留。 */
export function migrateRewards(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS reward_ledger (
      source TEXT NOT NULL CHECK(source IN ('word','reading')),
      scope_id TEXT NOT NULL, item_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
      earned_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(source,scope_id,item_id)
    ); CREATE INDEX IF NOT EXISTS idx_reward_ledger_time ON reward_ledger(earned_at,id);
    CREATE TABLE IF NOT EXISTS word_self_tests (
      word_id INTEGER NOT NULL,book_id TEXT NOT NULL,first_correct INTEGER NOT NULL,
      last_correct INTEGER NOT NULL,attempts INTEGER NOT NULL,first_checked_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,last_kind TEXT NOT NULL,
      PRIMARY KEY(word_id,book_id)
    );`);
    const columns = db.prepare('PRAGMA table_info(exercise_attempts)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'reward_version'))
      db.exec('ALTER TABLE exercise_attempts ADD COLUMN reward_version INTEGER NOT NULL DEFAULT 1');
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(VERSION)) return;
    db.prepare('DELETE FROM rewards').run();
    db.prepare('DELETE FROM reward_ledger').run();
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(VERSION, new Date().toISOString());
  })();
}
