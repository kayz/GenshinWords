const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');
const { loadMain, root } = require('./helpers/load-main.cjs');

function setup(t) {
  const f = fixture(t, { bundledReadingPackagePath: null });
  const source = path.join(f.directory, 'selected'); fs.mkdirSync(source);
  return { ...f, source, controller: f.context.load('resource-directories'), format: f.context.load('content-package-format'),
    store: f.context.load('content-package-store'), raw: f.context.load('resource-directory-config') };
}
function manifest(id, kind = 'words', version = '1.0.0', dependencies) {
  return { id, name: id, kind, version, minAppVersion: '1.1.0', author: 'Synthetic directory regression', createdAt: '2026-10-23T00:00:00.000Z',
    ...(dependencies ? { dependencies } : {}) };
}
function words(lemmas = ['sword'], id = 'small') { return { books: [{ id, name: id, name_zh: '合成词书', description: '本地选词', lemmas }] }; }
function materials() {
  return { chapters: [{ id: 'synthetic-chapter', title_en: 'Synthetic chapter', title_chs: '合成章节', type: 'quest', version: '1',
    sourceUrl: 'https://example.test/directory-regression', quests: [{ id: 'synthetic-quest', title_en: 'Synthetic quest', title_chs: '合成任务',
      lines: [{ id: 'synthetic-line', speaker: 'Test', text_en: 'A sword is here.', text_chs: '这里有一把剑。' }] }] }] };
}
function copyDatabases(f, target) {
  fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(f.contentPath, path.join(target, 'content.db'));
  const content = new Database(path.join(target, 'content.db')); content.exec('UPDATE words SET audio_uk=NULL,audio_us=NULL'); content.close();
  const db = new Database(path.join(target, 'materials.db'));
  db.exec('CREATE TABLE materials(id TEXT PRIMARY KEY); CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT)'); db.close();
}
async function pack(f, name, header, data) {
  const author = path.join(f.directory, 'authors', randomUUID()); fs.mkdirSync(author, { recursive: true });
  fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify(header), 'utf8');
  if (header.kind === 'base') copyDatabases(f, author);
  else fs.writeFileSync(path.join(author, 'data.json'), JSON.stringify(data), 'utf8');
  const file = path.join(f.source, name); await f.format.packContentDirectory(author, file); return { file, author };
}
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function rawDirectory(f, directory = f.source) {
  copyDatabases(f, directory); fs.mkdirSync(path.join(directory, 'images')); fs.mkdirSync(path.join(directory, 'audio'));
  return directory;
}

test('resource directories: shallow standard layouts isolate corrupt packages and ignore arbitrary/deep folders', async t => {
  const f = setup(t);
  await pack(f, 'word-books/good.gwwords', manifest('directory.good'), words());
  await pack(f, 'content/reading/another.gwwords', manifest('directory.nested'), words(['cat']));
  await pack(f, 'arbitrary/ignored.gwwords', manifest('directory.ignored'), words());
  await pack(f, 'content/packages/reading/too-deep.gwwords', manifest('directory.deep'), words());
  fs.writeFileSync(path.join(f.source, 'broken.gwcontent'), Buffer.from('broken'));
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.kind, 'packages'); assert.equal(preview.canLoad, true); assert.equal(preview.packages.length, 3);
  assert.equal(preview.packages.filter(item => item.status === 'ready').length, 2);
  assert.equal(preview.packages.find(item => item.relativePath === 'broken.gwcontent').status, 'error');
  assert.ok(preview.warnings.some(text => text.includes('本机缓存')));
  assert.equal(fs.existsSync(path.join(f.directory, 'resource-package-directory.json')), false, 'Preview must not save a source selection');
});

test('resource directories: highest valid version wins, hot activation preserves progress, rescans reject downgrades', async t => {
  const f = setup(t), old = await pack(f, 'old.gwwords', manifest('directory.version'), words(['sword']));
  const current = await pack(f, 'current.gwwords', manifest('directory.version', 'words', '2.0.0'), words(['cat']));
  fs.writeFileSync(path.join(f.source, 'corrupt-newest.gwwords'), 'not a package');
  const hashes = [sha(old.file), sha(current.file)], progress = f.progress.openProgressDb();
  progress.prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(3, 'test', '2026-10-23');
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.packages.find(item => item.package?.version === '1.0.0').status, 'skipped');
  assert.equal(preview.packages.find(item => item.package?.version === '2.0.0').status, 'ready');
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 1);
  assert.deepEqual(f.content.getBookWordIds('directory.version:small'), [15], 'The new book must be usable without restarting');
  assert.equal(progress.prepare('SELECT COUNT(*) n FROM cards').get().n, 1);
  assert.deepEqual([sha(old.file), sha(current.file)], hashes);
  assert.equal(result.status.packageDirectory, fs.realpathSync(f.source));
  fs.unlinkSync(current.file); fs.unlinkSync(path.join(f.source, 'corrupt-newest.gwwords'));
  const rescanned = await f.controller.scanConfiguredResourceDirectory();
  assert.equal(rescanned.packages[0].status, 'error'); assert.match(rescanned.packages[0].message, /不会降级/); assert.equal(rescanned.canLoad, false);
  fs.renameSync(f.source, f.source + '-unavailable');
  assert.equal(f.controller.getResourceDirectoryStatus().packageDirectoryAvailable, false);
  assert.deepEqual(f.content.getBookWordIds('directory.version:small'), [15], 'A missing package source must not disable its immutable cache');
});

