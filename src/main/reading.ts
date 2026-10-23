import { paperSections } from './reading-paper-compose';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openProgressDb } from './progress-db';
import { grantReadingReward } from './rewards';
import { READING_BANK, LEGACY_READING_BANK, type ReadingDefinition, type BankQuestion } from './reading-bank';
import { resolveReadingLocation } from './reading-location';
import { bindUnversionedReadingSessions, getReadingDefinition, getReadingParagraphs, getReadingContentRevision,
  getReadingPackageMetadata, getReadingRevisionUnits, getReadingKnownDefinitions } from './reading-package-store';
import {
  READING_LEVELS, type ReadingLevel, type ReadingUnitSummary, type ReadingUnit, type ReadingCompletionStatus,
  type ReadingAnswerResult, type ReadingAnalysis, type ReadingDocument, type ReadingPaperResult,
} from '../shared/reading';
import type { ReadingRewardEntry } from '../shared/rewards';

const PAPER_VERSION = 2;
interface ReadingSessionRow {
  id: string; unit_id: string; created_at: string; answers_viewed_at: string | null; paper_version: number;
  draft_json: string; paper_result_json: string | null; reward_animation_ack_at: string | null;
  content_revision: string | null;
}
interface AnswerRow {
  question_id: string; first_correct: number; last_answer: string; last_correct: number;
  attempts: number; last_assisted: number; hint_used: number;
}
interface PaperRequestRow { attempt_id: string; answers_json: string }
interface MaterialParagraphs { en: Map<string, string[]>; chs: Map<string, string[]>; masked: Map<string, string[]> }

export function ensureReadingSchema(db = openProgressDb()): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS reading_sessions (' +
      'id TEXT PRIMARY KEY,unit_id TEXT NOT NULL,created_at TEXT NOT NULL,answers_viewed_at TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_reading_sessions_unit ON reading_sessions(unit_id,created_at);' +
    'CREATE TABLE IF NOT EXISTS reading_answers (' +
      'attempt_id TEXT NOT NULL,question_id TEXT NOT NULL,first_answer TEXT NOT NULL,first_correct INTEGER NOT NULL,' +
      'last_answer TEXT NOT NULL,last_correct INTEGER NOT NULL,attempts INTEGER NOT NULL,' +
      'last_assisted INTEGER NOT NULL DEFAULT 0,hint_used INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,' +
      'PRIMARY KEY(attempt_id,question_id));' +
    'CREATE INDEX IF NOT EXISTS idx_reading_answers_question ON reading_answers(question_id);' +
    'CREATE TABLE IF NOT EXISTS reading_requests (' +
      'request_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,question_id TEXT NOT NULL,answer TEXT NOT NULL,result_json TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS reading_paper_requests (' +
      'request_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,answers_json TEXT NOT NULL,created_at TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS reading_split_migrations (' +
      'legacy_attempt_id TEXT NOT NULL,unit_id TEXT NOT NULL,migrated_attempt_id TEXT,created_at TEXT NOT NULL,' +
      'PRIMARY KEY(legacy_attempt_id,unit_id));',
  );
  const answerColumns = db.prepare('PRAGMA table_info(reading_answers)').all() as Array<{ name: string }>;
  if (!answerColumns.some(column => column.name === 'hint_used'))
    db.exec('ALTER TABLE reading_answers ADD COLUMN hint_used INTEGER NOT NULL DEFAULT 0');
  const sessionColumns = db.prepare('PRAGMA table_info(reading_sessions)').all() as Array<{ name: string }>;
  const additions = [
    ['paper_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['draft_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['paper_result_json', 'TEXT'],
    ['reward_animation_ack_at', 'TEXT'],
    ['content_revision', 'TEXT'],
  ];
  for (const [name, declaration] of additions)
    if (!sessionColumns.some(column => column.name === name))
      db.exec('ALTER TABLE reading_sessions ADD COLUMN ' + name + ' ' + declaration);
  bindUnversionedReadingSessions();
}

function definition(unitId: string, revision?: string | null): ReadingDefinition {
  return getReadingDefinition(unitId, revision);
}

