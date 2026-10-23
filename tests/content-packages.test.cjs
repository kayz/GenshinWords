const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');
const { loadMain, root } = require('./helpers/load-main.cjs');

function setup(t) {
  const f = fixture(t, { bundledReadingPackagePath: null });
  return { ...f, store: f.context.load('content-package-store'), format: f.context.load('content-package-format') };
}
function manifest(id, kind, version = '1.0.0', dependencies) {
  return { id, name: id, kind, version, minAppVersion: '1.0.0', author: 'Synthetic regression', createdAt: '2026-10-23T00:00:00.000Z', ...(dependencies ? { dependencies } : {}) };
}
function wordData(lemmas = ['sword', 'cat'], id = 'small') {
  return { books: [{ id, name: 'Small book', name_zh: '测试词书', description: '本地选词', lemmas }] };
}
function materialData(lines = [{ id: 'line-one', speaker: 'Paimon', text_en: 'A sword is here.', text_chs: '这里有一把剑。' }]) {
  return { chapters: [{ id: 'chapter-one', title_en: 'Supplement chapter', title_chs: '增补章节', type: 'quest', version: '6.0', sourceUrl: 'https://example.test/source',
    quests: [{ id: 'quest-one', title_en: 'Supplement quest', title_chs: '增补任务', lines }] }] };
}
async function pack(f, header, data, label = '', assets = {}) {
  const author = path.join(f.directory, 'author-' + header.id + '-' + header.version + label); fs.mkdirSync(author, { recursive: true });
  fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify(header), 'utf8');
  if (data) fs.writeFileSync(path.join(author, 'data.json'), JSON.stringify(data), 'utf8');
  for (const [relative, bytes] of Object.entries(assets)) { const file = path.join(author, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const file = path.join(f.directory, header.id + '-' + header.version + label + (header.kind === 'words' ? '.gwwords' : '.gwcontent'));
  if (header.kind === 'base') {
    fs.copyFileSync(f.contentPath, path.join(author, 'content.db'));
    const cleanMedia = new Database(path.join(author, 'content.db')); cleanMedia.exec('UPDATE words SET audio_uk=NULL,audio_us=NULL'); cleanMedia.close();
    const materials = new Database(path.join(author, 'materials.db')); materials.exec('CREATE TABLE materials(id TEXT PRIMARY KEY); CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT)'); materials.close();
  }
  await f.format.packContentDirectory(author, file); return { file, author };
}
async function install(store, file) { return store.importContentPackage((await store.previewContentPackageFile(file)).token); }
async function restart(f) {
  const context = loadMain(f.contentPath, f.progressPath, { bundledReadingPackagePath: null });
  const store = context.load('content-package-store'); await store.initializeContentPackages();
  return { context, store, content: context.load('content-db'), progress: context.load('progress-db') };
}

test('content packages: word books activate after restart and membership changes preserve learning records', async t => {
  const f = setup(t), one = await pack(f, manifest('local.words', 'words'), wordData());
  const before = f.content.listBooks().map(book => book.id), db = f.progress.openProgressDb();
  db.prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(3, 'local.words:small', '2026-10-23');
  f.collect(1, 'sword'); const saved = f.context.load('collections').getCollectedSource(3);
  const preview = await f.store.previewContentPackageFile(one.file);
  assert.deepEqual({ books: preview.package.counts.books, words: preview.package.counts.words }, { books: 1, words: 2 });
  assert.equal(preview.restartRequired, true); assert.ok(preview.warnings.some(text => text.includes('学习记录')));
  assert.equal((await f.store.importContentPackage(preview.token)).package.status, 'pending');
  assert.deepEqual(f.content.listBooks().map(book => book.id), before);
  assert.equal((await install(f.store, one.file)).action, 'unchanged');
  f.context.close(); let fresh = await restart(f);
  try {
    assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [3, 15]);
    assert.equal(fresh.store.listContentPackages().find(item => item.id === 'local.words').status, 'active');
    const two = await pack(f, manifest('local.words', 'words', '1.1.0'), wordData(['cat']));
    await install(fresh.store, two.file); assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [3, 15]);
    fresh.context.close(); fresh = await restart(f);
    assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [15]);
    assert.equal(fresh.progress.openProgressDb().prepare('SELECT COUNT(*) n FROM cards WHERE word_id=3 AND book_id=?').get('local.words:small').n, 1);
    assert.deepEqual(fresh.context.load('collections').getCollectedSource(3), saved);
  } finally { fresh.context.close(); }
});

