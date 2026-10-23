import { voiceChapterArtwork, clearVoiceArtworkCache } from './voice-artwork';
import { browsableChapters, chapterCatalog, clearChapterCatalog, normalizeChapter } from './chapter-catalog';
import type { CharacterPortrait, BookSummary, Coverage, WordSummary, Word, Pronunciation, WordExample, VersionSummary, SourceSummary, Chapter, Quest, DialogueLine, StudyOrder } from '../shared/models';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getContentDbPath } from './paths';
import { getEffectiveContentDbPath } from './content-package-store';
import { normalizeAnswer, lookupSpellings } from './spelling';
import { getSetting } from './progress-db';
import { TRAVELERS, normalizeTraveler, isTravelerSpeaker } from '../shared/traveler';


export let contentDb = null;
let speakerPortraits: Map<string, CharacterPortrait> | null = null;
export let speakerNames = null;
export let speakerLineNames = null;
export function openContentDb() {
  if (contentDb) return contentDb;
  const path2 = getEffectiveContentDbPath(getContentDbPath());
  if (!fs.existsSync(path2)) {
    console.warn('content.db not found at', path2);
    return null;
  }
  contentDb = new Database(path2, { readonly: true, fileMustExist: true });
  contentDb.pragma('query_only = ON');
  return contentDb;
}
export function closeContentDb() {
  clearChapterCatalog();
  clearVoiceArtworkCache();
  speakerPortraits = null;
  contentDb?.close();
  contentDb = null;
  speakerNames = null;
  speakerLineNames = null;
}
export function contentAvailable() {
  return fs.existsSync(getEffectiveContentDbPath(getContentDbPath()));
}
export function hasTable(db, name) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return Boolean(row);
}
export function listBooks(): BookSummary[] {
  const db = openContentDb();
  if (!db) return [];
  if (hasTable(db, 'book_coverage')) {
    return db
      .prepare(
        `SELECT b.id, b.name, b.name_zh, b.description,
                coalesce(bc.total, (SELECT COUNT(*) FROM book_words bw WHERE bw.book_id = b.id)) AS word_count,
                coalesce(bc.covered, 0) AS covered,
                coalesce(bc.uncovered, 0) AS uncovered,
                coalesce(bc.coverage_pct, 0) AS coverage_pct
         FROM books b
         LEFT JOIN book_coverage bc ON bc.book_id = b.id
         ORDER BY b.sort_order`,
      )
      .all();
  }
  return db
    .prepare(
      `SELECT b.id, b.name, b.name_zh, b.description,
              (SELECT COUNT(*) FROM book_words bw WHERE bw.book_id = b.id) AS word_count
       FROM books b ORDER BY b.sort_order`,
    )
    .all();
}
export function listCoverage(): Coverage[] {
  const db = openContentDb();
  if (!db || !hasTable(db, 'book_coverage')) return [];
  return db
    .prepare(
      `SELECT bc.book_id, b.name_zh, bc.total, bc.covered, bc.uncovered, bc.coverage_pct
       FROM book_coverage bc
       JOIN books b ON b.id = bc.book_id
       ORDER BY b.sort_order`,
    )
    .all();
}
export function shuffleIds<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function getBookWords(bookId: string, order: StudyOrder = 'default'): WordSummary[] {
  const db = openContentDb();
  if (!db) return [];
  if (order === 'by_chapter' && hasTable(db, 'word_chapter')) {
    return db
      .prepare(
        `SELECT w.id, w.lemma, w.phonetic, w.translation, w.pos
         FROM words w
         JOIN book_words bw ON bw.word_id = w.id
         LEFT JOIN word_chapter wc ON wc.word_id = w.id
         WHERE bw.book_id = ?
         ORDER BY
           CASE WHEN wc.chapter_id IS NULL THEN 1 ELSE 0 END,
           wc.chapter_sort ASC,
           bw.rank ASC,
           w.lemma ASC`,
      )
      .all(bookId);
  }
  const rows = db
    .prepare(
      `SELECT w.id, w.lemma, w.phonetic, w.translation, w.pos
       FROM words w
       JOIN book_words bw ON bw.word_id = w.id
       WHERE bw.book_id = ?
       ORDER BY bw.rank, w.lemma`,
    )
    .all(bookId);
  if (order === 'shuffle') return shuffleIds(rows);
  return rows;
}
export function getWord(wordId: number): Word | undefined {
  const db = openContentDb();
  if (!db) return undefined;
  const row = db
    .prepare(`SELECT id, lemma, phonetic, translation, pos FROM words WHERE id = ?`)
    .get(wordId);
  return row ? { ...row, ...getPronunciation(wordId) } : undefined;
}
export function getPronunciation(wordId: number): Pronunciation {
  const empty = { phonetic_uk: '', phonetic_us: '', audio_uk: null, audio_us: null };
  const db = openContentDb();
  if (!db) return empty;
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(words)')
      .all()
      .map((r) => r.name),
  );
  if (!cols.has('phonetic_uk')) return empty;
  return (
    db
      .prepare('SELECT phonetic_uk, phonetic_us, audio_uk, audio_us FROM words WHERE id=?')
      .get(wordId) || empty
  );
}
export function getBookWordIds(bookId: string): number[] {
  const db = openContentDb();
  return db
    ? db
        .prepare('SELECT word_id FROM book_words WHERE book_id=? ORDER BY rank,word_id')
        .all(bookId)
        .map((r) => r.word_id)
    : [];
}
export function isBookWord(wordId: number, bookId: string): boolean {
  return Boolean(
    openContentDb()
      ?.prepare('SELECT 1 FROM book_words WHERE book_id=? AND word_id=?')
      .get(bookId, wordId),
  );
}
export function hasSpeakersTable(db) {
  return hasTable(db, 'speakers');
}
export function speakerDisplayName(db, name, lineId) {
  if (!speakerNames) {
    speakerNames = new Map([
      ['Paimon', '派蒙'],
      ['Traveler', '旅行者'],
      ['Player', '旅行者'],
      ['Aether', '空'],
      ['Lumine', '荧'],
      ['Narrator', '旁白'],
      ['Unknown', '未知角色'],
    ]);
    const voices = db.prepare("SELECT title_en,title_chs FROM chapters WHERE type='voice'").all();
    for (const row of voices) {
      if (row.title_en && row.title_chs) speakerNames.set(row.title_en, row.title_chs);
    }
    if (hasTable(db, 'speaker_names')) {
      const names = db.prepare('SELECT name_en,name_chs FROM speaker_names').all();
      for (const row of names) speakerNames.set(row.name_en, row.name_chs);
    }
    speakerLineNames = new Map();
    if (hasTable(db, 'speaker_line_names')) {
      const names = db.prepare('SELECT line_id,name_chs FROM speaker_line_names').all();
      for (const row of names) speakerLineNames.set(row.line_id, row.name_chs);
    }
  }
  return speakerLineNames?.get(lineId) || speakerNames.get(name) || name;
}
export function hasChapterSourceLabel(db) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM pragma_table_info('chapters') WHERE name='source_label'`)
    .get();
  return Boolean(row);
}
export function mapChapterRow(r) { const chapter = normalizeChapter(r); return chapter.type === 'voice' ? voiceChapterArtwork(chapter, openContentDb()) : chapter; }

/** 只返回已标明为人物立绘的本地资源；未收录的角色由页面显示荧的伴读立绘。 */
export function getSpeakerPortrait(name: string): CharacterPortrait | null {
  if (isTravelerSpeaker(name)) {
    const chosen = TRAVELERS[normalizeTraveler(getSetting('traveler')) || 'lumine'];
    return { name: chosen.name, imagePath: chosen.portraitPath, traveler: true };
  }
  const db = openContentDb();
  if (!db || !hasSpeakersTable(db) ||
    !db.prepare("SELECT 1 FROM pragma_table_info('speakers') WHERE name='image_kind'").get()) return null;
  if (!speakerPortraits) {
    speakerPortraits = new Map<string, CharacterPortrait>();
    const rows = db.prepare("SELECT name,image_path FROM speakers WHERE image_kind='portrait' AND image_path IS NOT NULL AND image_path != ''").all();
    for (const row of rows) {
      const displayName = speakerDisplayName(db, row.name, undefined);
      const portrait = { name: displayName, imagePath: row.image_path };
      speakerPortraits.set(row.name, portrait);
      speakerPortraits.set(displayName, portrait);
    }
  }
  return speakerPortraits.get(name) ?? null;
}

export function getWordExamples(wordId: number, limit = 3): WordExample[] {
  const db = openContentDb();
  if (!db) return [];
  const withSpeakers = hasSpeakersTable(db);
  const portraitColumn =
    withSpeakers &&
    db
      .prepare('PRAGMA table_info(speakers)')
      .all()
      .some((r) => r.name === 'image_kind');
  const hasQuestCover = Boolean(
    db.prepare(`SELECT 1 AS ok FROM pragma_table_info('quests') WHERE name='cover_path'`).get()?.ok,
  );
  const hasSource = hasChapterSourceLabel(db);
  const sourceExpr = hasSource
    ? `coalesce(c.source_label, c.type) AS source_label`
    : `c.type AS source_label`;
  const sql = withSpeakers
    ? `SELECT we.word_id, we.line_id, we.surface, we.rank, q.id AS quest_id, c.type AS source_type,
              d.text_en, d.text_chs, d.speaker,
              c.id AS chapter_id, c.title_en AS chapter_title_en, c.title_chs AS chapter_title_chs,
              c.type AS chapter_type, ${sourceExpr}, c.version, c.cover_path,
              s.image_path AS speaker_image,
              ${portraitColumn ? 's.image_kind' : "'landscape'"} AS speaker_kind,
              ${hasQuestCover ? 'q.cover_path AS quest_cover' : 'NULL AS quest_cover'},
              q.title_en AS quest_title_en, q.title_chs AS quest_title_chs
       FROM word_examples we
       JOIN dialog_lines d ON d.id = we.line_id
       JOIN quests q ON q.id = d.quest_id
       JOIN chapters c ON c.id = q.chapter_id
       LEFT JOIN speakers s ON s.name = d.speaker
       WHERE we.word_id = ?
       ORDER BY we.rank
       LIMIT ?`
    : `SELECT we.word_id, we.line_id, we.surface, we.rank, q.id AS quest_id, c.type AS source_type,
              d.text_en, d.text_chs, d.speaker,
              c.id AS chapter_id, c.title_en AS chapter_title_en, c.title_chs AS chapter_title_chs,
              c.type AS chapter_type, ${sourceExpr}, c.version, c.cover_path,
              NULL AS speaker_image,
              'landscape' AS speaker_kind,
              ${hasQuestCover ? 'q.cover_path AS quest_cover' : 'NULL AS quest_cover'},
              q.title_en AS quest_title_en, q.title_chs AS quest_title_chs
       FROM word_examples we
       JOIN dialog_lines d ON d.id = we.line_id
       JOIN quests q ON q.id = d.quest_id
       JOIN chapters c ON c.id = q.chapter_id
       WHERE we.word_id = ?
       ORDER BY we.rank
       LIMIT ?`;
  const rows = db.prepare(sql).all(wordId, limit);
  return rows.map((r) => ({
    ...r,
    source_label: getChapter(r.chapter_id)?.source_label ?? r.source_label,
    version: getChapter(r.chapter_id)?.version ?? r.version,
    source_type: getChapter(r.chapter_id)?.type ?? r.source_type,
    chapter_type: getChapter(r.chapter_id)?.type ?? r.chapter_type,
    chapter_variant_label: getChapter(r.chapter_id)?.variant_label,
    speaker: speakerDisplayName(db, r.speaker, r.line_id),
    portrait: getSpeakerPortrait(r.speaker),
    image_path: r.speaker_image || r.quest_cover || r.cover_path || null,
    image_kind: r.speaker_image && r.speaker_kind === 'portrait' ? 'portrait' : 'landscape',
  }));
}
export function listVersions(): VersionSummary[] {
  const db=openContentDb();if(!db)return [];
  const counts=new Map<string,number>();
  for(const row of browsableChapters(db))if(row.version)counts.set(row.version,(counts.get(row.version)||0)+1);
  return Array.from(counts,([version,chapter_count])=>({version,chapter_count})).sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true}));
}
export function listChapters(version?:string,typeFilter?:string):Chapter[] {
  const db=openContentDb();if(!db)return [];
  return browsableChapters(db).filter(row=>(!version||row.version===version)&&(!typeFilter||row.type===typeFilter)).map(row=>voiceChapterArtwork(row,db));
}
export function getChapter(chapterId:number):Chapter|undefined {
  const db=openContentDb();if(!db)return undefined;
  const chapter = chapterCatalog(db).byId.get(chapterId);
  return chapter ? voiceChapterArtwork(chapter, db) : undefined;
}
export function questHasCoverColumn(db) {
  return Boolean(
    db.prepare(`SELECT 1 AS ok FROM pragma_table_info('quests') WHERE name='cover_path'`).get()?.ok,
  );
}
export function getQuestChapter(questId: number): { quest: Quest; chapter: Chapter } | null {
  const db = openContentDb();
  if (!db) return null;
  const coverCol = questHasCoverColumn(db) ? 'cover_path' : 'NULL AS cover_path';
  const quest = db
    .prepare(
      `SELECT id, chapter_id, title_en, title_chs, sort_order, ${coverCol} FROM quests WHERE id = ?`,
    )
    .get(questId);
  if (!quest) return null;
  const chapter = getChapter(quest.chapter_id);
  if (!chapter) return null;
  return { quest: mapQuestRow(quest), chapter };
}
export function listSourceTypes():SourceSummary[] {
  const db=openContentDb();if(!db)return [];
  const counts=new Map<string,{label:string;chapter_count:number}>();
  for(const row of browsableChapters(db)){
    const value=counts.get(row.type)||{label:row.source_label||row.type,chapter_count:0};
    value.chapter_count++;counts.set(row.type,value);
  }
  const order=['aq','lq','wq','commission','tutorial','eq','other','voice'];
  return Array.from(counts,([type,value])=>({type,...value})).sort((a,b)=>order.indexOf(a.type)-order.indexOf(b.type));
}
function mapQuestRow(quest: Quest): Quest {
  const chapter = getChapter(quest.chapter_id);
  return chapter?.type === 'voice' || chapter?.cover_match === 'official_region_key_art_verified' || chapter?.original_type === 'iq' && !chapter.version && !chapter.cover_path
    ? {...quest, cover_path: chapter.cover_path} : quest;
}
export function listQuests(chapterId: number): Quest[] {
  const db = openContentDb();
  if (!db) return [];
  const coverCol = questHasCoverColumn(db) ? 'cover_path' : 'NULL AS cover_path';
  return db
    .prepare(
      `SELECT id, chapter_id, title_en, title_chs, sort_order, ${coverCol}
       FROM quests WHERE chapter_id = ? ORDER BY sort_order, id`,
    )
    .all(chapterId).map(mapQuestRow);
}
export function listDialogLines(questId: number): DialogueLine[] {
  const db = openContentDb();
  if (!db) return [];
  const speakerColumns = hasSpeakersTable(db) ? new Set(db.prepare('PRAGMA table_info(speakers)').all().map(row => row.name)) : new Set<string>();
  const icon = speakerColumns.has('icon_path') ? "NULLIF(s.icon_path,'')" : 'NULL';
  const portrait = speakerColumns.has('image_kind') && speakerColumns.has('image_path') ? "CASE WHEN s.image_kind='portrait' THEN NULLIF(s.image_path,'') END" : 'NULL';
  const rows = hasSpeakersTable(db)
    ? db
        .prepare(
          `SELECT d.id, d.quest_id, d.speaker, d.text_en, d.text_chs, d.sort_order,
                coalesce(${icon}, ${portrait}) AS speaker_image
         FROM dialog_lines d
         LEFT JOIN speakers s ON s.name = d.speaker
         WHERE d.quest_id = ? ORDER BY d.sort_order, d.id`,
        )
        .all(questId)
    : db
        .prepare(
          `SELECT id, quest_id, speaker, text_en, text_chs, sort_order, NULL AS speaker_image
       FROM dialog_lines WHERE quest_id = ? ORDER BY sort_order, id`,
        )
        .all(questId);
  return rows.map((row) => {
    const speaker = speakerDisplayName(db, row.speaker, row.id);
    const traveler = isTravelerSpeaker(row.speaker) || isTravelerSpeaker(speaker);
    return { ...row, speaker, speaker_image: traveler ? TRAVELERS[normalizeTraveler(getSetting('traveler')) || 'lumine'].avatarPath : row.speaker_image };
  });
}
export function lookupWordByLemma(lemma: string): WordSummary | undefined {
  const db = openContentDb();
  if (!db || typeof lemma !== 'string') return undefined;
  const normalized = normalizeAnswer(lemma).replace(/'s$/, '').replace(/'$/, '');
  for (const form of lookupSpellings(normalized)) {
    const exact = db.prepare('SELECT id,lemma,phonetic,translation,pos FROM words WHERE lemma=? COLLATE NOCASE LIMIT 1').get(form);
    if (exact) return exact;
    if (hasTable(db, 'word_forms')) {
      const word = db.prepare('SELECT w.id,w.lemma,w.phonetic,w.translation,w.pos FROM word_forms f ' +
        'JOIN words w ON w.id=f.word_id WHERE f.form=? ORDER BY length(w.lemma),w.id LIMIT 1').get(form);
      if (word) return word;
    }
  }
  return undefined;
}
export function readingOccurrences(bookId, wordIds) {
  const db = openContentDb();
  if (!db || !hasTable(db, 'passage_words')) return [];
  return db
    .prepare(
      `SELECT pw.* FROM passage_words pw JOIN book_words bw ON bw.word_id=pw.word_id WHERE bw.book_id=? AND pw.word_id IN (SELECT value FROM json_each(?))`,
    )
    .all(bookId, JSON.stringify(wordIds));
}
export function getPassage(id) {
  return openContentDb()?.prepare('SELECT * FROM reading_passages WHERE id=?').get(id);
}