test('resource directories: same highest version with different contents blocks that identity without blocking another package', async t => {
  const f = setup(t);
  await pack(f, 'one.gwwords', manifest('directory.conflict'), words());
  await pack(f, 'two.gwwords', manifest('directory.conflict'), words(['cat']));
  await pack(f, 'older.gwwords', manifest('directory.conflict', 'words', '0.9.0'), words());
  await pack(f, 'healthy.gwwords', manifest('directory.healthy'), words(['cat']));
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.packages.filter(item => item.package?.id === 'directory.conflict' && item.status === 'error').length, 3);
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 3);
  assert.deepEqual(f.content.getBookWordIds('directory.healthy:small'), [15]);
});

test('resource directories: semantic failure is isolated and existing word membership and personal records survive', async t => {
  const f = setup(t);
  await pack(f, 'a-invalid.gwwords', manifest('directory.invalid'), words(['notinthisdictionary']));
  await pack(f, 'b-valid.gwwords', manifest('directory.valid'), words(['cat']));
  const old = f.content.getBookWordIds('test'); f.collect(1, 'sword');
  const saved = f.context.load('collections').getCollectedSource(3);
  const preview = await f.controller.previewResourceDirectory(f.source), result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 1);
  assert.match(result.results.find(item => item.package?.id === 'directory.invalid').message, /现有词条/);
  assert.deepEqual(f.content.getBookWordIds('test'), old); assert.deepEqual(f.context.load('collections').getCollectedSource(3), saved);
  assert.deepEqual(f.content.getBookWordIds('directory.valid:small'), [15]);
});

test('resource directories: base, dependency chain, material and reading activate in order without a restart', async t => {
  const f = setup(t);
  await pack(f, 'z-base.gwcontent', manifest('directory.base', 'base'));
  await pack(f, 'b-provider.gwwords', manifest('directory.provider', 'words', '1.0.0', [{ id: 'directory.base', minVersion: '1.0.0' }]), words());
  await pack(f, 'a-dependent.gwcontent', manifest('directory.material', 'materials', '1.0.0', [{ id: 'directory.provider', minVersion: '1.0.0' }]), materials());
  fs.copyFileSync(path.join(root, 'reading-library/examples/shared-question.gwreading'), path.join(f.source, '0-reading.gwreading'));
  await pack(f, 'missing.gwwords', manifest('directory.missing', 'words', '1.0.0', [{ id: 'missing.base', minVersion: '1.0.0' }]), words());
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.packages.find(item => item.package?.id === 'directory.missing').status, 'error');
  const result = await f.controller.loadResourceDirectory(preview.token), loaded = result.results.filter(item => item.status === 'loaded');
  assert.deepEqual(loaded.map(item => item.package.kind), ['base', 'words', 'materials', 'reading']);
  assert.equal(result.loadedCount, 4); assert.equal(result.failedCount, 1);
  assert.deepEqual(f.content.getBookWordIds('directory.provider:small'), [3]);
  assert.ok(f.content.listChapters().some(item => item.title_en === 'Synthetic chapter'));
  assert.ok(f.context.load('reading-package-store').listReadingPackages().some(item => item.id === loaded.find(item => item.package.kind === 'reading').package.id));
});

test('resource directories: dependency cycles and ambiguous different base identities are explicit errors', async t => {
  const f = setup(t);
  await pack(f, 'a.gwwords', manifest('directory.a', 'words', '1.0.0', [{ id: 'directory.b', minVersion: '1.0.0' }]), words());
  await pack(f, 'b.gwwords', manifest('directory.b', 'words', '1.0.0', [{ id: 'directory.a', minVersion: '1.0.0' }]), words());
  await pack(f, 'one.gwcontent', manifest('directory.base1', 'base'));
  await pack(f, 'two.gwcontent', manifest('directory.base2', 'base'));
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.canLoad, false); assert.equal(preview.packages.filter(item => item.status === 'error').length, 4);
  assert.ok(preview.packages.some(item => /多个不同编号/.test(item.message))); assert.ok(preview.packages.some(item => /循环/.test(item.message)));
});