test('content packages: parallel confirmations serialize pending updates and reject unknown words, downgrade, dependencies and changed same versions', async t => {
  const f = setup(t), a = await pack(f, manifest('local.a', 'words'), wordData(['sword'])), b = await pack(f, manifest('local.b', 'words'), wordData(['cat']));
  const previews = await Promise.all([f.store.previewContentPackageFile(a.file), f.store.previewContentPackageFile(b.file)]);
  await Promise.all(previews.map(item => f.store.importContentPackage(item.token)));
  assert.deepEqual(f.store.listContentPackages().filter(item => item.status === 'pending').map(item => item.id).sort(), ['local.a', 'local.b']);
  const unknown = await pack(f, manifest('unknown.words', 'words'), wordData(['notinlocaldictionary']));
  await assert.rejects(f.store.previewContentPackageFile(unknown.file), /现有词条/);
  const dependency = await pack(f, manifest('needs.base', 'words', '1.0.0', [{ id: 'missing.base', minVersion: '1.0.0' }]), wordData());
  await assert.rejects(f.store.previewContentPackageFile(dependency.file), /依赖/);
  const changed = await pack(f, manifest('local.a', 'words'), wordData(['cat']), '-changed');
  await assert.rejects(f.store.previewContentPackageFile(changed.file), /同一包版本/);
  const lower = await pack(f, manifest('local.a', 'words', '0.9.0'), wordData());
  await assert.rejects(f.store.previewContentPackageFile(lower.file), /更低版本/);
  assert.equal(f.store.listContentPackages().filter(item => item.status === 'pending').length, 2);
});

test('content packages: materials retain stable source IDs and original English across upgrades, and corruption isolates one package', async t => {
  const f = setup(t), words = await pack(f, manifest('local.words', 'words'), wordData()), first = await pack(f, manifest('local.material', 'materials'), materialData());
  f.content.openContentDb(); await install(f.store, words.file); await install(f.store, first.file);
  assert.equal(f.content.listChapters().some(chapter => chapter.title_en === 'Supplement chapter'), false);
  f.context.close(); let fresh = await restart(f);
  try {
    const chapter = fresh.content.listChapters().find(item => item.title_en === 'Supplement chapter'); assert.ok(chapter.id >= 1e12);
    const quest = fresh.content.listQuests(chapter.id)[0], line = fresh.content.listDialogLines(quest.id)[0]; assert.ok(line.id >= 1e12);
    assert.ok(fresh.content.getWordExamples(3, 100).some(example => example.line_id === line.id));
    const start = line.text_en.indexOf('sword'); fresh.context.load('collections').collectFromDialogue({ lineId: line.id, start, end: start + 5 });
    const saved = fresh.context.load('collections').getCollectedSource(3);
    const second = await pack(f, manifest('local.material', 'materials', '1.1.0'), materialData([{ id: 'line-two', speaker: 'Paimon', text_en: 'The cat is asleep.', text_chs: '猫睡着了。' }]));
    await install(fresh.store, second.file); fresh.context.close(); fresh = await restart(f);
    assert.equal(fresh.content.listDialogLines(quest.id).find(item => item.id === line.id).text_en, line.text_en, 'Removed source is retained');
    assert.deepEqual(fresh.context.load('collections').getCollectedSource(3), saved);
    const conflict = await pack(f, manifest('local.material', 'materials', '1.2.0'), materialData([{ id: 'line-one', speaker: 'Paimon', text_en: 'The original English changed.', text_chs: '改了。' }]));
    await assert.rejects(fresh.store.previewContentPackageFile(conflict.file), /新的素材编号/);
    const registryFile = path.join(f.directory, 'content-packages/registry.json'), registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const active = registry.active.find(entry => entry.header.manifest.id === 'local.material');
    fresh.context.close(); fs.writeFileSync(path.join(f.directory, 'content-packages/revisions', active.digest, 'data.json'), '{}', 'utf8'); fresh = await restart(f);
    assert.equal(fresh.store.listContentPackages().find(item => item.id === 'local.material').status, 'error');
    assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [3, 15]);
    assert.equal((await install(fresh.store, second.file)).restartRequired, true);
    fresh.context.close(); fresh = await restart(f);
    assert.equal(fresh.store.listContentPackages().find(item => item.id === 'local.material').status, 'active');
    assert.ok(fresh.content.listDialogLines(quest.id).some(item => item.id === line.id));
  } finally { fresh.context.close(); }
});