function loadParagraphs(unitId?: string, revision?: string | null): MaterialParagraphs {
  const paragraphs: MaterialParagraphs = { en: new Map(), chs: new Map(), masked: new Map() };
  const ids = unitId ? [unitId] : [...READING_BANK, ...LEGACY_READING_BANK].map(unit => unit.id);
  for (const id of ids) {
    const source = getReadingParagraphs(id, revision);
    paragraphs.en.set(id, source.en); paragraphs.chs.set(id, source.chs); paragraphs.masked.set(id, source.masked);
  }
  return paragraphs;
}

function session(attemptId: string): ReadingSessionRow {
  if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 128) throw new Error('阅读轮次无效。');
  ensureReadingSchema();
  const row = openProgressDb().prepare('SELECT * FROM reading_sessions WHERE id=?').get(attemptId) as ReadingSessionRow | undefined;
  if (!row) throw new Error('找不到这轮阅读，请重新打开材料。');
  definition(row.unit_id, row.content_revision);
  return row;
}

function requireCurrentPaper(current: ReadingSessionRow): void {
  if (current.content_revision && getReadingRevisionUnits(current.content_revision).legacyUnits.some(unit => unit.id === current.unit_id))
    throw new Error('旧版组卷已拆为独立阅读，请打开对应篇目继续。');
  if (current.paper_version !== PAPER_VERSION) throw new Error('这是旧版逐题练习，请重新打开材料开始整篇练习。');
  const latest = openProgressDb().prepare(
    'SELECT id FROM reading_sessions WHERE unit_id=? AND paper_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
  ).get(current.unit_id, PAPER_VERSION) as { id: string } | undefined;
  if (latest?.id !== current.id) throw new Error('此轮练习已结束，请重新打开阅读材料。');
}

function totalRewards(): number {
  return (openProgressDb().prepare('SELECT COUNT(*) AS total FROM reward_ledger').get() as { total: number }).total;
}
function isRewarded(_unitId: string, questionId: string): boolean {
  return Boolean(openProgressDb().prepare(
    "SELECT 1 FROM reward_ledger WHERE source='reading' AND item_id=?",
  ).get(questionId));
}
function publicQuestion(question: BankQuestion) {
  const { expected: _expected, accepted: _accepted, solution: _solution, ...publicFields } = question;
  return publicFields;
}
/** Completion belongs to a submitted passage, independently of first-answer rewards.
 * Keep a historical perfect round even after a learner starts another draft.
 * Historical group results are restricted to this passage's question IDs. */
function completionStatus(unit: ReadingDefinition): ReadingCompletionStatus {
  const owners = [unit.id, ...new Set(getReadingKnownDefinitions().legacyUnits.filter(old =>
    old.paper?.passages.some(passage => passage.id === unit.id)).map(old => old.id))];
  const rows = openProgressDb().prepare(
    'SELECT paper_result_json FROM reading_sessions WHERE unit_id IN (' + owners.map(() => '?').join(',') +
    ') AND paper_version=? AND paper_result_json IS NOT NULL ORDER BY created_at DESC,rowid DESC',
  ).iterate(...owners, PAPER_VERSION) as Iterable<{ paper_result_json: string }>;
  let completed = false;
  for (const row of rows) {
    let results: ReadingPaperResult['questionResults'] | undefined;
    try { results = (JSON.parse(row.paper_result_json) as ReadingPaperResult | null)?.questionResults; }
    catch { continue; }
    if (!unit.questions.length || !unit.questions.every(question => typeof results?.[question.id]?.correct === 'boolean')) continue;
    completed = true;
    if (unit.questions.every(question => results![question.id].correct)) return 'perfect';
  }
  return completed ? 'completed' : 'unsubmitted';
}
function summary(unit: ReadingDefinition, revision?: string | null): ReadingUnitSummary {
  ensureReadingSchema();
  const ids = unit.questions.map(question => question.id);
  const placeholders = ids.map(() => '?').join(',');
  const first = openProgressDb().prepare(
    'SELECT COUNT(*) AS answered,COALESCE(SUM(first_correct),0) AS firstCorrect FROM reading_answers ' +
    'WHERE rowid IN (SELECT MIN(rowid) FROM reading_answers WHERE question_id IN (' + placeholders + ') GROUP BY question_id)',
  ).get(...ids) as { answered: number; firstCorrect: number };
  const rewarded = (openProgressDb().prepare(
    "SELECT COUNT(*) AS n FROM reward_ledger WHERE source='reading' AND item_id IN (" + placeholders + ')',
  ).get(...ids) as { n: number }).n;
  return {
    id: unit.id, title: unit.title, level: unit.level, background: unit.background, wordCount:unit.paper?(loadParagraphs(unit.id, revision).en.get(unit.id)!.join(' ').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]).length:unit.wordCount,
    kind:unit.paper && unit.paper.passages.length > 1 ? 'paper' : 'single',
    passageCount:unit.paper?.passages.length ?? 1,
    practiceType:unit.paper?.passages[0]?.type ?? 'reading',
    estimatedMinutes:unit.estimatedMinutes ?? Math.max(3, Math.ceil((unit.paper ?
      (loadParagraphs(unit.id, revision).en.get(unit.id)!.join(' ').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length : unit.wordCount) /
      (unit.level === 'entry' ? 60 : unit.level === 'sh_zhongkao' ? 80 : 110) + unit.questions.length * 0.65)),
    questionCount: unit.questions.length, answered: first.answered, firstCorrect: first.firstCorrect, rewarded,
    completionStatus: completionStatus(unit),
    ...getReadingPackageMetadata(unit.id, revision),
  };
}

