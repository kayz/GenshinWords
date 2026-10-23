import { normalizeStudyOrder } from '../shared/study-settings';
export { normalizeStudyOrder } from '../shared/study-settings';
import type { StudyStats, StudyOrder, ReviewResult, StudyBatchRequest } from '../shared/models';
import { fsrs, generatorParameters, createEmptyCard, State, Rating, type Grade } from 'ts-fsrs';
import {
  getCard,
  openProgressDb,
  getSetting,
  setSetting,
  upsertCard,
  logReview,
  allDueCards,
  newWordIds,
} from './progress-db';
import { openContentDb, hasTable } from './content-db';
import { getLearningWords, isLearningWord } from './learning-list';
import { markMemory } from './rewards';
import { COLLECTION_ID } from '../shared/collection';
import { listCollection } from './collections';


export const scheduler = fsrs(
  generatorParameters({
    enable_fuzz: true,
    enable_short_term: true,
  }),
);
export function cardFromRow(row) {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps ?? 0,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}
export function rowFromCard(wordId, bookId, card) {
  return {
    word_id: wordId,
    book_id: bookId,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}
export function ensureCard(wordId, bookId) {
  const existing = getCard(wordId, bookId);
  if (existing) return existing;
  const empty = createEmptyCard(new Date());
  const row = rowFromCard(wordId, bookId, empty);
  upsertCard(row);
  return row;
}
export function getStudyOrder(): StudyOrder {
  const saved = getSetting('studyOrder', 'default');
  const order = normalizeStudyOrder(saved);
  if (saved !== order) setSetting('studyOrder', order);
  return order;
}
export function sortByMemoryCurve(rows, now, limit) {
  const scored = rows.map((row) => {
    const card = cardFromRow(row);
    let r = 0;
    try {
      r = scheduler.get_retrievability(card, now, false);
    } catch {
      r = 0;
    }
    const dueMs = new Date(row.due).getTime();
    return { word_id: row.word_id, r, dueMs, state: row.state };
  });
  scored.sort((a, b) => {
    const aLearn = a.state === State.Learning || a.state === State.Relearning ? 0 : 1;
    const bLearn = b.state === State.Learning || b.state === State.Relearning ? 0 : 1;
    if (aLearn !== bLearn) return aLearn - bLearn;
    if (a.r !== b.r) return a.r - b.r;
    return a.dueMs - b.dueMs;
  });
  return scored.slice(0, limit).map((s) => s.word_id);
}
export function buildSession(bookId: string, newLimit = 10, dueLimit = 40, order: StudyOrder = 'default'): number[] {
  const now = new Date();
  const nowIso = now.toISOString();
  const dueRows = allDueCards(bookId, nowIso);
  const words = getLearningWords(bookId, normalizeStudyOrder(order));
  const allowed = new Set<number>(words.map(word => word.id));
  const validDueRows = dueRows.filter((row) => allowed.has(row.word_id) && row.reps > 0);
  const due = sortByMemoryCurve(validDueRows, now, Math.max(0, dueLimit));
  const allIds = words.map((word) => word.id);
  const news = newWordIds(
    bookId,
    allIds,
    Math.max(0, newLimit),
  );
  const seen = new Set();
  const session = [];
  for (const id of [...due, ...news]) {
    if (!seen.has(id)) {
      seen.add(id);
      session.push(id);
    }
  }
  return session;
}
export function reviewCard(wordId: number, bookId: string, rating: Grade, requestId?: string): ReviewResult {
  if (!isLearningWord(wordId, bookId))
    throw new Error('单词不在当前学习列表中');
  const db = openProgressDb();
  return db.transaction((): ReviewResult => {
    if (requestId) {
      const prior = db
        .prepare('SELECT word_id,book_id,result_json FROM review_requests WHERE request_id=?')
        .get(requestId);
      if (prior) {
        if (prior.word_id !== wordId || prior.book_id !== bookId) throw new Error('评分请求不匹配');
        const saved = JSON.parse(prior.result_json);
        if (saved.requestRating !== undefined && saved.requestRating !== rating)
          throw new Error('这次评分已记录，请重试最初的选择。');
        return { due: saved.due, state: saved.state, earned: [], duplicate: true };
      }
    }
    const last = db
      .prepare(
        'SELECT reviewed_at FROM review_logs WHERE word_id=? AND book_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(wordId, bookId);
    const existing = getCard(wordId, bookId);
    if (last && existing && Date.now() - new Date(last.reviewed_at).getTime() < 750)
      return { due: existing.due, state: existing.state, earned: [], duplicate: true };
    const row = ensureCard(wordId, bookId);
    const card = cardFromRow(row);
    const now = new Date();
    const result = scheduler.next(card, now, rating);
    const next = rowFromCard(wordId, bookId, result.card);
    upsertCard(next);
    logReview(wordId, bookId, rating);
    const earned = markMemory(
      wordId,
      bookId,
      rating === Rating.Good || rating === Rating.Easy,
    );
    const response = { due: next.due, state: next.state, earned, duplicate: false };
    if (requestId)
      db.prepare(
        'INSERT INTO review_requests(request_id,word_id,book_id,result_json) VALUES(?,?,?,?)',
      ).run(requestId, wordId, bookId, JSON.stringify({...response, requestRating: rating}));
    return response;
  })();
}
/** 客观自测失败后安排短期再学；通过不额外推进已评分的复习卡。 */
export function recordSelfTestFailure(wordId: number, bookId: string): void {
  const row = getCard(wordId, bookId);
  if (!row || !isLearningWord(wordId, bookId)) return;
  const next = scheduler.next(cardFromRow(row), new Date(), Rating.Again);
  upsertCard(rowFromCard(wordId, bookId, next.card));
  logReview(wordId, bookId, Rating.Again);
  markMemory(wordId, bookId, false);
}
export function getStats(bookId: string): StudyStats {
  const words = getLearningWords(bookId);
  const total = words.length;
  const now = new Date().toISOString();
  const memberIds = new Set(words.map((w) => w.id));
  const cards = openProgressDb()
    .prepare('SELECT word_id,due,reps FROM cards WHERE book_id=?')
    .all(bookId);
  const learned = cards.filter((c) => memberIds.has(c.word_id) && c.reps > 0);
  const due = learned.filter((c) => c.due <= now).length;
  const newCount = total - learned.length;
  const content = openContentDb();
  const covered = bookId === COLLECTION_ID ? listCollection().filter(entry => entry.source).length : content && hasTable(content, 'word_examples')
    ? content.prepare('SELECT count(DISTINCT word_id) AS total FROM word_examples WHERE word_id IN (SELECT value FROM json_each(?))').get(JSON.stringify([...memberIds])).total
    : 0;
  return {
    due,
    newCount,
    learning: Math.max(0, total - newCount - due),
    total,
    pendingSource: bookId === COLLECTION_ID ? total - covered : 0,
    covered,
    uncovered: total - covered,
    coverage_pct: total ? covered * 100 / total : 0,
  };
}

/** Fixed runs count all words together; marathon permits scheduled short-term relearning only when due. */
export function buildStudyBatch(bookId: string, request: StudyBatchRequest): number[] {
  if (!request || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
    throw new Error('本轮词数应在1到100之间。');
  const excluded = request.excludeNewIds ?? [];
  if (!Array.isArray(excluded) || excluded.length > 100000 || excluded.some(id => !Number.isSafeInteger(id) || id <= 0))
    throw new Error('复习记录格式无效。');
  if (request.repeatDue !== undefined && typeof request.repeatDue !== 'boolean' ||
    request.dueOnly !== undefined && typeof request.dueOnly !== 'boolean')
    throw new Error('复习模式无效。');
  const seen = new Set(excluded);
  const words = getLearningWords(bookId, normalizeStudyOrder(request.order || 'default'));
  const allowed = new Set(words.map(word => word.id));
  const now = new Date();
  const rows = allDueCards(bookId, now.toISOString()).filter(row =>
    allowed.has(row.word_id) && row.reps > 0 && (request.repeatDue || !seen.has(row.word_id)));
  const due = sortByMemoryCurve(rows, now, request.limit);
  if (request.dueOnly || due.length >= request.limit) return due;
  const fresh = newWordIds(bookId, words.map(word => word.id).filter(id => !seen.has(id)), request.limit - due.length);
  return [...new Set([...due, ...fresh])];
}
