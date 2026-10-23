import type { ReadingRewardEntry, RewardEntry, RewardSummary, WordRewardEntry } from '../shared/rewards';
import { openProgressDb } from './progress-db';
import { getWord, listBooks } from './content-db';
import { isLearningWord } from './learning-list';
import { COLLECTION_ID } from '../shared/collection';
import { getReadingAttemptContext, resolveReadingLocation } from './reading-location';
import { READING_BANK } from './reading-bank';
import { getReadingDefinition } from './reading-package-store';

/** 词卡的主观评分只影响复习记录，不直接发放奖励。 */
export function markMemory(wordId: number, bookId: string, correct: boolean): WordRewardEntry[] {
  openProgressDb().prepare(
    'INSERT INTO mastery(word_id,book_id,memory_correct_at) VALUES(?,?,?) ' +
    'ON CONFLICT(word_id,book_id) DO UPDATE SET memory_correct_at=excluded.memory_correct_at',
  ).run(wordId, bookId, correct ? new Date().toISOString() : null);
  return [];
}
function record(entry: RewardEntry, scope: string, item: string): boolean {
  return Boolean(openProgressDb().prepare(
    'INSERT OR IGNORE INTO reward_ledger(source,scope_id,item_id,id,earned_at,payload_json) VALUES(?,?,?,?,?,?)',
  ).run(entry.source, scope, item, entry.id, entry.earnedAt, JSON.stringify(entry)).changes);
}
/** 只从新的客观自测提交路径调用，不根据旧评分补发。 */
export function markPractice(wordId: number, bookId: string): WordRewardEntry[] {
  openProgressDb().prepare(
    'INSERT INTO mastery(word_id,book_id,practice_correct_at) VALUES(?,?,?) ' +
    'ON CONFLICT(word_id,book_id) DO UPDATE SET practice_correct_at=excluded.practice_correct_at',
  ).run(wordId, bookId, new Date().toISOString());
  return grantReward(wordId, bookId);
}
export function grantReward(wordId: number, bookId: string): WordRewardEntry[] {
  if (!isLearningWord(wordId, bookId)) return [];
  const checked = openProgressDb().prepare('SELECT last_correct FROM word_self_tests WHERE word_id=? AND book_id=?').get(wordId, bookId);
  if (!checked?.last_correct) return [];
  const word = getWord(wordId);
  if (!word) return [];
  const entry: WordRewardEntry = {
    id: 'word:' + encodeURIComponent(bookId) + ':' + wordId, source: 'word',
    wordId, bookId, bookName: bookId === COLLECTION_ID ? '收藏词表'
      : listBooks().find(book => book.id === bookId)?.name_zh || bookId,
    lemma: word.lemma, translation: word.translation, earnedAt: new Date().toISOString(),
  };
  return record(entry, bookId, String(wordId)) ? [entry] : [];
}
export function grantReadingReward(
  unit: { id: string; title: string; level: string; questions?: Array<{ id: string }> },
  question: { id: string; prompt: string; format?: string },
  earnedAt = new Date().toISOString(),
  attemptId?: string,
): ReadingRewardEntry[] {
  const entry: ReadingRewardEntry = {
    id: 'reading:' + encodeURIComponent(question.id), source: 'reading', unitId: unit.id,
    questionFormat: question.format, questionNumber: unit.questions ? unit.questions.findIndex(item => item.id === question.id) + 1 : undefined,
    questionId: question.id, unitTitle: unit.title, questionTitle: question.prompt, level: unit.level, earnedAt,
    ...(attemptId ? { attemptId } : {}),
  };
  return record(entry, unit.id, question.id) ? [entry] : [];
}
function inferReadingRewardAttempt(entry: ReadingRewardEntry): string | undefined {
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_sessions'").get()) return;
  const rows = db.prepare('SELECT id,paper_result_json FROM reading_sessions WHERE paper_result_json IS NOT NULL').all() as
    Array<{ id: string; paper_result_json: string }>;
  const matches = rows.filter(row => {
    try {
      const result = JSON.parse(row.paper_result_json) as { earned?: ReadingRewardEntry[] };
      return Array.isArray(result.earned) && result.earned.some(reward => reward.id === entry.id &&
        reward.earnedAt === entry.earnedAt && reward.questionId === entry.questionId && reward.unitId === entry.unitId);
    } catch { return false; }
  });
  return matches.length === 1 ? matches[0].id : undefined;
}
export function getRewards(): RewardSummary {
  const rows = openProgressDb().prepare('SELECT payload_json FROM reward_ledger ORDER BY earned_at DESC,id DESC').all();
  const history: RewardEntry[] = rows.map(row => {
    const entry = JSON.parse(row.payload_json) as RewardEntry;
    if (entry.source !== 'reading') return entry;
    try {
      const attemptId = entry.attemptId ?? inferReadingRewardAttempt(entry);
      const location = resolveReadingLocation(entry.unitId, { questionId: entry.questionId, attemptId });
      const historical = attemptId ? { ...entry, attemptId } : entry;
      if (location.unitId === entry.unitId) return historical;
      const unit = attemptId ? getReadingDefinition(location.unitId, getReadingAttemptContext(attemptId).content_revision)
        : READING_BANK.find(item => item.id === location.unitId);
      const index = unit?.questions.findIndex(question => question.id === entry.questionId) ?? -1;
      if (!unit || index < 0) return entry;
      return { ...historical, unitId: unit.id, unitTitle: unit.title,
        questionNumber: index + 1, questionTitle: unit.questions[index].prompt };
    } catch { return entry; } // Preserve records from unavailable historical content.
  });
  const wordTotal = history.filter(entry => entry.source === 'word').length;
  return { total: history.length, wordTotal, readingTotal: history.length - wordTotal, history };
}