export function listReadingUnits(level?: ReadingLevel): ReadingUnitSummary[] {
  if (level !== undefined && !Object.prototype.hasOwnProperty.call(READING_LEVELS, level)) throw new Error('阅读级别无效。');
  loadParagraphs();
  return READING_BANK.filter(unit => !level || unit.level === level).map(unit => summary(unit));
}
function documentUnit(unit: ReadingDefinition, revision?: string | null): Omit<ReadingUnit, 'attemptId'> {
  const source = loadParagraphs(unit.id, revision);
  const visibleParagraphs=[...(source.masked.get(unit.id)??source.en.get(unit.id)!)];
  return {
    ...summary(unit, revision), sourceTitle: unit.sourceTitle, sourceUrl: unit.sourceUrl,
    coverPath: unit.coverPath, coverFocus: unit.coverFocus, paragraphs:visibleParagraphs, sections:unit.paper?paperSections(unit.paper,visibleParagraphs):undefined,
    glossary: unit.paper ? [] : unit.glossary, questions: unit.questions.map(publicQuestion),
  };
}

function restorePaper(current: ReadingSessionRow): ReadingPaperResult | null {
  if (!current.paper_result_json) return null;
  const stored = JSON.parse(current.paper_result_json) as ReadingPaperResult;
  const questionResults = Object.fromEntries(Object.entries(stored.questionResults).map(([id, result]) =>
    [id, { ...result, earned: [], duplicate: true }]));
  return {
    ...stored, earned: [], questionResults, duplicate: true,
    rewardAnimationPending: stored.earnedCount > 0 && !current.reward_animation_ack_at,
  };
}

function unitSnapshot(unit: ReadingDefinition, current: ReadingSessionRow): Omit<ReadingUnit, 'attemptId'> {
  const paperResult = restorePaper(current);
  const legacyRows = !paperResult && current.paper_version < PAPER_VERSION
    ? openProgressDb().prepare('SELECT * FROM reading_answers WHERE attempt_id=?').all(current.id) as AnswerRow[] : [];
  const answers: Record<string, string> = paperResult?.answers ?? (current.paper_version === PAPER_VERSION
    ? JSON.parse(current.draft_json) : Object.fromEntries(legacyRows.map(row => [row.question_id, row.last_answer])));
  return {
    ...documentUnit(unit, current.content_revision), answers,
    answerResults: paperResult?.questionResults ?? Object.fromEntries(getReadingAttemptResults(current.id).map(result => [result.questionId, result])),
    answersViewed: Boolean(current.answers_viewed_at), paperResult,
    rewardAnimationPending: paperResult?.rewardAnimationPending ?? false,
  };
}

/** Copy a historical group snapshot into its independent practice without granting rewards.
 * Existing independent progress always wins; originals remain untouched for source history. */
