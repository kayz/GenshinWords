import { COLLECTION_ID } from '../shared/collection';

export function migrateCollections(db) {
  const version = 'independent-collection-v1';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) return;
  db.transaction(() => {
    const legacy = db.prepare('SELECT word_id,min(created_at) AS created_at FROM bookmarks GROUP BY word_id').all();
    for (const entry of legacy) {
      db.prepare('INSERT OR IGNORE INTO collected_words(word_id,created_at) VALUES(?,?)').run(entry.word_id, entry.created_at);
      // 旧收藏未保存原句，不能从例句库猜测来源；只迁移最近一次复习对应的记忆状态。
      const card = db.prepare('SELECT c.* FROM cards c JOIN bookmarks b ON b.word_id=c.word_id AND b.book_id=c.book_id ' +
        "WHERE c.word_id=? ORDER BY coalesce(c.last_review,'') DESC,c.reps DESC,c.book_id LIMIT 1").get(entry.word_id);
      if (card) {
        const inserted = db.prepare('INSERT OR IGNORE INTO cards(word_id,book_id,due,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review) ' +
          'VALUES(@word_id,@scope,@due,@stability,@difficulty,@elapsed_days,@scheduled_days,@learning_steps,@reps,@lapses,@state,@last_review)')
          .run({ ...card, scope: COLLECTION_ID });
        if (inserted.changes) {
          db.prepare('INSERT INTO review_logs(word_id,book_id,rating,reviewed_at) ' +
            'SELECT word_id,?,rating,reviewed_at FROM review_logs WHERE word_id=? AND book_id=? ORDER BY id')
            .run(COLLECTION_ID, entry.word_id, card.book_id);
          db.prepare('INSERT OR IGNORE INTO mastery(word_id,book_id,memory_correct_at) ' +
            'SELECT word_id,?,memory_correct_at FROM mastery WHERE word_id=? AND book_id=?')
            .run(COLLECTION_ID, entry.word_id, card.book_id);
        }
      }
      // 保留已获得的历史奖励；旧练习正确标记不充当来源句测试结果。
      db.prepare('INSERT OR IGNORE INTO rewards(word_id,book_id,lemma,mastered_at) ' +
        'SELECT word_id,?,lemma,mastered_at FROM rewards WHERE word_id=? AND book_id IN ' +
        '(SELECT book_id FROM bookmarks WHERE word_id=?) ORDER BY mastered_at,book_id LIMIT 1')
        .run(COLLECTION_ID, entry.word_id, entry.word_id);
    }
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version, new Date().toISOString());
  })();
}