test('content packages: a failed pending activation preserves the prior active revision and duplicate import repairs damaged payloads', async t => {
  const f = setup(t), one = await pack(f, manifest('local.words', 'words'), wordData(['sword']));
  await install(f.store, one.file); f.context.close(); let fresh = await restart(f);
  try {
    const two = await pack(f, manifest('local.words', 'words', '1.1.0'), wordData(['cat'])); await install(fresh.store, two.file);
    const registry = JSON.parse(fs.readFileSync(path.join(f.directory, 'content-packages/registry.json'), 'utf8'));
    const pending = registry.pending[0]; fresh.context.close();
    fs.writeFileSync(path.join(f.directory, 'content-packages/revisions', pending.digest, 'data.json'), '{}', 'utf8'); fresh = await restart(f);
    assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [3]);
    assert.ok(fresh.store.listContentPackages().some(item => item.id === 'local.words' && item.status === 'error'));
    await install(fresh.store, two.file); fresh.context.close(); fresh = await restart(f);
    assert.deepEqual(fresh.content.getBookWordIds('local.words:small'), [15]);
  } finally { fresh.context.close(); }
});

test('content packages: base upgrades reject reused word IDs and deleted original source rows', async t => {
  const f = setup(t), first = await pack(f, manifest('local.base', 'base'));
  await install(f.store, first.file); f.context.close(); const fresh = await restart(f);
  try {
    assert.equal(fresh.content.getWord(3).lemma, 'sword');
    const changed = await pack(f, manifest('local.base', 'base', '1.1.0'));
    const database = new Database(path.join(changed.author, 'content.db')); database.prepare("UPDATE words SET lemma='different' WHERE id=3").run(); database.close();
    await f.format.packContentDirectory(changed.author, changed.file);
    await assert.rejects(fresh.store.previewContentPackageFile(changed.file), /复用旧内容编号/);
    const removed = await pack(f, manifest('local.base', 'base', '1.2.0'));
    const old = new Database(path.join(removed.author, 'content.db')); old.prepare('DELETE FROM dialog_lines WHERE id=1').run(); old.close();
    await f.format.packContentDirectory(removed.author, removed.file);
    await assert.rejects(fresh.store.previewContentPackageFile(removed.file), /复用旧内容编号/);
    assert.equal(fresh.content.getWord(3).lemma, 'sword');
  } finally { fresh.context.close(); }
});

test('content packages: independently bundled official books retain original IDs and cannot claim another official book', async t => {
  const f = setup(t), bundled = await pack(f, manifest('genshinwords.words.test', 'words'), wordData(['sword'], 'test'));
  const folder = path.join(f.directory, 'word-books'); fs.mkdirSync(folder); fs.copyFileSync(bundled.file, path.join(folder, 'test.gwwords'));
  await f.store.initializeContentPackages();
  assert.deepEqual(f.content.listBooks().map(book => book.id), ['test']);
  assert.deepEqual(f.content.getBookWordIds('test'), [3]);
  const forbidden = await pack(f, manifest('genshinwords.words.test', 'words', '1.1.0'), wordData(['cat'], 'other'));
  await assert.rejects(f.store.previewContentPackageFile(forbidden.file), /自身编号/);
  const custom = await pack(f, manifest('third-party.words', 'words'), wordData(['cat'], 'test'));
  await install(f.store, custom.file); f.context.close(); const fresh = await restart(f);
  try {
    assert.deepEqual(fresh.content.getBookWordIds('test'), [3]);
    assert.deepEqual(fresh.content.getBookWordIds('third-party.words:test'), [15]);
  } finally { fresh.context.close(); }
});

