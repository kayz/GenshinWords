import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getProgressDbPath } from './paths';
import { migrateCollections } from './collection-migration';
import { migrateRewards } from './reward-migration';


export let progressDb = null;
export function openProgressDb() {
  if (progressDb) return progressDb;
  fs.mkdirSync(path.dirname(getProgressDbPath()), { recursive: true });
  progressDb = new Database(getProgressDbPath());
  progressDb.pragma('journal_mode = WAL');
  progressDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      due TEXT NOT NULL,
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days REAL NOT NULL DEFAULT 0,
      scheduled_days REAL NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      state INTEGER NOT NULL DEFAULT 0,
      last_review TEXT,
      PRIMARY KEY (word_id, book_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(book_id, due);
    CREATE TABLE IF NOT EXISTS review_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (word_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS collected_words (
      word_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      source_json TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browse_progress (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mastery (
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      memory_correct_at TEXT,
      practice_correct_at TEXT,
      PRIMARY KEY(word_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS rewards (
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      lemma TEXT NOT NULL,
      mastered_at TEXT NOT NULL,
      PRIMARY KEY(word_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS review_requests (
      request_id TEXT PRIMARY KEY,
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS practice_progress (
      word_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      shown_count INTEGER NOT NULL DEFAULT 0,
      last_presented_at TEXT,
      last_checked_at TEXT,
      last_correct INTEGER,
      PRIMARY KEY(word_id,book_id)
    );
    CREATE TABLE IF NOT EXISTS exercise_attempts (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result_json TEXT
    );
  `);
  const cols = progressDb.prepare(`PRAGMA table_info(cards)`).all();
  if (!cols.some((c) => c.name === 'learning_steps')) {
    progressDb.exec(`ALTER TABLE cards ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0`);
  }
  progressDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_logs_book_word ON review_logs(book_id,word_id,id);
    INSERT OR IGNORE INTO mastery(word_id,book_id,memory_correct_at)
      SELECT r.word_id,r.book_id,CASE WHEN r.rating>=3 THEN r.reviewed_at ELSE NULL END
      FROM review_logs r JOIN (SELECT word_id,book_id,MAX(id) AS id FROM review_logs GROUP BY word_id,book_id) latest ON r.id=latest.id;
  `);
  migrateCollections(progressDb);
  migrateRewards(progressDb);
  return progressDb;
}
export function closeProgressDb() {
  progressDb?.close();
  progressDb = null;
}
export function getSetting(key: string, fallback = ''): string {
  const db = openProgressDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row?.value ?? fallback;
}
export function setSetting(key: string, value: string): void {
  const db = openProgressDb();
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
export function getCard(wordId, bookId) {
  const db = openProgressDb();
  return db.prepare(`SELECT * FROM cards WHERE word_id = ? AND book_id = ?`).get(wordId, bookId);
}
export function upsertCard(card) {
  const db = openProgressDb();
  db.prepare(
    `INSERT INTO cards(word_id, book_id, due, stability, difficulty, elapsed_days,
      scheduled_days, learning_steps, reps, lapses, state, last_review)
     VALUES (@word_id, @book_id, @due, @stability, @difficulty, @elapsed_days,
      @scheduled_days, @learning_steps, @reps, @lapses, @state, @last_review)
     ON CONFLICT(word_id, book_id) DO UPDATE SET
      due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
      elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
      learning_steps=excluded.learning_steps,
      reps=excluded.reps, lapses=excluded.lapses, state=excluded.state,
      last_review=excluded.last_review`,
  ).run(card);
}
export function allDueCards(bookId, nowIso) {
  const db = openProgressDb();
  return db
    .prepare(`SELECT * FROM cards WHERE book_id = ? AND due <= ? ORDER BY due,word_id`)
    .all(bookId, nowIso);
}
export function newWordIds(bookId: string, allWordIds: number[], limit: number): number[] {
  if (limit <= 0) return [];
  const db = openProgressDb();
  const existing = new Set(
    db
      .prepare(`SELECT word_id FROM cards WHERE book_id = ? AND reps > 0`)
      .all(bookId)
      .map((r) => r.word_id),
  );
  const result = [];
  for (const id of allWordIds) {
    if (!existing.has(id)) {
      result.push(id);
      if (result.length >= limit) break;
    }
  }
  return result;
}
export function logReview(wordId, bookId, rating) {
  const db = openProgressDb();
  db.prepare(
    `INSERT INTO review_logs(word_id, book_id, rating, reviewed_at) VALUES (?, ?, ?, ?)`,
  ).run(wordId, bookId, rating, new Date().toISOString());
}
export function setBrowseProgress(key: string, value: string): void {
  const db = openProgressDb();
  db.prepare(
    `INSERT INTO browse_progress(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
export function getBrowseProgress(key: string): string {
  const db = openProgressDb();
  const row = db.prepare(`SELECT value FROM browse_progress WHERE key = ?`).get(key);
  return row?.value ?? '';
}
