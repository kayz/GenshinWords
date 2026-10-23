import { activeReadingUnits, activeLegacyReadingUnits, bindUnversionedReadingSessions, getReadingDefinition, getReadingKnownDefinitions, getReadingRevisionUnits } from './reading-package-store';
import { openProgressDb } from './progress-db';
import type { ReadingLocation, ReadingLocationRequest } from '../shared/reading';

/** A source link carries the originating attempt, including before an old group is split. */
export function getReadingAttemptContext(attemptId: string) {
  if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 128) throw new Error('阅读轮次无效。');
  bindUnversionedReadingSessions();
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_sessions'").get())
    throw new Error('找不到这轮阅读，请重新打开材料。');
  const row = db.prepare('SELECT id,unit_id,content_revision FROM reading_sessions WHERE id=?').get(attemptId) as
    { id: string; unit_id: string; content_revision: string | null } | undefined;
  if (!row?.content_revision) throw new Error('找不到这轮阅读的内容版本。');
  return { ...row, definition: getReadingDefinition(row.unit_id, row.content_revision) };
}

function inferArchivedQuestionAttempt(unitId: string, questionId: string): string | undefined {
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_answers'").get()) return;
  const rows = db.prepare('SELECT DISTINCT s.id FROM reading_sessions s JOIN reading_answers a ON a.attempt_id=s.id ' +
    'WHERE a.question_id=? AND s.content_revision IS NOT NULL').all(questionId) as Array<{ id: string }>;
  const candidates = new Set(rows.flatMap(row => {
    try {
      const context = getReadingAttemptContext(row.id);
      if (context.unit_id !== unitId && !context.definition.paper?.passages.some(passage => passage.id === unitId)) return [];
      return getReadingDefinition(unitId, context.content_revision).questions.some(question => question.id === questionId) ? [row.id] : [];
    } catch { return []; }
  }));
  if (candidates.size === 0) {
    const drafts = db.prepare('SELECT id,draft_json FROM reading_sessions WHERE content_revision IS NOT NULL').all() as
      Array<{ id: string; draft_json: string }>;
    for (const draft of drafts) {
      try {
        const answers: unknown = JSON.parse(draft.draft_json);
        if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
          !Object.prototype.hasOwnProperty.call(answers, questionId) || typeof answers[questionId] !== 'string') continue;
        const context = getReadingAttemptContext(draft.id);
        if (context.unit_id !== unitId && !context.definition.paper?.passages.some(passage => passage.id === unitId)) continue;
        if (getReadingDefinition(unitId, context.content_revision).questions.some(question => question.id === questionId))
          candidates.add(draft.id);
      } catch { /* A malformed draft cannot identify a historical source. */ }
    }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_split_migrations'").get()) {
    const mappings = db.prepare('SELECT legacy_attempt_id,migrated_attempt_id FROM reading_split_migrations WHERE migrated_attempt_id IS NOT NULL').all() as
      Array<{ legacy_attempt_id: string; migrated_attempt_id: string }>;
    for (const mapping of mappings) if (candidates.has(mapping.legacy_attempt_id) && candidates.has(mapping.migrated_attempt_id))
      candidates.delete(mapping.legacy_attempt_id);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function restoreArchivedQuestionLocation(unitId: string, options: ReadingLocationRequest): ReadingLocation {
  const attemptId = inferArchivedQuestionAttempt(unitId, options.questionId!);
  if (!attemptId) throw new Error('旧版题目来源缺少可唯一恢复的阅读轮次，请从原收藏或奖励打开。');
  return resolveReadingLocation(unitId, { ...options, attemptId });
}

/** Current locations take precedence; archived locations keep saved links usable. */
export function resolveReadingLocation(unitId: string, options: ReadingLocationRequest = {}): ReadingLocation {
  if (typeof unitId !== 'string' || !options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('阅读来源位置无效。');
  if (options.questionId !== undefined && (typeof options.questionId !== 'string' || !options.questionId))
    throw new Error('阅读来源题号无效。');
  if (options.paragraph !== undefined && (!Number.isSafeInteger(options.paragraph) || options.paragraph < 1))
    throw new Error('阅读来源段落无效。');
  const context = options.attemptId === undefined ? undefined : getReadingAttemptContext(options.attemptId);
  if (context && context.unit_id !== unitId && !context.definition.paper?.passages.some(passage => passage.id === unitId))
    throw new Error('阅读轮次与材料不匹配。');
  const definitions = context ? getReadingRevisionUnits(context.content_revision) : getReadingKnownDefinitions();
  const attempt = context ? { attemptId: context.id } : {};
  const matches = (unit: typeof definitions.units[number]) =>
    (options.questionId === undefined || unit.questions.some(question => question.id === options.questionId)) &&
    (options.paragraph === undefined || options.paragraph <= unit.paragraphCount);
  const currentCandidates = definitions.units.filter(unit => unit.id === unitId);
  const current = currentCandidates.find(matches);
  if (current) {
    if (!context && options.questionId !== undefined && !activeReadingUnits.includes(current))
      return restoreArchivedQuestionLocation(unitId, options);
    if (options.questionId !== undefined && !current.questions.some(question => question.id === options.questionId))
      throw new Error('题目不属于此阅读来源。');
    if (options.paragraph !== undefined && options.paragraph > current.paragraphCount)
      throw new Error('段落不属于此阅读来源。');
    return { unitId, ...attempt, ...(options.questionId ? { questionId: options.questionId } : {}),
      ...(options.paragraph === undefined ? {} : { paragraph: options.paragraph }) };
  }
  if (currentCandidates.length) {
    if (options.questionId !== undefined && !currentCandidates.some(unit => unit.questions.some(question => question.id === options.questionId)))
      throw new Error('题目不属于此阅读来源。');
    throw new Error('段落不属于此阅读来源。');
  }
  const old = definitions.legacyUnits.find(unit => unit.id === unitId && matches(unit));
  if (!old?.paper) {
    if (definitions.legacyUnits.some(unit => unit.id === unitId))
      throw new Error(options.questionId !== undefined ? '题目不属于此阅读来源。' : '段落不属于此阅读来源。');
    throw new Error('找不到这篇阅读材料。');
  }
  if (!context && options.questionId !== undefined && !activeLegacyReadingUnits.includes(old))
    return restoreArchivedQuestionLocation(unitId, options);
  let offset = 0;
  const locations = old.paper.passages.map(passage => {
    const item = { passage, start: offset + 1, end: offset + passage.paragraphMap.length };
    offset = item.end;
    return item;
  });
  const byQuestion = options.questionId === undefined ? undefined
    : locations.find(item => item.passage.questions.some(question => question.id === options.questionId));
  const byParagraph = options.paragraph === undefined ? undefined
    : locations.find(item => options.paragraph! >= item.start && options.paragraph! <= item.end);
  if (options.questionId !== undefined && !byQuestion) throw new Error('题目不属于此阅读来源。');
  if (options.paragraph !== undefined && !byParagraph) throw new Error('段落不属于此阅读来源。');
  if (byQuestion && byParagraph && byQuestion !== byParagraph) throw new Error('阅读来源题目与段落不匹配。');
  const match = byQuestion ?? byParagraph ?? locations[0];
  return {
    unitId: match.passage.id, ...attempt,
    ...(options.questionId ? { questionId: options.questionId } : {}),
    ...(options.paragraph === undefined ? {} : { paragraph: options.paragraph - match.start + 1 }),
  };
}