test('content packages: media namespace checks the referenced revision and detects changed image bytes', async t => {
  const f = setup(t), data = materialData(); data.chapters[0].coverPath = 'images/cover.png';
  const image = await require('sharp')({ create: { width: 4, height: 1, channels: 3, background: '#ddeeff' } }).png().toBuffer();
  const content = await pack(f, manifest('local.images', 'materials'), data, '', { 'images/cover.png': image });
  await install(f.store, content.file); f.context.close(); const fresh = await restart(f);
  try {
    const chapter = fresh.content.listChapters().find(item => item.title_en === 'Supplement chapter');
    assert.match(chapter.cover_path, /^gwcontent\/[a-f0-9]{64}\/images\/cover\.png$/);
    const file = fresh.store.getManagedMediaPath(chapter.cover_path, false); assert.ok(file); assert.deepEqual(fs.readFileSync(file), image);
    assert.throws(() => fresh.store.getManagedMediaPath(chapter.cover_path.replace('images/cover.png', 'images/../data.json'), false), /路径/);
    fs.appendFileSync(file, Buffer.from([0])); assert.equal(fresh.store.getManagedMediaPath(chapter.cover_path, false), null);
    await install(fresh.store, content.file); assert.deepEqual(fs.readFileSync(file), image);
    assert.throws(() => fresh.store.getManagedMediaPath(chapter.cover_path, true), /命名空间/);
  } finally { fresh.context.close(); }
});

test('content packages: a lightweight app with no bundled databases keeps management usable and recovers after importing a base', async t => {
  const f = setup(t), base = await pack(f, manifest('recovery.base', 'base'));
  f.context.close(); const empty = path.join(f.directory, 'lightweight-app'); fs.mkdirSync(empty);
  const missingFile = path.join(empty, 'content.db');
  let context = loadMain(missingFile, f.progressPath, { bundledReadingPackagePath: null });
  try {
    let store = context.load('content-package-store'); await store.initializeContentPackages();
    let content = context.load('content-db'), management = context.load('content-management');
    assert.equal(content.contentAvailable(), false); assert.equal(content.openContentDb(), null);
    assert.ok((await management.listManagedContentPackages()).some(item => item.id === 'base-resources-missing' && item.status === 'error'));
    const preview = await management.previewManagedContentPackage(base.file);
    assert.equal((await management.importManagedContentPackage(preview.token)).restartRequired, true);
    assert.equal(content.openContentDb(), null, 'Import must keep the running app on its previous content');
    context.close(); context = loadMain(missingFile, f.progressPath, { bundledReadingPackagePath: null });
    store = context.load('content-package-store'); await store.initializeContentPackages(); content = context.load('content-db');
    assert.equal(content.contentAvailable(), true); assert.equal(content.getWord(3).lemma, 'sword');
    assert.ok(store.listContentPackages().some(item => item.id === 'recovery.base' && item.status === 'active'));
    assert.ok(!store.listContentPackages().some(item => item.id === 'base-resources-missing'));
  } finally { context.close(); }
});

test('content packages: all eleven independently versioned official books preserve original IDs, members and order', async t => {
  const f = setup(t), originalFile = path.join(root, 'content/content.db');
  const original = new Database(originalFile, { readonly: true, fileMustExist: true });
  const context = loadMain(originalFile, f.progressPath, { bundledReadingPackagePath: null, contentPackagesDir: path.join(f.directory, 'official-packages') });
  try {
    const expected = original.prepare('SELECT id,name,name_zh,description FROM books ORDER BY sort_order').all(); assert.equal(expected.length, 11);
    const authorRoot = path.join(root, 'content-library/word-books');
    assert.deepEqual(fs.readdirSync(authorRoot).filter(name => fs.statSync(path.join(authorRoot, name)).isDirectory()).sort(), expected.map(book => book.id).sort());
    const store = context.load('content-package-store'); await store.initializeContentPackages(); const content = context.load('content-db');
    assert.deepEqual(content.listBooks().map(book => book.id), expected.map(book => book.id));
    for (const book of expected) {
      const author = JSON.parse(fs.readFileSync(path.join(authorRoot, book.id, 'data.json'), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(authorRoot, book.id, 'manifest.json'), 'utf8'));
      assert.equal(manifest.id, 'genshinwords.words.' + book.id); assert.equal(manifest.minAppVersion, '1.1.0');
      const words = original.prepare('SELECT w.id,w.lemma FROM book_words bw JOIN words w ON w.id=bw.word_id WHERE bw.book_id=? ORDER BY bw.rank,w.id').all(book.id);
      assert.deepEqual(author.books, [{ ...book, lemmas: words.map(word => word.lemma) }]);
      assert.deepEqual(content.getBookWordIds(book.id), words.map(word => word.id));
    }
    assert.equal(store.listContentPackages().filter(item => item.kind === 'words' && item.status === 'active' && item.builtIn).length, 11);
  } finally { context.close(); original.close(); }
});