function copyLegacyReadingAttempt(sourceUnit: ReadingDefinition, previous: ReadingSessionRow,
  db: Database.Database, historicalSource = false): ReadingSessionRow {
  const ids = new Set(sourceUnit.questions.map(question => question.id));
  const oldResult = previous.paper_result_json ? JSON.parse(previous.paper_result_json) as ReadingPaperResult : null;
  const storedAnswers = db.prepare('SELECT * FROM reading_answers WHERE attempt_id=?').all(previous.id) as Array<AnswerRow & {
    first_answer: string; updated_at: string;
  }>;
  const oldAnswers: Record<string, string> = oldResult?.answers ?? (previous.paper_version === PAPER_VERSION
    ? JSON.parse(previous.draft_json) : Object.fromEntries(storedAnswers.map(answer => [answer.question_id, answer.last_answer])));
  const answers = validateAnswers(sourceUnit, Object.fromEntries(Object.entries(oldAnswers).filter(([id]) => ids.has(id))), false);
  let result: ReadingPaperResult | null = null;
  const id = randomUUID();
  if (oldResult && sourceUnit.questions.every(question => oldResult.questionResults[question.id] && answers[question.id]?.trim())) {
    const questionResults = Object.fromEntries(sourceUnit.questions.map(question => [question.id, {
      ...oldResult.questionResults[question.id], earned: [], duplicate: true,
    }]));
    const correct = Object.values(questionResults).filter(answer => answer.correct).length;
    const earnedCount = (oldResult.earned ?? []).filter(reward => ids.has(reward.questionId)).length;
    result = { ...oldResult, attemptId: id, answers, questionResults, correct, total: sourceUnit.questions.length,
      score: correct, maxScore: sourceUnit.questions.length, earned: [], earnedCount,
      rewardAnimationPending: false, duplicate: true };
  }
  let createdAt = previous.created_at;
  if (historicalSource) {
    const latest = db.prepare('SELECT created_at FROM reading_sessions WHERE unit_id=? AND paper_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
      .get(sourceUnit.id, PAPER_VERSION) as { created_at: string } | undefined;
    // A derived source snapshot must not become the learner's current independent round.
    if (latest && createdAt >= latest.created_at) createdAt = new Date(Date.parse(latest.created_at) - 1).toISOString();
  }
  db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,paper_version,answers_viewed_at,draft_json,paper_result_json,reward_animation_ack_at,content_revision) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, sourceUnit.id, createdAt, PAPER_VERSION, previous.answers_viewed_at, JSON.stringify(answers),
      result ? JSON.stringify(result) : null, result ? new Date().toISOString() : null, previous.content_revision);
  const copyAnswer = db.prepare('INSERT INTO reading_answers(attempt_id,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const answer of storedAnswers) if (ids.has(answer.question_id)) copyAnswer.run(id, answer.question_id,
    answer.first_answer, answer.first_correct, answer.last_answer, answer.last_correct, answer.attempts,
    answer.last_assisted, answer.hint_used, answer.updated_at);
  return db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(id) as ReadingSessionRow;
}

