// 全量内容验收：只读内容库，进度使用内存数据库，不读取真实学习记录。
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { loadMain, root } = require('../tests/helpers/load-main.cjs');
const contentPath = path.resolve(process.env.GENSHINWORDS_CONTENT_DB ||
  path.join(process.env.GENSHINWORDS_CONTENT_DIR || path.join(root, 'content'), 'content.db'));
const context = loadMain(contentPath);
const counts = { reading: 0, dialogue: 0, spelling: 0 };
const byWord = new Map();
const started = performance.now();
try {
  const db = context.load('content-db').openContentDb();
  if (!db) throw new Error('未找到离线内容库，请先准备 content.db');
  const { createExerciseForWord, normalizeAnswer } = context.load('exercise');
  const { findPracticeSource } = context.load('practice-content');
  const words = db.prepare('SELECT * FROM words ORDER BY id').all();
  for (const word of words) {
    const { exercise, solutions } = createExerciseForWord('audit', word);
    assert.ok(solutions.length > 0, word.lemma + ': no question');
    assert.equal(exercise.blanks.length, solutions.length, word.lemma);
    for (const solution of solutions) {
      assert.equal(solution.wordId, word.id, word.lemma + ': ID changed');
      assert.ok(solution.expected.trim(), word.lemma + ': empty answer');
      assert.ok(solution.accepted.includes(normalizeAnswer(solution.expected)), word.lemma + ': ungradable answer');
    }
    const restored = exercise.parts.map(part => 'text' in part ? part.text :
      solutions.find(s => s.id === part.blankId).expected).join('');
    if (exercise.kind !== 'spelling') {
      const source = findPracticeSource(word);
      assert.ok(source.text.includes(restored.replace(/^…/, '').replace(/…$/, '')), word.lemma + ': altered original text');
    } else {
      assert.equal(restored, word.lemma);
      assert.ok(word.translation?.trim() || word.phonetic || word.phonetic_uk || word.phonetic_us ||
        word.audio_uk || word.audio_us || exercise.letterBank, word.lemma + ': missing hints');
    }
    counts[exercise.kind]++;
    byWord.set(word.id, exercise.kind);
  }
  const books = db.prepare('SELECT id,name_zh FROM books ORDER BY sort_order').all().map(book => {
    const result = { id: book.id, name: book.name_zh, total: 0, reading: 0, dialogue: 0, spelling: 0 };
    for (const row of db.prepare('SELECT word_id FROM book_words WHERE book_id=?').all(book.id)) {
      assert.ok(byWord.has(row.word_id), book.id + ': dangling word ID ' + row.word_id);
      result.total++; result[byWord.get(row.word_id)]++;
    }
    return result;
  });
  console.log(JSON.stringify({ total: words.length, ...counts, books, seconds: +(performance.now() - started).toFixed(0) / 1000 }, null, 2));
} finally {
  context.close();
}
