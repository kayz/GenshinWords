import type { PracticeSource, PracticeWord } from '../shared/practice';
import { openContentDb, hasTable, getWordExamples } from './content-db';
import { normalizeAnswer, lemmaSpellings, equivalentSpellings } from './spelling';

type Occurrence = { passageId: string; start: number; end: number };
type TextMatch = { start: number; end: number };
const tokenPattern = /[\p{L}\p{M}\p{N}]+(?:['’‘\-‐‑–][\p{L}\p{M}\p{N}]+)*['’‘]?/gu;
const singleToken = /^[\p{L}\p{M}\p{N}]+(?:['’‘\-‐‑–][\p{L}\p{M}\p{N}]+)*['’‘]?$/u;
let cachedDb: any;
let formsByWord = new Map<number, Set<string>>();
let idsByLemma = new Map<string, number>();
let readingIndex: Map<string, Occurrence[]> | null = null;
let passages = new Map<string, any>();
let sourceCache = new Map<number, PracticeSource>();

function prepare() {
  const db = openContentDb();
  if (db === cachedDb) return db;
  cachedDb = db;
  formsByWord = new Map();
  idsByLemma = new Map();
  readingIndex = null;
  passages = new Map();
  sourceCache = new Map();
  if (!db) return db;
  for (const word of db.prepare('SELECT id,lemma FROM words').all()) {
    idsByLemma.set(normalizeAnswer(word.lemma), word.id);
    formsByWord.set(word.id, new Set([normalizeAnswer(word.lemma)]));
  }
  if (hasTable(db, 'word_forms')) {
    for (const row of db.prepare('SELECT word_id,form FROM word_forms').all()) {
      formsByWord.get(row.word_id)?.add(normalizeAnswer(row.form));
    }
  }
  return db;
}

export function practiceForms(word: PracticeWord) {
  prepare();
  const ids = new Set<number>([word.id]);
  for (const lemma of lemmaSpellings(word.lemma)) {
    const id = idsByLemma.get(lemma);
    if (id !== undefined) ids.add(id);
  }
  const forms = new Set<string>([normalizeAnswer(word.lemma)]);
  for (const id of ids) for (const form of formsByWord.get(id) ?? []) forms.add(form);
  for (const form of [...forms]) for (const variant of equivalentSpellings(form, word.lemma)) forms.add(variant);
  return { forms, ids };
}

function prepareReadingIndex(db) {
  if (readingIndex) return;
  readingIndex = new Map();
  if (!db || !hasTable(db, 'reading_passages')) return;
  function add(form: string, occurrence: Occurrence) {
    const occurrences = readingIndex.get(form) ?? [];
    if (occurrences.length < 4) {
      occurrences.push(occurrence);
      readingIndex.set(form, occurrences);
    }
  }
  for (const passage of db.prepare('SELECT * FROM reading_passages').all()) {
    passages.set(passage.id, passage);
    for (const match of passage.text_en.matchAll(tokenPattern)) {
      const form = normalizeAnswer(match[0]);
      const occurrence = { passageId: passage.id, start: match.index, end: match.index + match[0].length };
      add(form, occurrence);
      if (form.endsWith("'")) add(form.slice(0, -1), { ...occurrence, end: occurrence.end - 1 });
    }
  }
}

function matchingForms(text: string, forms: Set<string>) {
  const matches: TextMatch[] = [];
  for (const match of text.matchAll(tokenPattern)) {
    const form = normalizeAnswer(match[0]);
    if (forms.has(form)) matches.push({ start: match.index, end: match.index + match[0].length });
    else if (form.endsWith("'") && forms.has(form.slice(0, -1))) {
      matches.push({ start: match.index, end: match.index + match[0].length - 1 });
    }
  }
  for (const form of forms) {
    if (!form || singleToken.test(form)) continue;
    const escaped = form.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
      .replace(/'/g, "['’‘]").replace(/-/g, '[-‐‑–]').replace(/ /g, '\\s+');
    const pattern = new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])' + escaped + '(?![\\p{L}\\p{M}\\p{N}_])', 'giu');
    for (const match of text.matchAll(pattern)) matches.push({ start: match.index, end: match.index + match[0].length });
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const disjoint: TextMatch[] = [];
  for (const match of matches) if (!disjoint.length || match.start >= disjoint[disjoint.length - 1].end) disjoint.push(match);
  return disjoint;
}

function matchForms(text: string, forms: Set<string>) {
  return matchingForms(text, forms)[0] ?? null;
}

export function practiceMatches(text: string, word: PracticeWord) {
  return matchingForms(text, practiceForms(word).forms);
}

function readingSource(passage, occurrence): PracticeSource {
  return {
    kind: 'reading', title: passage.volume_title || passage.book_title,
    sourceTitle: passage.book_title, sourceUrl: passage.source_url || null,
    coverPath: passage.cover_path || null, text: passage.text_en,
    start: occurrence.start, end: occurrence.end,
  };
}

export function findPracticeSource(word: PracticeWord): PracticeSource {
  const db = prepare();
  const cached = sourceCache.get(word.id);
  if (cached) return cached;
  const { forms, ids } = practiceForms(word);
  prepareReadingIndex(db);
  for (const form of forms) {
    const occurrence = readingIndex.get(form)?.[0];
    if (occurrence) {
      const source = readingSource(passages.get(occurrence.passageId), occurrence);
      sourceCache.set(word.id, source);
      return source;
    }
  }
  const specialForms = new Set([...forms].filter(form => !singleToken.test(form)));
  if (specialForms.size) {
    for (const passage of passages.values()) {
      const occurrence = matchForms(passage.text_en, specialForms);
      if (occurrence) {
        const source = readingSource(passage, occurrence);
        sourceCache.set(word.id, source);
        return source;
      }
    }
  }
  for (const id of ids) {
    for (const example of getWordExamples(id, 10)) {
      const occurrence = matchForms(example.text_en, forms);
      if (!occurrence) continue;
      const source: PracticeSource = {
        kind: 'dialogue', title: example.quest_title_chs || example.quest_title_en || '角色台词',
        sourceTitle: example.chapter_title_chs || example.chapter_title_en || 'Project Amber 台词',
        sourceUrl: example.quest_id > 0 ? 'https://gi.yatta.moe/en/archive/quest/' + example.quest_id : null,
        coverPath: example.image_path || null, speaker: example.speaker,
        text: example.text_en, start: occurrence.start, end: occurrence.end,
      };
      sourceCache.set(word.id, source);
      return source;
    }
  }
  const source: PracticeSource = {
    kind: 'spelling', title: '词义 / 听音拼写', sourceTitle: '本地词典练习',
    sourceUrl: null, coverPath: null, text: '', start: 0, end: 0,
  };
  sourceCache.set(word.id, source);
  return source;
}