test('resource directories: changed sources are rejected independently and tokens accept no renderer file paths', async t => {
  const f = setup(t), one = await pack(f, 'a-change.gwwords', manifest('directory.changed'), words());
  await pack(f, 'b-valid.gwwords', manifest('directory.valid'), words(['cat']));
  const preview = await f.controller.previewResourceDirectory(f.source);
  fs.writeFileSync(path.join(one.author, 'data.json'), JSON.stringify(words(['cat'])), 'utf8');
  await f.format.packContentDirectory(one.author, one.file);
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.failedCount, 1); assert.equal(result.loadedCount, 1);
  assert.match(result.results.find(item => item.package?.id === 'directory.changed').message, /预览后发生变化/);
  await assert.rejects(f.controller.loadResourceDirectory(preview.token), /已经使用/);
  await assert.rejects(f.controller.loadResourceDirectory(one.file), /过期/);
  await assert.rejects(f.controller.loadResourceDirectory({ path: one.file }), /先选择/);
});

test('resource directories: raw wins in mixed sources and named package dependencies never assume an unknown raw version', async t => {
  const f = setup(t); await rawDirectory(f);
  await pack(f, 'base.gwcontent', manifest('directory.base', 'base'));
  await pack(f, 'words.gwwords', manifest('directory.words'), words(['cat']));
  await pack(f, 'needs-base.gwwords', manifest('directory.needs-base', 'words', '1.0.0', [{ id: 'directory.base', minVersion: '1.0.0' }]), words());
  const before = sha(path.join(f.source, 'content.db')), preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.kind, 'mixed'); assert.equal(preview.raw.status, 'ready');
  assert.equal(preview.packages.find(item => item.package?.kind === 'base').status, 'skipped');
  assert.equal(preview.packages.find(item => item.package?.id === 'directory.needs-base').status, 'error');
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.raw.status, 'active'); assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 1);
  assert.equal(result.status.raw.path, fs.realpathSync(f.source)); assert.equal(sha(path.join(f.source, 'content.db')), before);
  assert.deepEqual(f.content.getBookWordIds('directory.words:small'), [15]);
});

test('resource directories: raw-only can rescan, and an explicit package base atomically replaces a previous raw source', async t => {
  const f = setup(t); await rawDirectory(f);
  await f.controller.loadResourceDirectory((await f.controller.previewResourceDirectory(f.source)).token);
  assert.equal(f.controller.getResourceDirectoryStatus().packageDirectory, null);
  assert.equal((await f.controller.scanConfiguredResourceDirectory()).kind, 'raw');
  const previous = f.source; f.source = path.join(f.directory, 'packages-only'); fs.mkdirSync(f.source);
  await pack(f, 'base.gwcontent', manifest('directory.replacement', 'base'));
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.ok(preview.warnings.some(text => text.includes('替换当前原始')));
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 0); assert.equal(result.status.raw, null);
  assert.ok(f.store.listContentPackages().some(item => item.id === 'directory.replacement' && item.status === 'active'));
  assert.ok(fs.existsSync(path.join(previous, 'content.db')));
});

test('resource directories: raw changed after preview keeps the old selection and reports its reason', async t => {
  const f = setup(t); await rawDirectory(f);
  await f.controller.loadResourceDirectory((await f.controller.previewResourceDirectory(f.source)).token);
  const old = f.controller.getResourceDirectoryStatus().raw.path;
  const next = path.join(f.directory, 'new-raw'); await rawDirectory(f, next);
  const preview = await f.controller.previewResourceDirectory(next);
  const db = new Database(path.join(next, 'content.db')); db.exec("UPDATE words SET translation='changed' WHERE id=3"); db.close();
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.failedCount, 1); assert.equal(result.raw.status, 'error'); assert.match(result.raw.message, /变化|改动/);
  assert.equal(result.status.raw.path, old); assert.equal(f.content.getWord(3).lemma, 'sword');
});

test('resource directories: links cannot escape scan boundaries or replace a validated parent after preview', async t => {
  const f = setup(t), outside = path.join(f.directory, 'external'); fs.mkdirSync(outside);
  const initial = await pack(f, 'content/inside.gwwords', manifest('directory.inside'), words());
  await pack(f, 'healthy.gwwords', manifest('directory.healthy'), words(['cat']));
  const rootLink = path.join(f.directory, 'root-junction'); fs.symlinkSync(f.source, rootLink, 'junction');
  await assert.rejects(f.controller.previewResourceDirectory(rootLink), /链接|移动/);
  fs.symlinkSync(outside, path.join(f.source, 'packages'), 'junction');
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.ok(preview.warnings.some(text => text.includes('链接目录')));
  fs.copyFileSync(initial.file, path.join(outside, 'inside.gwwords'));
  fs.renameSync(path.join(f.source, 'content'), path.join(f.source, 'retired-content'));
  fs.symlinkSync(outside, path.join(f.source, 'content'), 'junction');
  const result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 1);
  assert.match(result.results.find(item => item.package?.id === 'directory.inside').message, /符号链接/);
});

