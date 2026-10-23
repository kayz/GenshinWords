import type { WordExample, WordSummary } from '../shared/models';
import type { CollectRequest, CollectResult, CollectedSource, CollectionEntry, ReadingCollectedSource } from '../shared/collection';
import { COLLECTION_ID } from '../shared/collection';
import { wordTokens } from '../shared/text';
import { getReadingAttemptContext, resolveReadingLocation } from './reading-location';
import { READING_BANK } from './reading-bank';
import { bindUnversionedReadingSessions, getReadingDefinition, getReadingParagraphs } from './reading-package-store';
import { openProgressDb } from './progress-db';
import { openContentDb, getWord, lookupWordByLemma, speakerDisplayName, getSpeakerPortrait } from './content-db';

function inferCollectedReadingAttempt(source: ReadingCollectedSource): string | undefined {
  bindUnversionedReadingSessions();
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_sessions'").get()) return;
  const digest = typeof source.coverPath === 'string' ? /^gwreading\/([a-f0-9]{64})\//.exec(source.coverPath)?.[1] : undefined;
  const rows = db.prepare('SELECT id,content_revision FROM reading_sessions WHERE unit_id=? AND content_revision IS NOT NULL ' +
    'AND created_at<=? AND (paper_result_json IS NOT NULL OR answers_viewed_at IS NOT NULL)').all(source.unitId, source.collectedAt) as
    Array<{ id: string; content_revision: string }>;
  const matches = rows.filter(row => {
    if (digest && row.content_revision !== digest) return false;
    try {
      const paragraphs = getReadingParagraphs(source.unitId, row.content_revision);
      return paragraphs.en[source.paragraph - 1]?.includes(source.text) && paragraphs.chs[source.paragraph - 1] === source.textChs;
    } catch { return false; }
  });
  return matches.length === 1 ? matches[0].id : undefined;
}

export function getCollectedSource(wordId: number): CollectedSource | null {
  const row = openProgressDb().prepare('SELECT source_json FROM collected_words WHERE word_id=? AND active=1').get(wordId);
  if (!row?.source_json) return null;
  try {
    const source = JSON.parse(row.source_json);
    if (source.kind !== 'collection' || typeof source.text !== 'string' || !Number.isSafeInteger(source.start) ||
      !Number.isSafeInteger(source.end) || source.start < 0 || source.end <= source.start || source.end > source.text.length ||
      source.text.slice(source.start, source.end) !== source.surface) return null;
    if (source.origin === 'reading' && typeof source.unitId === 'string') {
      try {
        const attemptId = source.attemptId ?? inferCollectedReadingAttempt(source);
        const location = resolveReadingLocation(source.unitId, { paragraph: source.paragraph, attemptId });
        const historical = attemptId ? { ...source, attemptId } : source;
        if (location.unitId === source.unitId) return historical;
        const unit = attemptId ? getReadingDefinition(location.unitId, getReadingAttemptContext(attemptId).content_revision)
          : READING_BANK.find(item => item.id === location.unitId);
        if (unit) return { ...historical, unitId: unit.id, paragraph: location.paragraph ?? source.paragraph, title: unit.title };
      } catch { /* Keep the saved first source even if its old location is unavailable. */ }
    }
    return source;
  } catch {
    return null;
  }
}

export function listCollection(): CollectionEntry[] {
  const rows = openProgressDb().prepare('SELECT w.word_id,w.created_at,c.reps,c.due FROM collected_words w ' +
    'LEFT JOIN cards c ON c.word_id=w.word_id AND c.book_id=? WHERE w.active=1 ORDER BY w.created_at,w.word_id').all(COLLECTION_ID);
  return rows.flatMap(row => {
    const word = getWord(row.word_id);
    return word ? [{ word, createdAt: row.created_at, source: getCollectedSource(word.id), reviewed: row.reps > 0, due: row.due || null }] : [];
  });
}