function migrateLegacyReading(unit: ReadingDefinition, db: Database.Database): void {
  const owners = [...new Map(getReadingKnownDefinitions().legacyUnits.filter(old =>
    old.paper?.passages.some(passage => passage.id === unit.id)).map(old => [old.id, old])).values()];
  for (const owner of owners) {
    const previous = db.prepare('SELECT * FROM reading_sessions WHERE unit_id=? AND paper_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
      .get(owner.id, PAPER_VERSION) as ReadingSessionRow | undefined;
    if (!previous || db.prepare('SELECT 1 FROM reading_split_migrations WHERE legacy_attempt_id=? AND unit_id=?').get(previous.id, unit.id)) continue;
    if (!definition(owner.id, previous.content_revision).paper?.passages.some(passage => passage.id === unit.id)) continue;
    const sourceUnit = definition(unit.id, previous.content_revision);
    const recordMigration = (attemptId: string | null) => db.prepare('INSERT INTO reading_split_migrations(legacy_attempt_id,unit_id,migrated_attempt_id,created_at) VALUES(?,?,?,?)')
      .run(previous.id, unit.id, attemptId, new Date().toISOString());
    if (db.prepare('SELECT 1 FROM reading_sessions WHERE unit_id=? AND paper_version=?').get(unit.id, PAPER_VERSION)) {
      recordMigration(null); continue;
    }
    recordMigration(copyLegacyReadingAttempt(sourceUnit, previous, db).id);
  }
}

function restoreLegacySourceAttempt(unitId: string, previous: ReadingSessionRow, db: Database.Database): ReadingSessionRow {
  const parent = definition(previous.unit_id, previous.content_revision);
  if (!getReadingRevisionUnits(previous.content_revision!).legacyUnits.some(unit => unit.id === parent.id) ||
    !parent.paper?.passages.some(passage => passage.id === unitId)) throw new Error('阅读轮次与材料不匹配。');
  const mapping = db.prepare('SELECT migrated_attempt_id FROM reading_split_migrations WHERE legacy_attempt_id=? AND unit_id=?')
    .get(previous.id, unitId) as { migrated_attempt_id: string | null } | undefined;
  if (mapping?.migrated_attempt_id) {
    const existing = session(mapping.migrated_attempt_id);
    if (existing.unit_id !== unitId || existing.content_revision !== previous.content_revision) throw new Error('阅读来源映射与历史版本不一致。');
    return existing;
  }
  const child = copyLegacyReadingAttempt(definition(unitId, previous.content_revision), previous, db, true);
  db.prepare('INSERT INTO reading_split_migrations(legacy_attempt_id,unit_id,migrated_attempt_id,created_at) VALUES(?,?,?,?) ' +
    'ON CONFLICT(legacy_attempt_id,unit_id) DO UPDATE SET migrated_attempt_id=excluded.migrated_attempt_id')
    .run(previous.id, unitId, child.id, new Date().toISOString());
  return child;
}

export function getReadingUnit(unitId: string, startNew = false, attemptId?: string): ReadingUnit {
  if (typeof startNew !== 'boolean') throw new Error('新轮次参数无效。');
  if (attemptId !== undefined && (typeof attemptId !== 'string' || !attemptId || attemptId.length > 128))
    throw new Error('阅读轮次无效。');
  if (attemptId !== undefined && !startNew) {
    const previous = session(attemptId);
    const location = resolveReadingLocation(unitId, { attemptId });
    return openProgressDb().transaction(() => {
      const current = previous.unit_id === location.unitId ? previous
        : restoreLegacySourceAttempt(location.unitId, previous, openProgressDb());
      return { ...unitSnapshot(definition(current.unit_id, current.content_revision), current), attemptId: current.id };
    })();
  }
  const unit = definition(resolveReadingLocation(unitId).unitId);
  unitId = unit.id;
  loadParagraphs();
  ensureReadingSchema();
  const db = openProgressDb();
  return db.transaction(() => {
    migrateLegacyReading(unit, db);
    let current = db.prepare(
      'SELECT * FROM reading_sessions WHERE unit_id=? AND paper_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
    ).get(unitId, PAPER_VERSION) as ReadingSessionRow | undefined;
    if (startNew || !current) {
      const id = randomUUID();
      db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,paper_version,content_revision) VALUES(?,?,?,?,?)')
        .run(id, unitId, new Date().toISOString(), PAPER_VERSION, getReadingContentRevision(unitId));
      current = session(id);
    }
    return { ...unitSnapshot(definition(unitId, current.content_revision), current), attemptId: current.id };
  })();
}

export function assertReadingAttempt(attemptId: string, unitId: string): void {
  if (session(attemptId).unit_id !== unitId) throw new Error('阅读轮次与材料不匹配。');
}
function normalizeAnswer(answer: string): string {
  return answer.normalize('NFKC').replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ').replace(/[.,!?;:。！？，；：]+$/g, '').toLowerCase();
}
function validateAnswers(unit: ReadingDefinition, answers: Record<string, string>, complete: boolean): Record<string, string> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('答卷格式无效。');
  const questions = new Map(unit.questions.map(question => [question.id, question]));
  for (const key of Object.keys(answers)) if (!questions.has(key)) throw new Error('答卷包含不属于本篇的题目。');
  const canonical: Record<string, string> = {};
  for (const question of unit.questions) {
    const raw = answers[question.id];
    if (raw === undefined) {
      if (complete) throw new Error('请完成本篇全部题目后再交卷。');
      continue;
    }
    if (typeof raw !== 'string' || raw.length > 512) throw new Error('答案格式无效。');
    const value = question.type === 'choice' ? raw.trim().toUpperCase() : normalizeAnswer(raw);
    if (!value) {
      if (complete) throw new Error('请完成本篇全部题目后再交卷。');
      canonical[question.id] = '';
      continue;
    }
    if (question.type === 'choice' && !question.options?.some(option => option.id === value))
      throw new Error('请选择题目提供的选项。');
    canonical[question.id] = complete ? value : raw;
  }
  return canonical;
}

