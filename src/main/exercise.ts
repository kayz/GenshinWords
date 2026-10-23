import crypto from 'node:crypto';
import { COLLECTION_ID } from '../shared/collection';
import { getCollectedSource } from './collections';
import type { ExerciseResult, PracticeWord, StudyExercise, SelfTestMode } from '../shared/practice';
import { openProgressDb, getCard } from './progress-db';
import { getWord } from './content-db';
import { getLearningWords, isLearningWord } from './learning-list';
import { findPracticeSource, practiceMatches } from './practice-content';
import { normalizeAnswer, equivalentSpellings } from './spelling';
import { markPractice, getRewards } from './rewards';
import { createWordSelfTest } from './word-self-test';
import { recordSelfTestFailure } from './study';
export { normalizeAnswer } from './spelling';

type Solution = { id: string; wordId: number; expected: string; lemma: string; accepted: string[] };

/** 单词驱动出题；即使没有任何原文，也始终返回可判分的拼写题。 */
export function createExerciseForWord(bookId: string, word: PracticeWord) {
  if (!word?.lemma?.trim()) throw new Error('单词数据缺失');
  const source = bookId === COLLECTION_ID ? getCollectedSource(word.id) : findPracticeSource(word);
  if (!source) throw new Error('此收藏尚未保存来源句，请在本地剧情中重新点选这个词后再测试');
  const phonetic = word.phonetic || word.phonetic_uk || word.phonetic_us || '';
  const hasMeaning = Boolean(word.translation?.trim());
  const hasPronunciation = Boolean(phonetic || word.audio_uk || word.audio_us);
  const exercise: StudyExercise = {
    id: crypto.randomUUID(), bookId, kind: source.kind,
    title: source.kind === 'spelling' ? (hasMeaning ? '词义拼写' : hasPronunciation ? '听音拼写' : '字母重排') : source.title,
    sourceTitle: source.sourceTitle, sourceUrl: source.sourceUrl,
    coverPath: source.coverPath, speaker: source.speaker,
    prompt: source.kind === 'collection' ? '请补全收录时的原句，保持原文词形。' : source.kind === 'spelling'
      ? (hasMeaning ? '当前资料未匹配到原文，请根据释义填写单词。' : hasPronunciation ? '当前资料未匹配到原文，请听发音或参考音标填写单词。' : '请将提示字母排列为单词。')
      : '补全原文中的单词，留意词形；已收录的英美拼写变体均可。',
    parts: [], blanks: [],
  };
  const solutions: Solution[] = [];
  function addBlank(expected: string) {
    const id = 'blank-' + (solutions.length + 1);
    exercise.parts.push({ blankId: id });
    exercise.blanks.push({ id, wordId: word.id, firstLetter: Array.from(expected)[0],
      translation: word.translation || '', length: Array.from(expected).length, phonetic });
    solutions.push({ id, wordId: word.id, expected, lemma: word.lemma,
      accepted: [...new Set([normalizeAnswer(expected), ...equivalentSpellings(expected, word.lemma)])] });
  }
  if (source.kind === 'spelling') {
    addBlank(word.lemma);
    if (!hasMeaning && !hasPronunciation) exercise.letterBank = Array.from(word.lemma).sort().join(' ');
  } else {
    let start = Math.max(0, source.start - 150);
    while (start < source.start && start > 0 && !/\s/.test(source.text[start - 1])) start++;
    let end = Math.min(source.text.length, Math.max(source.end + 220, start + 500));
    const boundary = Math.min(source.text.length, end + 100);
    while (end < boundary && !/[.!?\n]/.test(source.text[end - 1])) end++;
    if (end === boundary && end < source.text.length) {
      while (end > source.end && !/\s/.test(source.text[end])) end--;
    }
    if (source.kind === 'collection') { start = 0; end = source.text.length; }
    const excerpt = source.text.slice(start, end);
    let matches = practiceMatches(excerpt, word);
    if (source.kind === 'collection') {
      matches = matches.filter(match => match.end <= source.start || match.start >= source.end);
      matches.push({ start: source.start, end: source.end });
      matches.sort((a, b) => a.start - b.start);
    }
    let cursor = 0;
    if (start > 0) exercise.parts.push({ text: '…' });
    for (const match of matches) {
      if (match.start > cursor) exercise.parts.push({ text: excerpt.slice(cursor, match.start) });
      addBlank(excerpt.slice(match.start, match.end));
      cursor = match.end;
    }
    if (cursor < excerpt.length) exercise.parts.push({ text: excerpt.slice(cursor) });
    if (end < source.text.length) exercise.parts.push({ text: '…' });
    if (!solutions.length) throw new Error('原文题目未能定位目标词');
  }
  return { exercise, solutions };
}

