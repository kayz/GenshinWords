const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadMain } = require('./load-main.cjs');

function fixture(t, loadOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'genshinwords-practice-'));
  const contentPath = path.join(directory, 'content.db');
  const progressPath = path.join(directory, 'progress.db');
  const db = new Database(contentPath);
  db.exec(
    "CREATE TABLE books(id TEXT PRIMARY KEY,name TEXT,name_zh TEXT,description TEXT,sort_order INTEGER);" +
    "INSERT INTO books VALUES('test','Test','测试词书','',1),('other','Other','另一词书','',2);" +
    "CREATE TABLE words(id INTEGER PRIMARY KEY,lemma TEXT,translation TEXT,phonetic TEXT,pos TEXT,phonetic_uk TEXT,phonetic_us TEXT,audio_uk TEXT,audio_us TEXT);" +
    "CREATE TABLE book_words(book_id TEXT,word_id INTEGER,rank INTEGER);" +
    "CREATE TABLE word_forms(word_id INTEGER,form TEXT);" +
    "CREATE TABLE reading_passages(id TEXT PRIMARY KEY,book_title TEXT,volume_title TEXT,text_en TEXT,source_url TEXT,cover_path TEXT);" +
    "CREATE TABLE chapters(id INTEGER PRIMARY KEY,type TEXT,title_en TEXT,title_chs TEXT,version TEXT,cover_path TEXT);" +
    "CREATE TABLE quests(id INTEGER PRIMARY KEY,chapter_id INTEGER,title_en TEXT,title_chs TEXT);" +
    "CREATE TABLE dialog_lines(id INTEGER PRIMARY KEY,quest_id INTEGER,speaker TEXT,text_en TEXT,text_chs TEXT);" +
    "CREATE TABLE word_examples(word_id INTEGER,line_id INTEGER,surface TEXT,rank INTEGER);" +
    "INSERT INTO chapters VALUES(1,'aq','Fixture chapter','测试章节','1','');" +
    "INSERT INTO quests VALUES(1,1,'Fixture quest','测试任务');"
  );
  const words = [
    [1, 'harbour', '港口'], [2, 'harbor', '港口'], [3, 'sword', '剑'],
    [4, 'oxygen', '氧气'], [5, 'extra', '额外的'], [6, 'art', '艺术'],
    [7, 'analyse', '分析'], [8, 'analysis', '分析（名词）'], [9, 'café', '咖啡馆'],
    [10, 'zyxword', ''], [11, 'soundword', ''], [12, 'ice cream', '冰淇淋'],
    [13, 'run', '跑'], [14, 'traveller', '旅行者'], [15, 'cat', '猫'],
    [16, 'orphan', '孤立的'], [17, 'colour', '颜色'], [18, 'eco-tourist', '生态游客'],
  ];
  const insert = db.prepare("INSERT INTO words VALUES(?,?,?,'','','','',?,NULL)");
  for (const [id, lemma, translation] of words) {
    insert.run(id, lemma, translation, id === 11 ? 'sound.mp3' : null);
    if (![2, 5, 16].includes(id)) db.prepare("INSERT INTO book_words VALUES('test',?,?)").run(id, id);
  }
  db.exec("INSERT INTO book_words VALUES('other',4,1);" +
    "INSERT INTO word_forms VALUES(7,'analysed'),(8,'analyses'),(13,'running'),(14,'travellers'),(17,'colours');");
  // 完全合成的测试材料，不是游戏原文。
  db.prepare("INSERT INTO reading_passages VALUES('one','Fixture book','Fixture volume',?,'https://example.test/book',NULL)")
    .run('🚀 The harbor was calm. She analyzed samples while running to a café. The cart carried ice cream and several analyses.');
  db.prepare("INSERT INTO reading_passages VALUES('two','Fixture book','Fixture volume',?,'https://example.test/book',NULL)")
    .run('The travelers talked about the colourless sky and colors.');
  const dialogue = db.prepare("INSERT INTO dialog_lines VALUES(?,1,'Paimon',?,'')");
  dialogue.run(1, 'A sword is ready. Another sword is here.'); dialogue.run(2, 'Another harbor is far away.');
  dialogue.run(3, 'A cart rolls past.'); dialogue.run(4, 'A cathedral stands there.');
  dialogue.run(5, 'Extra matters here. Keep it.');
  dialogue.run(6, 'A café welcomed a traveler’s eco-tourist companion who analyzed maps.');
  dialogue.run(7, 'An unlistedword appears here.');
  db.exec("INSERT INTO word_examples VALUES(3,1,'sword',1),(1,2,'harbor',1),(6,3,'art',1),(15,4,'cat',1);");
  db.exec("ALTER TABLE chapters ADD COLUMN chapter_num TEXT NOT NULL DEFAULT ''; ALTER TABLE chapters ADD COLUMN sort_order INTEGER DEFAULT 0; ALTER TABLE quests ADD COLUMN sort_order INTEGER DEFAULT 0; ALTER TABLE dialog_lines ADD COLUMN sort_order INTEGER DEFAULT 0;");
  db.close();
  const context = loadMain(contentPath, progressPath, loadOptions);
  const content = context.load('content-db');
  const progress = context.load('progress-db');
  const exercise = context.load('exercise');
  const study = context.load('study');
  const rewards = context.load('rewards');
  t.after(() => {
    context.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('genshinwords-practice-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  function review(id, rating = 3, book = 'test') {
    return study.reviewCard(id, book, rating, 'review-' + id + '-' + book);
  }
  function answer(question, value) {
    if (question.kind === 'recognition') {
      const word = content.getWord(question.blanks[0].wordId);
      const normalize = context.load('spelling').normalizeAnswer;
      const accepted = [normalize(word.lemma), ...context.load('spelling').equivalentSpellings(word.lemma, word.lemma)];
      if (accepted.includes(normalize(value))) value = question.options.find(option => option.text === word.translation.trim()).id;
    }
    return exercise.submitExercise(question.id, Object.fromEntries(question.blanks.map(blank => [blank.id, value])));
  }
  function collect(lineId, surface, occurrence = 0) {
    const line=content.openContentDb().prepare('SELECT text_en FROM dialog_lines WHERE id=?').get(lineId);
    let start=-1;
    for(let i=0;i<=occurrence;i++) start=line.text_en.indexOf(surface,start+1);
    assert.ok(start>=0);
    return context.load('collections').collectFromDialogue({lineId,start,end:start+surface.length});
  }
  return { directory, contentPath, progressPath, context, content, progress, exercise, study, rewards, review, answer, collect };
}


module.exports = { fixture };