export function saveReadingDraft(attemptId: string, answers: Record<string, string>): boolean {
  const current = session(attemptId);
  requireCurrentPaper(current);
  if (current.paper_result_json) return false;
  const canonical = validateAnswers(definition(current.unit_id, current.content_revision), answers, false);
  openProgressDb().prepare('UPDATE reading_sessions SET draft_json=? WHERE id=? AND paper_result_json IS NULL')
    .run(JSON.stringify(canonical), attemptId);
  return true;
}

export function submitReadingPaper(attemptId: string, answers: Record<string, string>, requestId: string): ReadingPaperResult {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('提交编号无效。');
  const current = session(attemptId);
  const unit = definition(current.unit_id, current.content_revision);
  loadParagraphs(unit.id, current.content_revision);
  const canonical = validateAnswers(unit, answers, true);
  const serialized = JSON.stringify(canonical);
  const db = openProgressDb();
  return db.transaction(() => {
    const fresh = session(attemptId);
    const cached = db.prepare('SELECT attempt_id,answers_json FROM reading_paper_requests WHERE request_id=?')
      .get(requestId) as PaperRequestRow | undefined;
    if (cached && (cached.attempt_id !== attemptId || cached.answers_json !== serialized))
      throw new Error('提交编号已用于另一份答卷，请重新提交。');
    const existing = restorePaper(fresh);
    if (existing) {
      if (JSON.stringify(existing.answers) !== serialized) throw new Error('本轮已交卷，不能修改答案；请开始新一轮。');
      if (!cached) db.prepare('INSERT INTO reading_paper_requests(request_id,attempt_id,answers_json,created_at) VALUES(?,?,?,?)')
        .run(requestId, attemptId, serialized, new Date().toISOString());
      return existing;
    }
    if (cached) throw new Error('答卷记录不完整，请重新打开材料。');
    requireCurrentPaper(fresh);
    const now = new Date().toISOString();
    const assisted = Boolean(fresh.answers_viewed_at);
    const grades = unit.questions.map(question => ({
      question, correct: [question.expected, ...(question.accepted ?? [])].some(
        expected => (question.type === 'choice' ? expected : normalizeAnswer(expected)) === canonical[question.id],
      ),
    }));
    const earned: ReadingRewardEntry[] = [];
    for (const { question, correct } of grades) {
      // 首答内部记录不因新模式删除；整卷曝光后的作答仅用于得分，不发新奖励。
      db.prepare(
        'INSERT INTO reading_answers(attempt_id,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at)' +
        ' VALUES(?,?,?,?,?,?,1,?,0,?)',
      ).run(attemptId, question.id, canonical[question.id], correct && !assisted ? 1 : 0, canonical[question.id], correct ? 1 : 0, assisted ? 1 : 0, now);
      if (correct && !assisted && !isRewarded(unit.id,question.id)) earned.push(...grantReadingReward(unit, question, now, attemptId));
    }
    const rewardTotal = totalRewards();
    const questionResults = Object.fromEntries(grades.map(({ question, correct }) => [question.id, {
      questionId: question.id, correct, firstCorrect: correct && !assisted, attempts: 1, earned: [],
      total: rewardTotal, rewarded: isRewarded(unit.id, question.id), duplicate: false, assisted, hintUsed: false,
    } satisfies ReadingAnswerResult]));
    const correct = grades.filter(grade => grade.correct).length;
    const result: ReadingPaperResult = {
      attemptId, score: correct, maxScore: unit.questions.length, correct, total: unit.questions.length,
      answers: canonical, questionResults, earned, earnedCount: earned.length,
      rewardAnimationPending: earned.length > 0, duplicate: false, submittedAt: now, assisted,
    };
    db.prepare('UPDATE reading_sessions SET draft_json=?,paper_result_json=? WHERE id=?')
      .run(serialized, JSON.stringify(result), attemptId);
    db.prepare('INSERT INTO reading_paper_requests(request_id,attempt_id,answers_json,created_at) VALUES(?,?,?,?)')
      .run(requestId, attemptId, serialized, now);
    return result;
  })();
}

export function acknowledgeReadingReward(attemptId: string): boolean {
  const current = session(attemptId);
  const result = restorePaper(current);
  if (!result || result.earnedCount <= 0 || current.reward_animation_ack_at) return false;
  return Boolean(openProgressDb().prepare(
    'UPDATE reading_sessions SET reward_animation_ack_at=? WHERE id=? AND reward_animation_ack_at IS NULL AND paper_result_json IS NOT NULL',
  ).run(new Date().toISOString(), attemptId).changes);
}