export function collectFromDialogue(request: CollectRequest): CollectResult {
  if (!request || !Number.isSafeInteger(request.lineId) || !Number.isSafeInteger(request.start) ||
    !Number.isSafeInteger(request.end) || request.start < 0 || request.end <= request.start) throw new Error('请选择本地台词中的完整单词');
  const content = openContentDb();
  const line = content?.prepare('SELECT d.*,q.chapter_id,q.title_en AS quest_title_en,q.title_chs AS quest_title_chs,' +
    'c.title_en AS chapter_title_en,c.title_chs AS chapter_title_chs,c.cover_path FROM dialog_lines d ' +
    'JOIN quests q ON q.id=d.quest_id JOIN chapters c ON c.id=q.chapter_id WHERE d.id=?').get(request.lineId);
  if (!line) throw new Error('未找到这条本地台词');
  const token = wordTokens(line.text_en).find(part => part.start === request.start && part.end === request.end);
  if (!token) throw new Error('请选择本地台词中的完整单词');
  const word = lookupWordByLemma(token.text);
  if (!word) throw new Error('本地词库未收录：' + token.text);
  const segments = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(line.text_en);
  const sentence = Array.from(segments).find(segment => segment.index <= token.start && segment.index + segment.segment.length >= token.end);
  if (!sentence) throw new Error('无法定位单词所在的原句');
  const now = new Date().toISOString();
  const source: CollectedSource = {
    kind: 'collection', origin: 'dialogue', title: line.quest_title_chs || line.quest_title_en || '收藏来源',
    sourceTitle: line.chapter_title_chs || line.chapter_title_en || '本地剧情',
    sourceUrl: null, coverPath: line.cover_path || null,
    speaker: speakerDisplayName(content, line.speaker, line.id),
    text: sentence.segment, start: token.start - sentence.index, end: token.end - sentence.index,
    textChs: line.text_chs || '', surface: token.text,
    lineId: line.id, questId: line.quest_id, chapterId: line.chapter_id, collectedAt: now,
  };
  return saveCollectedWord(word, source);
}

/** 对话与阅读共用一份收藏：按本地wordId去重，首次来源不替换，移除恢复保留快照。 */
export function saveCollectedWord(word: WordSummary, source: CollectedSource): CollectResult {
  const db = openProgressDb();
  return db.transaction((): CollectResult => {
    const prior = db.prepare('SELECT active,source_json FROM collected_words WHERE word_id=?').get(word.id);
    if (prior?.source_json) {
      db.prepare('UPDATE collected_words SET active=1 WHERE word_id=?').run(word.id);
      return { word, status: prior.active ? 'existing' : 'restored' };
    }
    db.prepare('INSERT INTO collected_words(word_id,created_at,source_json,active) VALUES(?,?,?,1) ' +
      'ON CONFLICT(word_id) DO UPDATE SET source_json=excluded.source_json,active=1')
      .run(word.id, source.collectedAt, JSON.stringify(source));
    return { word, status: prior ? 'source-added' : 'added' };
  })();
}

export function removeCollectedWord(wordId: number) {
  return openProgressDb().prepare('UPDATE collected_words SET active=0 WHERE word_id=?').run(wordId).changes > 0;
}

export function restoreCollectedWord(wordId: number) {
  if (!getWord(wordId)) throw new Error('单词已不在本地词库中');
  return openProgressDb().prepare('UPDATE collected_words SET active=1 WHERE word_id=?').run(wordId).changes > 0;
}

export function getCollectionReview(wordId: number): WordExample[] {
  const source = getCollectedSource(wordId);
  return source ? [{
    portrait: getSpeakerPortrait(source.speaker || ''),
    text_en: source.text, text_chs: source.textChs, speaker: source.speaker || '', surface: source.surface,
    image_path: source.coverPath, image_kind: 'landscape', source_label: '收录时原句',
    chapter_title_chs: source.sourceTitle, quest_title_chs: source.title, quest_title_en: source.title,
  }] : [];
}