export function buildExercise(bookId: string, targetWordId?: number, mode: SelfTestMode = 'meaning'): StudyExercise | null {
  if (mode !== 'meaning' && mode !== 'spelling') throw new Error('不支持的自测方式');
  if (bookId === COLLECTION_ID && targetWordId !== undefined && isLearningWord(targetWordId, bookId) && !getCollectedSource(targetWordId))
    throw new Error('此收藏尚未保存来源句，请在本地剧情中重新点选这个词后再测试');
  const allowed = new Set<number>(getLearningWords(bookId)
    .filter(word => bookId !== COLLECTION_ID || getCollectedSource(word.id))
    .map(word => word.id));
  const db = openProgressDb();
  return db.transaction(() => {
    const now = new Date().toISOString();
    const reviewed = db.prepare(
      'SELECT c.word_id FROM cards c ' +
      'LEFT JOIN practice_progress p ON p.word_id=c.word_id AND p.book_id=c.book_id ' +
      'LEFT JOIN mastery m ON m.word_id=c.word_id AND m.book_id=c.book_id ' +
      'WHERE c.book_id=? AND c.reps>0 ' +
      'ORDER BY coalesce(p.shown_count,0), ' +
      'CASE WHEN m.practice_correct_at IS NULL THEN 0 ELSE 1 END, ' +
      'CASE WHEN c.due<=? THEN 0 ELSE 1 END, p.last_presented_at, c.due, c.word_id',
    ).all(bookId, now).filter(row => allowed.has(row.word_id));
    const selected = targetWordId === undefined ? reviewed[0] : reviewed.find(row => row.word_id === targetWordId);
    if (!selected) {
      if (targetWordId !== undefined) throw new Error('请先在当前学习列表中复习这个单词，再进行检查');
      return null;
    }
    const word = getWord(selected.word_id);
    if (!word) throw new Error('单词未在当前内容库中找到');
    const payload = bookId === COLLECTION_ID ? createExerciseForWord(bookId, word) : createWordSelfTest(bookId, word, mode);
    db.prepare('INSERT INTO exercise_attempts(id,book_id,payload_json,created_at,reward_version) VALUES(?,?,?,?,2)')
      .run(payload.exercise.id, bookId, JSON.stringify(payload), now);
    db.prepare('INSERT INTO practice_progress(word_id,book_id,shown_count,last_presented_at) VALUES(?,?,1,?) ' +
      'ON CONFLICT(word_id,book_id) DO UPDATE SET shown_count=shown_count+1,last_presented_at=excluded.last_presented_at')
      .run(word.id, bookId, now);
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    db.prepare('DELETE FROM exercise_attempts WHERE created_at < ? AND result_json IS NULL').run(cutoff);
    return payload.exercise;
  })();
}

export function submitExercise(id: string, answers: Record<string, string>): ExerciseResult {
  const db = openProgressDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT book_id,payload_json,result_json,created_at,reward_version FROM exercise_attempts WHERE id=?').get(id);
    if (!row) throw new Error('练习已失效，请生成新题');
    if (row.reward_version !== 2) throw new Error('这是旧版练习，请重新生成单词自测');
    if (row.result_json) return { ...JSON.parse(row.result_json), earned: [], alreadySubmitted: true };
    if (Date.now() - new Date(row.created_at).getTime() > 86400000) throw new Error('练习已过期，请生成新题');
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请填写答案');
    const stored = JSON.parse(row.payload_json);
    const checked = stored.solutions.map(blank => {
      // 兼容旧版本只保存 expected 的题目。
      const accepted = blank.accepted ?? [normalizeAnswer(blank.expected), ...equivalentSpellings(blank.expected, blank.lemma)];
      return { ...blank, correct: typeof answers[blank.id] === 'string' && accepted.includes(normalizeAnswer(answers[blank.id])) };
    });
    const earned = [];
    let selfTest: { first_correct: number; attempts: number } | undefined;
    for (const wordId of new Set<number>(checked.map(blank => blank.wordId))) {
      const correct = checked.filter(blank => blank.wordId === wordId).every(blank => blank.correct);
      const card = getCard(wordId, row.book_id);
      if (!card || card.reps <= 0 || !isLearningWord(wordId, row.book_id)) continue;
      db.prepare('INSERT INTO practice_progress(word_id,book_id,last_checked_at,last_correct) VALUES(?,?,?,?) ' +
        'ON CONFLICT(word_id,book_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_correct=excluded.last_correct')
        .run(wordId, row.book_id, new Date().toISOString(), correct ? 1 : 0);
      const checkedAt = new Date().toISOString();
      db.prepare('INSERT INTO word_self_tests(word_id,book_id,first_correct,last_correct,attempts,first_checked_at,last_checked_at,last_kind) VALUES(?,?,?,?,1,?,?,?) ' +
        'ON CONFLICT(word_id,book_id) DO UPDATE SET last_correct=excluded.last_correct,attempts=attempts+1,last_checked_at=excluded.last_checked_at,last_kind=excluded.last_kind')
        .run(wordId, row.book_id, correct ? 1 : 0, correct ? 1 : 0, checkedAt, checkedAt, stored.exercise.kind);
      selfTest = db.prepare('SELECT first_correct,attempts FROM word_self_tests WHERE word_id=? AND book_id=?').get(wordId, row.book_id);
      if (!correct) recordSelfTestFailure(wordId, row.book_id);
      if (correct) earned.push(...markPractice(wordId, row.book_id));
    }
    const result: ExerciseResult = {
      answers: checked.map(({ id: blankId, correct, expected, lemma }) => ({ id: blankId, correct, expected, lemma })),
      earned, total: getRewards().total, alreadySubmitted: false,
      firstCorrect: Boolean(selfTest?.first_correct), attempts: selfTest?.attempts,
    };
    db.prepare('UPDATE exercise_attempts SET result_json=? WHERE id=?').run(JSON.stringify(result), id);
    return result;
  })();
}