export function getReadingAttemptResults(attemptId: string): ReadingAnswerResult[] {
  const current = session(attemptId);
  const paper = restorePaper(current);
  if (paper) return Object.values(paper.questionResults);
  const unit = definition(current.unit_id, current.content_revision);
  const total = totalRewards();
  const rows = openProgressDb().prepare('SELECT * FROM reading_answers WHERE attempt_id=?').all(attemptId) as AnswerRow[];
  return unit.questions.flatMap(question => {
    const row = rows.find(item => item.question_id === question.id);
    return row ? [{
      questionId: row.question_id, correct: Boolean(row.last_correct), firstCorrect: Boolean(row.first_correct),
      attempts: row.attempts, earned: [], total, rewarded: isRewarded(unit.id, row.question_id),
      duplicate: true, assisted: Boolean(row.last_assisted), hintUsed: Boolean(row.hint_used),
    }] : [];
  });
}

export function markReadingAnswersViewed(attemptId: string, unitId?: string): void {
  const current = session(attemptId);
  if (unitId !== undefined && current.unit_id !== unitId) throw new Error('阅读轮次与材料不匹配。');
  openProgressDb().prepare('UPDATE reading_sessions SET answers_viewed_at=COALESCE(answers_viewed_at,?) WHERE id=?')
    .run(new Date().toISOString(), attemptId);
}

export function getReadingDocument(unitId: string, attemptId?: string): ReadingDocument {
  const current = attemptId === undefined ? undefined : session(attemptId);
  const unit = definition(unitId, current?.content_revision);
  const document = current === undefined ? documentUnit(unit) : (() => {
    assertReadingAttempt(current.id, unitId);
    return unitSnapshot(unit, current);
  })();
  const paragraphs = loadParagraphs(unit.id, current?.content_revision);
  return {
    unit: document,
    analysis: {
      ...unit.analysis, glossary: [...new Map([...unit.glossary, ...(unit.analysisGlossary ?? [])].map(entry=>[
        entry.term.toLowerCase()+'\u0000'+entry.explanation,entry,
      ])).values()],
      questions: unit.questions.map(question => question.solution),
      bilingualParagraphs: paragraphs.en.get(unit.id)!.map((textEn, index) => ({
        paragraph: index + 1, textEn, textChs: paragraphs.chs.get(unit.id)![index],
      })),
    },
  };
}

export function getReadingAnalysis(attemptId: string): ReadingAnalysis {
  const current = session(attemptId);
  const unit = definition(current.unit_id, current.content_revision);
  const legacyComplete = current.paper_version < PAPER_VERSION &&
    getReadingAttemptResults(attemptId).length === unit.questions.length;
  if (!current.paper_result_json && !current.answers_viewed_at && !legacyComplete)
    throw new Error('请完成本篇并交卷后，再查看完整讲解。');
  const analysis = getReadingDocument(unit.id, attemptId).analysis;
  markReadingAnswersViewed(attemptId, unit.id);
  return analysis;
}

/** 仅把已交卷/已进入解析的官方原文交给阅读收藏入口；所有偏移均相对原始英文段落。 */
export function getReadingParagraphForCollection(attemptId: string, paragraph: number) {
  if (!Number.isSafeInteger(paragraph) || paragraph < 1) throw new Error('阅读段落编号无效。');
  const current = session(attemptId);
  if (!current.paper_result_json && !current.answers_viewed_at) throw new Error('请交卷进入解析后再收藏阅读单词。');
  const unit = definition(current.unit_id, current.content_revision);
  const paragraphs = loadParagraphs(unit.id, current.content_revision);
  const textEn = paragraphs.en.get(unit.id)![paragraph - 1];
  const textChs = paragraphs.chs.get(unit.id)![paragraph - 1];
  if (textEn === undefined || textChs === undefined) throw new Error('阅读段落编号无效。');
  const section=unit.paper?paperSections(unit.paper).find(s=>s.paragraphIndices.includes(paragraph)):undefined;
  return {unitId:unit.id,title:section && unit.paper!.passages.length > 1 ? unit.title+' · '+section.title : unit.title,sourceTitle:section?.sourceTitle??unit.sourceTitle,sourceUrl:section?.sourceUrl??unit.sourceUrl,coverPath:section?.coverPath??unit.coverPath,paragraph,textEn,textChs};
}