test('resource directories: scan count and expired/evicted preview tokens are bounded', async t => {
  const f = setup(t), first = await pack(f, '000.gwwords', manifest('directory.copies'), words());
  for (let index = 1; index < 132; index++) fs.copyFileSync(first.file, path.join(f.source, String(index).padStart(3, '0') + '.gwwords'));
  const preview = await f.controller.previewResourceDirectory(f.source);
  assert.equal(preview.packages.length, 128); assert.ok(preview.warnings.some(text => text.includes('128')));
  for (let index = 1; index < 132; index++) fs.unlinkSync(path.join(f.source, String(index).padStart(3, '0') + '.gwwords'));
  for (let index = 0; index < 8; index++) await f.controller.previewResourceDirectory(f.source);
  await assert.rejects(f.controller.loadResourceDirectory(preview.token), /过期/);
  const expiring = await f.controller.previewResourceDirectory(f.source), oldNow = Date.now;
  try { Date.now = () => oldNow() + 31 * 60_000; await assert.rejects(f.controller.loadResourceDirectory(expiring.token), /过期/); }
  finally { Date.now = oldNow; }
});

test('resource directories: configured package location survives a fresh process context with isolated paths', async t => {
  const f = setup(t); await pack(f, 'book.gwwords', manifest('directory.saved'), words());
  await f.controller.loadResourceDirectory((await f.controller.previewResourceDirectory(f.source)).token);
  f.context.close();
  const fresh = loadMain(f.contentPath, f.progressPath, { bundledReadingPackagePath: null });
  try {
    const controller = fresh.load('resource-directories');
    assert.equal(controller.getResourceDirectoryStatus().packageDirectory, fs.realpathSync(f.source));
    const preview = await controller.scanConfiguredResourceDirectory();
    assert.equal(preview.packages[0].action, 'unchanged'); assert.equal(preview.packages[0].status, 'ready');
  } finally { fresh.close(); }
});

test('resource directories: failed hot activation discards only its new pending package and keeps later packages usable', async t => {
  const f = setup(t);
  await f.store.initializeContentPackages(); f.content.openContentDb();
  await pack(f, 'a-fails.gwwords', manifest('directory.activation-fails'), words());
  await pack(f, 'b-works.gwwords', manifest('directory.activation-works'), words(['cat']));
  const old = f.content.getBookWordIds('test'), actual = f.store.activatePendingContentPackages; let first = true;
  f.store.activatePendingContentPackages = async options => {
    if (first) { first = false; throw new Error('Injected open failure'); }
    return actual(options);
  };
  const preview = await f.controller.previewResourceDirectory(f.source), result = await f.controller.loadResourceDirectory(preview.token);
  assert.equal(result.loadedCount, 1); assert.equal(result.failedCount, 1);
  assert.match(result.results.find(item => item.package?.id === 'directory.activation-fails').message, /Injected open failure/);
  assert.deepEqual(f.content.getBookWordIds('test'), old);
  assert.deepEqual(f.content.getBookWordIds('directory.activation-works:small'), [15]);
  const registry = JSON.parse(fs.readFileSync(path.join(f.directory, 'content-packages/registry.json'), 'utf8'));
  assert.equal(registry.pending.length, 0); assert.equal(registry.active.some(item => item.header.manifest.id === 'directory.activation-fails'), false);
});

test('resource directories: concurrent confirmations serialize upgrades and never silently restore an older revision', async t => {
  const f = setup(t), firstDirectory = f.source;
  await pack(f, 'one.gwwords', manifest('directory.concurrent'), words());
  const one = await f.controller.previewResourceDirectory(f.source);
  f.source = path.join(f.directory, 'second'); fs.mkdirSync(f.source);
  await pack(f, 'two.gwwords', manifest('directory.concurrent', 'words', '2.0.0'), words(['cat']));
  const two = await f.controller.previewResourceDirectory(f.source);
  const results = await Promise.all([f.controller.loadResourceDirectory(one.token), f.controller.loadResourceDirectory(two.token)]);
  assert.deepEqual(results.map(item => item.loadedCount), [1, 1]);
  assert.deepEqual(f.content.getBookWordIds('directory.concurrent:small'), [15]);
  const older = await f.controller.previewResourceDirectory(firstDirectory);
  assert.equal(older.canLoad, false); assert.match(older.packages[0].message, /不会降级/);
});