test('content packages: base databases reject personal tables, malformed source schemas, executable schema and missing referenced media', async t => {
  const f = setup(t);
  const personal = await pack(f, manifest('unsafe.personal', 'base'));
  let database = new Database(path.join(personal.author, 'content.db')); database.exec('CREATE TABLE cards(word_id INTEGER)'); database.close();
  await f.format.packContentDirectory(personal.author, personal.file);
  await assert.rejects(f.store.previewContentPackageFile(personal.file), /个人学习记录/);
  const incomplete = await pack(f, manifest('unsafe.materials', 'base'));
  database = new Database(path.join(incomplete.author, 'materials.db')); database.exec('DROP TABLE texts'); database.close();
  await f.format.packContentDirectory(incomplete.author, incomplete.file);
  await assert.rejects(f.store.previewContentPackageFile(incomplete.file), /materials.db 缺少/);
  const executable = await pack(f, manifest('unsafe.schema', 'base'));
  database = new Database(path.join(executable.author, 'materials.db')); database.exec('CREATE VIEW hostile_view AS SELECT id FROM materials'); database.close();
  await f.format.packContentDirectory(executable.author, executable.file);
  await assert.rejects(f.store.previewContentPackageFile(executable.file), /视图/);
  const missing = await pack(f, manifest('unsafe.media', 'base'));
  database = new Database(path.join(missing.author, 'content.db')); database.exec("UPDATE chapters SET cover_path='missing.png'"); database.close();
  await f.format.packContentDirectory(missing.author, missing.file);
  await assert.rejects(f.store.previewContentPackageFile(missing.file), /缺少数据库引用的媒体/);
  assert.equal(f.store.listContentPackages().filter(item => item.status === 'pending').length, 0);
});

test('content packages: legacy raw base resources show an unregistered compatibility card until a managed base activates', async t => {
  const f = setup(t);
  const legacy = f.store.listContentPackages().find(item => item.id === 'legacy-base-resources');
  assert.equal(legacy.name, '旧内置基础素材'); assert.equal(legacy.version, '未登记'); assert.equal(legacy.formatVersion, 0);
  assert.equal(legacy.status, 'active'); assert.ok(legacy.message.includes('未登记'));
  const base = await pack(f, manifest('managed.replacement', 'base')); await install(f.store, base.file);
  assert.ok(f.store.listContentPackages().some(item => item.id === 'legacy-base-resources'), 'The running process still uses the fallback base');
  f.context.close(); const fresh = await restart(f);
  try {
    assert.ok(!fresh.store.listContentPackages().some(item => item.id === 'legacy-base-resources'));
    assert.ok(fresh.store.listContentPackages().some(item => item.id === 'managed.replacement' && item.status === 'active'));
  } finally { fresh.context.close(); }
});

test('content packages: deep profile directories use short SQLite staging names on Windows', async t => {
 const f=setup(t);
 const pad='nested-'.repeat(Math.max(1,Math.ceil((163-f.directory.length)/7)));
 const managed=path.join(f.directory,pad);
 assert.ok(managed.length>160 && managed.length<180);
 const context=loadMain(f.contentPath,f.progressPath,{bundledReadingPackagePath:null,contentPackagesDir:managed});
 const store=context.load('content-package-store');
 try {
  const one=await pack(f,manifest('deep.words','words'),wordData());
  await store.initializeContentPackages();
  const preview=await store.previewContentPackageFile(one.file);
  assert.equal((await store.importContentPackage(preview.token)).package.status,'pending');
 } finally {context.close();}
});
