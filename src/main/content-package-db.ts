import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ContentPackageHeader, MaterialPackageData, WordPackageData } from '../shared/content-package';
import { wordTokens } from '../shared/text';
import { normalizeAnswer, lookupSpellings } from './spelling';
const OFFICIAL_ORDER = ['zhongkao', 'sh_zhongkao', 'gaokao', 'sh_gaokao', 'cet4', 'cet6', 'kaoyan', 'tem4', 'tem8', 'ielts', 'toefl'];

export interface ContentRevision {
  header: ContentPackageHeader; digest: string; directory: string; builtIn: boolean; activated?: boolean;
  data?: MaterialPackageData | WordPackageData;
}
const hasTable = (db: Database.Database, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
export function openPackageDatabase(file: string): Database.Database {
  const signature = Buffer.alloc(20), descriptor = fs.openSync(file, 'r');
  try { fs.readSync(descriptor, signature, 0, signature.length, 0); } finally { fs.closeSync(descriptor); }
  // SQLITE_OPEN_READONLY may still create WAL sidecars. Validate a detached memory image instead.
  const wal = signature.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) && (signature[18] === 2 || signature[19] === 2);
  let db: Database.Database;
  if (wal) {
    if (fs.statSync(file).size > 256 * 1024 * 1024)
      throw new Error('WAL 素材数据库超过 256 MiB，无法安全校验。请先在副本上完成 checkpoint 并转换为 DELETE 日志模式，再提供该副本。');
    const bytes = fs.readFileSync(file); bytes[18] = 1; bytes[19] = 1;
    db = new Database(bytes, { readonly: true });
  } else db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('trusted_schema = OFF');
  db.pragma('query_only = ON');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') OR (type='table' AND upper(sql) LIKE '%CREATE VIRTUAL TABLE%') LIMIT 1").get()) {
    db.close(); throw new Error('基础素材不能包含触发器、视图或扩展表。');
  }
  const personal = /^(?:settings|user_settings|cards?|review_logs?|review_requests?|bookmarks?|collected_words|collection|schema_migrations|browse_progress|practice_progress|mastery|rewards?|reward_ledger|word_self_tests|word_self_test_requests|exercise_attempts?|exercise_requests?|reading_attempts?|reading_sessions?|reading_answers?|reading_requests?|reading_paper_requests?|reading_split_migrations)$/i;
  if ((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).some(row => personal.test(row.name))) {
    db.close(); throw new Error('内容包不能包含个人学习记录、收藏、设置或奖励数据表。');
  }
  return db;
}
export function validateBaseDatabase(file: string, previous?: string, checkIntegrity = true): void {
  const db = openPackageDatabase(file);
  try {
    if (checkIntegrity && (db.pragma('quick_check', { simple: true }) !== 'ok' || db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()))
      throw new Error('基础素材数据库损坏或存在无效来源关联。');
    for (const table of ['words', 'books', 'book_words', 'chapters', 'quests', 'dialog_lines'])
      if (!hasTable(db, table)) throw new Error('基础素材缺少数据表：' + table);
    for (const [table, columns] of Object.entries({ words: ['id', 'lemma', 'phonetic', 'translation', 'pos'],
      books: ['id', 'name', 'name_zh', 'description', 'sort_order'], book_words: ['book_id', 'word_id', 'rank'],
      chapters: ['id', 'type', 'version', 'title_en', 'title_chs', 'cover_path', 'sort_order'],
      quests: ['id', 'chapter_id', 'title_en', 'title_chs', 'sort_order'], dialog_lines: ['id', 'quest_id', 'speaker', 'text_en', 'text_chs', 'sort_order'] })) {
      const actual = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(row => row.name));
      if (columns.some(column => !actual.has(column))) throw new Error('基础素材表字段不完整：' + table);
    }
    if (!previous || !fs.existsSync(previous) || path.resolve(previous) === path.resolve(file)) return;
    const old = openPackageDatabase(previous);
    try {
      for (const [table, fields] of Object.entries({ words: ['lemma'], chapters: ['type', 'title_en'],
        quests: ['chapter_id', 'title_en'], dialog_lines: ['quest_id', 'speaker', 'text_en'] })) {
        if (!hasTable(old, table)) continue;
        const lookup = db.prepare('SELECT ' + fields.join(',') + ' FROM ' + table + ' WHERE id=?');
        for (const row of old.prepare('SELECT id,' + fields.join(',') + ' FROM ' + table).iterate() as Iterable<Record<string, unknown>>) {
          const current = lookup.get(row.id) as Record<string, unknown> | undefined;
          if (!current || fields.some(field => current[field] !== row[field]))
            throw new Error('基础素材不能删除或复用旧内容编号：' + table + '/' + row.id);
        }
      }
    } finally { old.close(); }
  } finally { db.close(); }
}
export function validateMaterialsDatabase(file: string, previous?: string, checkIntegrity = true): void {
  const db = openPackageDatabase(file);
  try {
    if (checkIntegrity && (db.pragma('quick_check', { simple: true }) !== 'ok' || db.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()))
      throw new Error('materials.db 损坏或存在无效来源关联。');
    for (const [table, fields] of Object.entries({ materials: ['id'], texts: ['material_id', 'locale', 'text', 'paragraphs_json'] })) {
      if (!hasTable(db, table)) throw new Error('materials.db 缺少原文资料表：' + table);
      const columns = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(row => row.name));
      if (fields.some(field => !columns.has(field))) throw new Error('materials.db 原文资料字段不完整：' + table);
    }
    if (!previous || !fs.existsSync(previous) || path.resolve(file) === path.resolve(previous)) return;
    const old = openPackageDatabase(previous);
    try {
      if (!hasTable(old, 'texts')) return;
      const lookup = db.prepare("SELECT text FROM texts WHERE material_id=? AND locale='en'");
      for (const row of old.prepare("SELECT material_id,text FROM texts WHERE locale='en'").iterate() as Iterable<{ material_id: string; text: string }>) {
        const current = lookup.get(row.material_id) as { text: string } | undefined;
        if (!current || current.text !== row.text) throw new Error('基础素材不能删除或复用原英文资料编号：' + row.material_id);
      }
    } finally { old.close(); }
  } finally { db.close(); }
}
export function validateBaseMedia(base: ContentRevision, mediaDirectory = base.directory): void {
  const entries = new Set(base.header.entries.map(entry => entry.path));
  const inspect = (db: Database.Database, table: string, columns: string[], audio = false) => {
    if (!hasTable(db, table)) return;
    const actual = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(row => row.name));
    for (const column of columns) {
      if (!actual.has(column)) continue;
      for (const { value } of db.prepare('SELECT DISTINCT ' + column + ' AS value FROM ' + table + ' WHERE ' + column + " IS NOT NULL AND " + column + "!=''").iterate() as Iterable<{ value: string }>) {
        if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..'))
          throw new Error('基础素材含有不安全的媒体引用：' + table + '.' + column);
        const logical = value.startsWith('images/') || value.startsWith('audio/') ? value : (audio ? 'audio/' : 'images/') + value;
        if (!entries.has(logical) || !fs.existsSync(path.join(mediaDirectory, logical))) throw new Error('基础素材缺少数据库引用的媒体：' + logical);
      }
    }
  };
  const content = openPackageDatabase(path.join(base.directory, 'content.db'));
  try {
    inspect(content, 'words', ['audio_uk', 'audio_us'], true);
    for (const [table, columns] of Object.entries({ chapters: ['cover_path'], quests: ['cover_path'], speakers: ['image_path', 'icon_path'], reading_passages: ['cover_path'] }))
      inspect(content, table, columns);
  } finally { content.close(); }
  const materials = openPackageDatabase(path.join(base.directory, 'materials.db'));
  try { inspect(materials, 'artwork', ['file_path']); } finally { materials.close(); }
}
function materialIdentities(data: MaterialPackageData) {
  const map = new Map<string, string>();
  for (const chapter of data.chapters) {
    map.set('chapter:' + chapter.id, chapter.type);
    for (const quest of chapter.quests) {
      map.set('quest:' + quest.id, chapter.id);
      for (const line of quest.lines) map.set('line:' + line.id, JSON.stringify([quest.id, line.speaker, line.text_en]));
    }
  }
  return map;
}
export function validateMaterialHistory(next: ContentRevision, history: ContentRevision[]): void {
  if (next.header.manifest.kind !== 'materials') return;
  const identities = materialIdentities(next.data as MaterialPackageData);
  for (const old of history) {
    if (old.header.manifest.id !== next.header.manifest.id || old.header.manifest.kind !== 'materials') continue;
    for (const [key, fingerprint] of materialIdentities(old.data as MaterialPackageData)) {
      const current = identities.get(key);
      if (current !== undefined && current !== fingerprint) throw new Error('原文或来源层级变化必须使用新的素材编号：' + key);
    }
  }
}
function numericId(db: Database.Database, revision: ContentRevision, kind: string, local: string): number {
  const key = [revision.header.manifest.id, kind, local].join('\0');
  const id = 1_000_000_000_000 + Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 12), 16);
  const table = kind === 'chapter' ? 'chapters' : kind === 'quest' ? 'quests' : 'dialog_lines';
  const previous = db.prepare('SELECT identity FROM gw_content_ids WHERE numeric_id=?').get(id) as { identity: string } | undefined;
  if ((previous && previous.identity !== key) || (!previous && db.prepare('SELECT 1 FROM ' + table + ' WHERE id=?').get(id)))
    throw new Error('素材编号映射发生冲突，请使用新的本地编号：' + local);
  db.prepare('INSERT OR IGNORE INTO gw_content_ids(identity,numeric_id) VALUES(?,?)').run(key, id);
  return id;
}
function applyMaterials(db: Database.Database, revision: ContentRevision): void {
  const data = revision.data as MaterialPackageData;
  const chapterCols = new Set((db.prepare('PRAGMA table_info(chapters)').all() as { name: string }[]).map(row => row.name));
  const questCols = new Set((db.prepare('PRAGMA table_info(quests)').all() as { name: string }[]).map(row => row.name));
  if (!chapterCols.has('source_label')) db.exec("ALTER TABLE chapters ADD COLUMN source_label TEXT NOT NULL DEFAULT ''");
  if (!chapterCols.has('cover_source_url')) db.exec('ALTER TABLE chapters ADD COLUMN cover_source_url TEXT');
  if (!chapterCols.has('cover_match')) db.exec('ALTER TABLE chapters ADD COLUMN cover_match TEXT');
  if (!questCols.has('cover_path')) db.exec('ALTER TABLE quests ADD COLUMN cover_path TEXT');
  if (!hasTable(db, 'word_examples')) db.exec('CREATE TABLE word_examples(word_id INTEGER NOT NULL,line_id INTEGER NOT NULL,surface TEXT NOT NULL,rank INTEGER NOT NULL,PRIMARY KEY(word_id,line_id))');
  if (!hasTable(db, 'word_chapter')) db.exec('CREATE TABLE word_chapter(word_id INTEGER PRIMARY KEY,chapter_id INTEGER,chapter_sort INTEGER,version TEXT,chapter_title_en TEXT,chapter_title_chs TEXT)');
  const words = new Map<string, number>();
  for (const word of db.prepare('SELECT id,lemma FROM words ORDER BY id').iterate() as Iterable<{ id: number; lemma: string }>)
    if (!words.has(normalizeAnswer(word.lemma))) words.set(normalizeAnswer(word.lemma), word.id);
  if (hasTable(db, 'word_forms')) for (const row of db.prepare('SELECT form,word_id FROM word_forms ORDER BY word_id').iterate() as Iterable<{ form: string; word_id: number }>)
    if (!words.has(normalizeAnswer(row.form))) words.set(normalizeAnswer(row.form), row.word_id);
  const labels = { quest: '增补任务', voice: '增补语音', hangout: '增补邀约', book: '增补书籍' };
  const saveChapter = db.prepare('INSERT INTO chapters(id,type,version,title_en,title_chs,cover_path,sort_order,source_label,cover_source_url,cover_match) VALUES(?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET version=excluded.version,title_en=excluded.title_en,title_chs=excluded.title_chs,cover_path=excluded.cover_path,source_label=excluded.source_label,cover_source_url=excluded.cover_source_url,cover_match=excluded.cover_match');
  const saveQuest = db.prepare('INSERT INTO quests(id,chapter_id,title_en,title_chs,sort_order,cover_path) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET title_en=excluded.title_en,title_chs=excluded.title_chs,cover_path=excluded.cover_path');
  const saveLine = db.prepare('INSERT INTO dialog_lines(id,quest_id,speaker,text_en,text_chs,sort_order) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET text_chs=excluded.text_chs');
  const saveExample = db.prepare('INSERT OR IGNORE INTO word_examples(word_id,line_id,surface,rank) VALUES(?,?,?,?)');
  const saveWordChapter = db.prepare('INSERT OR IGNORE INTO word_chapter(word_id,chapter_id,chapter_sort,version,chapter_title_en,chapter_title_chs) VALUES(?,?,?,?,?,?)');
  for (const [chapterIndex, chapter] of data.chapters.entries()) {
    const chapterId = numericId(db, revision, 'chapter', chapter.id);
    const cover = chapter.coverPath ? `gwcontent/${revision.digest}/${chapter.coverPath}` : null;
    saveChapter.run(chapterId, chapter.type, chapter.version, chapter.title_en, chapter.title_chs, cover, 1_000_000 + chapterIndex,
      labels[chapter.type], chapter.sourceUrl, cover ? 'package_embedded_verified' : null);
    for (const [questIndex, quest] of chapter.quests.entries()) {
      const questId = numericId(db, revision, 'quest', quest.id);
      saveQuest.run(questId, chapterId, quest.title_en, quest.title_chs, questIndex, cover);
      for (const [lineIndex, line] of quest.lines.entries()) {
        const lineId = numericId(db, revision, 'line', line.id);
        const prior = db.prepare('SELECT quest_id,speaker,text_en FROM dialog_lines WHERE id=?').get(lineId) as { quest_id: number; speaker: string; text_en: string } | undefined;
        if (prior && (prior.quest_id !== questId || prior.speaker !== line.speaker || prior.text_en !== line.text_en)) throw new Error('素材原文编号不能复用：' + line.id);
        saveLine.run(lineId, questId, line.speaker, line.text_en, line.text_chs, lineIndex);
        for (const token of wordTokens(line.text_en)) {
          const wordId = lookupSpellings(normalizeAnswer(token.text)).map(form => words.get(form)).find(Boolean);
          if (wordId) {
            saveExample.run(wordId, lineId, token.text, 1_000_000 + lineIndex);
            saveWordChapter.run(wordId, chapterId, 1_000_000 + chapterIndex, chapter.version, chapter.title_en, chapter.title_chs);
          }
        }
      }
    }
  }
}
function applyWords(db: Database.Database, revision: ContentRevision, sortBase: number, dictionary: Map<string, number[]>): void {
  const data = revision.data as WordPackageData;
  const official = revision.builtIn && revision.header.manifest.id.startsWith('genshinwords.words.');
  if (official && (data.books.length !== 1 || revision.header.manifest.id !== 'genshinwords.words.' + data.books[0].id))
    throw new Error('官方词书包只能管理它自身编号对应的一本词书。');
  const saveBook = db.prepare('INSERT INTO books(id,name,name_zh,description,sort_order) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_zh=excluded.name_zh,description=excluded.description,sort_order=excluded.sort_order');
  const saveWord = db.prepare('INSERT INTO book_words(book_id,word_id,rank) VALUES(?,?,?)');
  for (const [index, book] of data.books.entries()) {
    const id = official ? book.id : revision.header.manifest.id + ':' + book.id;
    const originalOrder = official ? OFFICIAL_ORDER.indexOf(book.id) : -1;
    saveBook.run(id, book.name, book.name_zh, book.description, originalOrder < 0 ? sortBase + index : originalOrder + 1);
    db.prepare('DELETE FROM book_words WHERE book_id=?').run(id);
    const seen = new Set<number>();
    for (const [rank, lemma] of book.lemmas.entries()) {
      const words = dictionary.get(lemma.normalize('NFKC').toLowerCase()) ?? [];
      if (words.length !== 1) throw new Error('词书只能引用基础词库中唯一的现有词条：' + lemma);
      if (!seen.has(words[0])) { seen.add(words[0]); saveWord.run(id, words[0], rank); }
    }
  }
}
function namespaceBaseMedia(db: Database.Database, base: ContentRevision): void {
  const prefix = 'gwcontent/' + base.digest + '/';
  for (const [table, columns] of Object.entries({ words: ['audio_uk', 'audio_us'], chapters: ['cover_path'], quests: ['cover_path'],
    speakers: ['image_path', 'icon_path'], reading_passages: ['cover_path'] })) {
    if (!hasTable(db, table)) continue;
    const actual = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(row => row.name));
    for (const column of columns) {
      if (!actual.has(column)) continue;
      const audio = column.startsWith('audio_');
      db.prepare('UPDATE ' + table + ' SET ' + column + '=? || CASE WHEN ' + column + " LIKE 'images/%' OR " + column + " LIKE 'audio/%' THEN " + column + ' ELSE ? || ' + column + ' END WHERE ' + column + " IS NOT NULL AND " + column + "!='' AND " + column + " NOT LIKE 'gwcontent/%'")
        .run(prefix, audio ? 'audio/' : 'images/');
    }
  }
}
export function buildDerivedContent(file: string, baseFile: string, selected: ContentRevision[], materialHistory: ContentRevision[], base?: ContentRevision): void {
  fs.copyFileSync(baseFile, file);
  const db = new Database(file);
  try {
    db.pragma('trusted_schema = OFF'); db.pragma('journal_mode = DELETE');
    db.exec('CREATE TABLE IF NOT EXISTS gw_content_ids(identity TEXT PRIMARY KEY,numeric_id INTEGER NOT NULL UNIQUE)');
    db.transaction(() => {
      if (base) namespaceBaseMedia(db, base);
      for (const revision of materialHistory) applyMaterials(db, revision);
      for (const revision of selected.filter(item => item.header.manifest.kind === 'materials')) applyMaterials(db, revision);
      const wordPackages = selected.filter(item => item.header.manifest.kind === 'words');
      const dictionary = new Map<string, number[]>();
      if (wordPackages.length) for (const row of db.prepare('SELECT id,lemma FROM words').iterate() as Iterable<{ id: number; lemma: string }>) {
        const key = row.lemma.normalize('NFKC').toLowerCase(), ids = dictionary.get(key) ?? []; ids.push(row.id); dictionary.set(key, ids);
      }
      if (wordPackages.some(item => item.builtIn && item.header.manifest.id.startsWith('genshinwords.words.'))) {
        db.exec('DELETE FROM book_words; DELETE FROM books;');
        if (hasTable(db, 'book_coverage')) db.exec('DELETE FROM book_coverage');
      }
      wordPackages.sort((a, b) => Number(b.builtIn) - Number(a.builtIn));
      wordPackages.forEach((revision, index) => applyWords(db, revision, revision.builtIn ? 1 : 1000 + index * 100, dictionary));
      if (wordPackages.length || selected.some(item => item.header.manifest.kind === 'materials')) {
        if (!hasTable(db, 'book_coverage')) db.exec('CREATE TABLE book_coverage(book_id TEXT PRIMARY KEY,total INTEGER NOT NULL,covered INTEGER NOT NULL,uncovered INTEGER NOT NULL,coverage_pct REAL NOT NULL)');
        const example = hasTable(db, 'word_examples') ? 'EXISTS(SELECT 1 FROM word_examples e WHERE e.word_id=bw.word_id)' : '0';
        const passage = hasTable(db, 'passage_words') ? 'EXISTS(SELECT 1 FROM passage_words p WHERE p.word_id=bw.word_id)' : '0';
        db.exec('DELETE FROM book_coverage');
        const counts = db.prepare('SELECT bw.book_id,COUNT(*) total,SUM(CASE WHEN ' + example + ' OR ' + passage + ' THEN 1 ELSE 0 END) covered FROM book_words bw GROUP BY bw.book_id').all() as Array<{ book_id: string; total: number; covered: number }>;
        const save = db.prepare('INSERT INTO book_coverage VALUES(?,?,?,?,?)');
        for (const row of counts) save.run(row.book_id, row.total, row.covered, row.total - row.covered, row.total ? row.covered / row.total * 100 : 0);
      }
    })();
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('派生素材数据库校验失败。');
  } finally { db.close(); }
}
