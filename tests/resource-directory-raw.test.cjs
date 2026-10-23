const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');
const { loadMain } = require('./helpers/load-main.cjs');

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cL1cAAAAASUVORK5CYII=', 'base64');
function setup(t) {
  const f = fixture(t, { bundledReadingPackagePath: null });
  return { ...f, raw: f.context.load('resource-directory-config'), store: f.context.load('content-package-store'), format: f.context.load('content-package-format') };
}
function author(f, label, change) {
  const directory = path.join(f.directory, 'raw-' + label);
  fs.mkdirSync(path.join(directory, 'images'), { recursive: true }); fs.mkdirSync(path.join(directory, 'audio'));
  fs.copyFileSync(f.contentPath, path.join(directory, 'content.db'));
  const content = new Database(path.join(directory, 'content.db'));
  content.exec("UPDATE words SET audio_uk=NULL,audio_us=NULL; UPDATE chapters SET cover_path='tiny.png'; UPDATE words SET audio_uk='audio/word.wav' WHERE id=3");
  content.prepare('UPDATE words SET translation=? WHERE id=3').run('raw ' + label);
  change?.(content); content.close();
  const materials = new Database(path.join(directory, 'materials.db'));
  materials.exec("CREATE TABLE materials(id TEXT PRIMARY KEY); CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT); INSERT INTO materials VALUES('one'); INSERT INTO texts VALUES('one','en','Original material','[]')"); materials.close();
  fs.writeFileSync(path.join(directory, 'images/tiny.png'), image);
  fs.writeFileSync(path.join(directory, 'audio/word.wav'), Buffer.from('RIFF0000WAVEfmt synthetic isolated source'));
  fs.writeFileSync(path.join(directory, 'resource-manifest.json'), JSON.stringify({ name: 'Raw ' + label, version: '6.3-' + label }), 'utf8');
  return directory;
}
async function activate(f, directory) {
  const preview = await f.raw.prepareRawResourceDirectory(directory);
  await f.raw.activateRawResourceDirectory(preview.token); return preview;
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('raw resources hot activate read-only DB snapshots and original media without changing learning records', async t => {
  const f = setup(t), directory = author(f, 'one');
  const before = hash(path.join(directory, 'content.db'));
  f.collect(1, 'sword'); const source = f.context.load('collections').getCollectedSource(3);
  const progress = f.progress.openProgressDb(); progress.prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(3, 'test', '2026-10-23');
  assert.equal(f.content.getWord(3).translation, '剑');
  const preview = await activate(f, directory);
  assert.equal(preview.raw.wordCount, 18); assert.equal(preview.raw.chapterCount, 1); assert.equal(preview.raw.lineCount, 7);
  assert.equal(f.content.getWord(3).translation, 'raw one');
  assert.equal(f.store.getManagedBaseDirectory(f.directory), directory);
  assert.equal(f.raw.getRawResourceDirectoryStatus().version, '6.3-one');
  const revision = f.raw.getSelectedRawResourceRevision(), chapter = f.content.openContentDb().prepare('SELECT cover_path FROM chapters WHERE id=1').get();
  assert.equal(chapter.cover_path, 'gwcontent/' + revision.digest + '/images/tiny.png');
  assert.equal(f.store.getManagedMediaPath(chapter.cover_path, false), path.join(directory, 'images/tiny.png'));
  const audio = f.content.openContentDb().prepare('SELECT audio_uk FROM words WHERE id=3').get().audio_uk;
  assert.equal(f.store.getManagedMediaPath(audio, true), path.join(directory, 'audio/word.wav'));
  assert.deepEqual(fs.readdirSync(revision.directory).sort(), ['content.db', 'materials.db', 'raw.json']);
  assert.deepEqual(f.context.load('collections').getCollectedSource(3), source);
  assert.equal(progress.prepare('SELECT COUNT(*) n FROM cards WHERE word_id=3').get().n, 1);
  assert.equal(hash(path.join(directory, 'content.db')), before);
  assert.equal(f.store.listContentPackages().some(item => item.id === 'legacy-base-resources'), false);
});

test('raw repeated previews reuse the current immutable snapshot while its content remains open', async t => {
  const f = setup(t), directory = author(f, 'same'); await activate(f, directory);
  const current = f.raw.getSelectedRawResourceRevision(), file = path.join(current.directory, 'content.db'), before = fs.statSync(file);
  const preview = await f.raw.prepareRawResourceDirectory(directory);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs); assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(f.content.getWord(3).translation, 'raw same');
  await f.raw.activateRawResourceDirectory(preview.token);
  assert.equal(f.raw.getSelectedRawResourceRevision().digest, current.digest);
});

test('raw unsafe SQLite, changed identities, missing assets and traversal are rejected with the active source intact', async t => {
  const f = setup(t); await activate(f, author(f, 'good'));
  const config = fs.readFileSync(f.raw.getResourceDirectoryConfigPath(), 'utf8');
  const badEnglish = author(f, 'changed-en', db => db.exec("UPDATE dialog_lines SET text_en='Reused old line' WHERE id=1"));
  await assert.rejects(f.raw.prepareRawResourceDirectory(badEnglish), /不能删除或复用/);
  const personal = author(f, 'personal', db => db.exec('CREATE TABLE cards(word_id INTEGER)'));
  await assert.rejects(f.raw.prepareRawResourceDirectory(personal), /个人学习/);
  const trigger = author(f, 'trigger', db => db.exec('CREATE TRIGGER unwanted AFTER INSERT ON words BEGIN SELECT 1; END'));
  await assert.rejects(f.raw.prepareRawResourceDirectory(trigger), /触发器/);
  const escape = author(f, 'escape', db => db.exec("UPDATE chapters SET cover_path='../other.png'"));
  await assert.rejects(f.raw.prepareRawResourceDirectory(escape), /不安全/);
  const absent = author(f, 'absent'); fs.unlinkSync(path.join(absent, 'images/tiny.png'));
  await assert.rejects(f.raw.prepareRawResourceDirectory(absent), /缺少数据库引用/);
  assert.equal(f.content.getWord(3).translation, 'raw good'); assert.equal(fs.readFileSync(f.raw.getResourceDirectoryConfigPath(), 'utf8'), config);
});

test('raw confirmation rejects database/media changes after preview and media loss is explicit', async t => {
  const f = setup(t), current = author(f, 'old'); await activate(f, current);
  const candidate = author(f, 'candidate'), preview = await f.raw.prepareRawResourceDirectory(candidate);
  const changed = new Database(path.join(candidate, 'content.db')); changed.exec("UPDATE words SET translation='changed' WHERE id=3"); changed.close();
  await assert.rejects(f.raw.activateRawResourceDirectory(preview.token), /数据库已改动/);
  assert.equal(f.content.getWord(3).translation, 'raw old');
  const media = author(f, 'media'), mediaPreview = await f.raw.prepareRawResourceDirectory(media);
  fs.appendFileSync(path.join(media, 'images/tiny.png'), 'changed');
  await assert.rejects(f.raw.activateRawResourceDirectory(mediaPreview.token), /预览后发生变化/);
  const revision = f.raw.getSelectedRawResourceRevision(); fs.unlinkSync(path.join(current, 'images/tiny.png'));
  assert.throws(() => f.store.getManagedMediaPath('gwcontent/' + revision.digest + '/images/tiny.png', false), /旧资源已移除、改动或不可访问/);
  assert.equal(f.raw.getRawResourceDirectoryStatus().status, 'error');
});

test('raw startup restores the configured source and reports missing databases and offline directories', async t => {
  const f = setup(t), directory = author(f, 'restore'); await activate(f, directory); f.context.close();
  let context = loadMain(f.contentPath, f.progressPath, { bundledReadingPackagePath: null });
  try {
    let raw = context.load('resource-directory-config'); await raw.initializeResourceDirectory(); await context.load('content-package-store').initializeContentPackages();
    assert.equal(context.load('content-db').getWord(3).translation, 'raw restore');
    fs.renameSync(path.join(directory, 'materials.db'), path.join(directory, 'materials.saved'));
    assert.equal(raw.getRawResourceDirectoryStatus().status, 'error');
    fs.renameSync(path.join(directory, 'materials.saved'), path.join(directory, 'materials.db'));
    context.close(); fs.renameSync(directory, directory + '-offline');
    context = loadMain(f.contentPath, f.progressPath, { bundledReadingPackagePath: null }); raw = context.load('resource-directory-config');
    await raw.initializeResourceDirectory(); assert.equal(raw.getRawResourceDirectoryStatus().status, 'error');
    assert.match(raw.getRawResourceDirectoryStatus().message, /不可用|移除|不可访问/);
    context.close(); fs.renameSync(directory + '-offline', directory);
    context = loadMain(f.contentPath, f.progressPath, { bundledReadingPackagePath: null }); raw = context.load('resource-directory-config');
    await raw.initializeResourceDirectory(); await context.load('content-package-store').initializeContentPackages();
    assert.equal(raw.getRawResourceDirectoryStatus().status, 'active'); assert.equal(context.load('content-db').getWord(3).translation, 'raw restore');
  } finally { context.close(); }
});

test('raw hot activation rechecks current identities and rolls back state, configuration and the open DB on persistence failure', async t => {
  const f = setup(t); await activate(f, author(f, 'a'));
  const b = await f.raw.prepareRawResourceDirectory(author(f, 'b'));
  const c = author(f, 'c', db => db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'newword','新词')")); await activate(f, c);
  await assert.rejects(f.raw.activateRawResourceDirectory(b.token), /不能删除或复用/);
  assert.equal(f.content.getWord(3).translation, 'raw c'); assert.equal(f.content.getWord(99).lemma, 'newword');
  const d = author(f, 'd', db => db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'newword','新词')"));
  const preview = await f.raw.prepareRawResourceDirectory(d), configPath = f.raw.getResourceDirectoryConfigPath();
  const before = fs.readFileSync(configPath, 'utf8'), rename = fs.renameSync;
  fs.renameSync = function(from, to) { if (to === configPath) throw Error('synthetic persistence failure'); return rename.call(fs, from, to); };
  try { await assert.rejects(f.raw.activateRawResourceDirectory(preview.token), /synthetic persistence failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.content.getWord(3).translation, 'raw c'); assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(f.raw.getRawResourceDirectoryStatus().path, c);
});

test('raw can atomically switch to a managed base and hot activate word packages while historical raw assets remain resolvable', async t => {
  const f = setup(t), directory = author(f, 'external'); await activate(f, directory);
  const rawRevision = f.raw.getSelectedRawResourceRevision();
  const authorDirectory = path.join(f.directory, 'base-author'); fs.mkdirSync(authorDirectory);
  fs.copyFileSync(f.contentPath, path.join(authorDirectory, 'content.db')); fs.copyFileSync(path.join(directory, 'materials.db'), path.join(authorDirectory, 'materials.db'));
  const db = new Database(path.join(authorDirectory, 'content.db')); db.exec("UPDATE words SET audio_uk=NULL,audio_us=NULL; UPDATE words SET translation='managed' WHERE id=3"); db.close();
  fs.writeFileSync(path.join(authorDirectory, 'manifest.json'), JSON.stringify({ id: 'test.managed.base', name: 'Managed base', kind: 'base', version: '1.0.0', minAppVersion: '1.1.0', author: 'test', createdAt: '2026-10-23T00:00:00.000Z' }), 'utf8');
  const file = path.join(f.directory, 'base.gwcontent'); await f.format.packContentDirectory(authorDirectory, file);
  await f.store.importContentPackage((await f.store.previewContentPackageFile(file)).token);
  assert.equal(f.content.getWord(3).translation, 'raw external'); await f.store.activatePendingContentPackages({ clearRaw: true });
  assert.equal(f.raw.getRawResourceDirectoryStatus(), null); assert.equal(f.content.getWord(3).translation, 'managed');
  assert.equal(f.store.getManagedMediaPath('gwcontent/' + rawRevision.digest + '/images/tiny.png', false), path.join(directory, 'images/tiny.png'));
  const words = path.join(f.directory, 'word-author'); fs.mkdirSync(words);
  fs.writeFileSync(path.join(words, 'manifest.json'), JSON.stringify({ id: 'hot.words', name: 'Hot words', kind: 'words', version: '1.0.0', minAppVersion: '1.1.0', author: 'test', createdAt: '2026-10-23T00:00:00.000Z' }), 'utf8');
  fs.writeFileSync(path.join(words, 'data.json'), JSON.stringify({ books: [{ id: 'one', name: 'One', name_zh: '一', description: '', lemmas: ['sword'] }] }), 'utf8');
  const wordFile = path.join(f.directory, 'hot.gwwords'); await f.format.packContentDirectory(words, wordFile);
  await f.store.importContentPackage((await f.store.previewContentPackageFile(wordFile)).token);
  assert.equal(f.content.listBooks().some(book => book.id === 'hot.words:one'), false);
  await f.store.activatePendingContentPackages(); assert.deepEqual(f.content.getBookWordIds('hot.words:one'), [3]);
});

test('raw directory symlinks and linked media are rejected', async t => {
  const f = setup(t), directory = author(f, 'links'), link = path.join(f.directory, 'linked-raw');
  try { fs.symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
  await assert.rejects(f.raw.prepareRawResourceDirectory(link), /符号链接|目录联接/);
  const external = path.join(f.directory, 'external-media'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file.png'), image);
  fs.symlinkSync(external, path.join(directory, 'images/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.raw.prepareRawResourceDirectory(directory), /符号链接|目录联接/);
});

test('raw confirmation rechecks ancestors when a media directory becomes a junction during validation', async t => {
  const f = setup(t); await activate(f, author(f, 'stable'));
  const directory = author(f, 'racing'), preview = await f.raw.prepareRawResourceDirectory(directory);
  const external = path.join(f.directory, 'race-target'); fs.mkdirSync(external); fs.copyFileSync(path.join(directory, 'images/tiny.png'), path.join(external, 'tiny.png'));
  const probe = path.join(f.directory, 'race-link');
  try { fs.symlinkSync(external, probe, process.platform === 'win32' ? 'junction' : 'dir'); fs.unlinkSync(probe); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
  const original = fs.lstatSync, target = path.join(directory, 'images/tiny.png'); let replaced = false;
  fs.lstatSync = function(file, ...args) {
    const stat = original.call(fs, file, ...args);
    if (file === target && !replaced) {
      replaced = true; fs.renameSync(path.join(directory, 'images'), path.join(directory, 'images-original'));
      fs.symlinkSync(external, path.join(directory, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return stat;
  };
  try { await assert.rejects(f.raw.activateRawResourceDirectory(preview.token), /链接|联接|跳转/); }
  finally { fs.lstatSync = original; }
  assert.ok(replaced); assert.equal(f.content.getWord(3).translation, 'raw stable');
});

test('raw checkpointed WAL databases never gain SQLite sidecar files in the original directory', async t => {
  const f = setup(t), directory = author(f, 'wal');
  for (const relative of ['content.db', 'materials.db']) {
    const db = new Database(path.join(directory, relative)); db.pragma('journal_mode = WAL'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
    assert.equal(fs.existsSync(path.join(directory, relative + '-wal')), false); assert.equal(fs.existsSync(path.join(directory, relative + '-shm')), false);
  }
  const before = Object.fromEntries(['content.db','materials.db'].map(name => [name, hash(path.join(directory,name))]));
  await activate(f, directory); assert.equal(f.content.getWord(3).translation, 'raw wal');
  for (const relative of ['content.db', 'materials.db']) {
    assert.equal(fs.existsSync(path.join(directory, relative + '-wal')), false); assert.equal(fs.existsSync(path.join(directory, relative + '-shm')), false);
    assert.equal(hash(path.join(directory,relative)), before[relative]);
  }
});

test('raw selecting the legacy fallback itself remains read-only with checkpointed WAL databases', async t => {
  const f = setup(t), directory = author(f, 'fallback-wal');
  for (const relative of ['content.db', 'materials.db']) {
    const db = new Database(path.join(directory, relative)); db.pragma('journal_mode=WAL'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  }
  const context = loadMain(path.join(directory,'content.db'), f.progressPath, { bundledReadingPackagePath:null });
  try {
    const raw = context.load('resource-directory-config'), store = context.load('content-package-store');
    const preview = await raw.prepareRawResourceDirectory(directory); await raw.activateRawResourceDirectory(preview.token);
    assert.equal(context.load('content-db').getWord(3).translation,'raw fallback-wal');
    for (const relative of ['content.db','materials.db']) {
      assert.equal(fs.existsSync(path.join(directory,relative+'-wal')),false); assert.equal(fs.existsSync(path.join(directory,relative+'-shm')),false);
    }
    assert.equal(store.listContentPackages().some(item=>item.id==='legacy-base-resources'),false);
  } finally { context.close(); }
});

test('raw invalid or unregistered media requests do not disable a healthy directory', async t => {
  const f = setup(t); await activate(f, author(f,'request'));
  const revision=f.raw.getSelectedRawResourceRevision();
  assert.throws(()=>f.store.getManagedMediaPath('gwcontent/'+revision.digest+'/images/not-registered.png',false),/不属于/);
  assert.throws(()=>f.store.getManagedMediaPath('gwcontent/'+revision.digest+'/images/../content.db',false),/不属于/);
  assert.equal(f.raw.getRawResourceDirectoryStatus().status,'active'); assert.equal(f.content.getWord(3).translation,'raw request');
});

test('raw a changed fallback directory never replaces its pinned database during startup', async t => {
  const f=setup(t),directory=author(f,'fallback-change');
  let context=loadMain(path.join(directory,'content.db'),f.progressPath,{bundledReadingPackagePath:null});
  try{
    const raw=context.load('resource-directory-config'); await raw.activateRawResourceDirectory((await raw.prepareRawResourceDirectory(directory)).token); context.close();
    const db=new Database(path.join(directory,'content.db')); db.exec("UPDATE words SET lemma='reused-id',translation='unknown newer file' WHERE id=3"); db.close();
    context=loadMain(path.join(directory,'content.db'),f.progressPath,{bundledReadingPackagePath:null});
    await context.load('resource-directory-config').initializeResourceDirectory(); await context.load('content-package-store').initializeContentPackages();
    assert.equal(context.load('resource-directory-config').getRawResourceDirectoryStatus().status,'error');
    assert.equal(context.load('content-db').getWord(3).lemma,'sword'); assert.equal(context.load('content-db').getWord(3).translation,'raw fallback-change');
  }finally{context.close();}
});

test('raw oversized WAL validation fails before reading the database into memory', t => {
  const f = setup(t), directory = author(f, 'large-wal'), file = path.join(directory, 'content.db');
  const db = new Database(file); db.pragma('journal_mode=WAL'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  const readFile = fs.readFileSync, statFile = fs.statSync; let databaseRead = false;
  fs.statSync = function(target, ...args) {
    const stat = statFile.call(fs, target, ...args);
    if (target === file) stat.size = 256 * 1024 * 1024 + 1;
    return stat;
  };
  fs.readFileSync = function(target, ...args) {
    if (target === file) { databaseRead = true; throw Error('Oversized database must not be read'); }
    return readFile.call(fs, target, ...args);
  };
  try {
    assert.throws(() => f.context.load('content-package-db').openPackageDatabase(file), /256 MiB.*checkpoint.*DELETE/);
    assert.equal(databaseRead, false);
  } finally { fs.readFileSync = readFile; fs.statSync = statFile; }
});

test('raw relocated managed caches derive snapshot paths locally and preserve progress when selecting a new directory', async t => {
  const f=setup(t),source=author(f,'migration-old',db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','旧词')"));
  await activate(f,source); f.collect(1,'sword'); const collected=f.context.load('collections').getCollectedSource(3);
  f.progress.openProgressDb().prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(99,'test','2026-10-23');
  const config=f.raw.getResourceDirectoryConfigPath(); f.context.close();
  const migrated=path.join(f.directory,'migrated-user'),cache=path.join(migrated,'cache/content-packages'),progress=path.join(migrated,'profile/progress.db');
  fs.mkdirSync(path.dirname(cache),{recursive:true}); fs.mkdirSync(path.dirname(progress),{recursive:true});
  fs.renameSync(path.join(f.directory,'content-packages'),cache); fs.renameSync(config,path.join(path.dirname(cache),'resource-directory-raw.json')); fs.renameSync(f.progressPath,progress);
  const context=loadMain(f.contentPath,progress,{bundledReadingPackagePath:null,contentPackagesDir:cache});
  try{
    const raw=context.load('resource-directory-config'),store=context.load('content-package-store');
    await raw.initializeResourceDirectory(); await store.initializeContentPackages();
    assert.equal(raw.getRawResourceDirectoryStatus().status,'active'); assert.ok(store.getCurrentContentResourceFiles().content.startsWith(cache));
    const reused=author(f,'migration-reused',db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'different','复用')"));
    await assert.rejects(raw.prepareRawResourceDirectory(reused),/不能删除或复用/);
    const next=author(f,'migration-next',db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','新译')"));
    await raw.activateRawResourceDirectory((await raw.prepareRawResourceDirectory(next)).token);
    assert.equal(context.load('content-db').getWord(99).lemma,'preserved');
    assert.equal(context.load('progress-db').openProgressDb().prepare('SELECT COUNT(*) n FROM cards WHERE word_id=99').get().n,1);
    assert.deepEqual(context.load('collections').getCollectedSource(3),collected);
  }finally{context.close();}
});

for(const damage of ['missing','malformed']) test('raw '+damage+' revision metadata keeps readable historical databases available for safe reselection',async t=>{
  const f=setup(t),source=author(f,'metadata-old-'+damage,db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','旧词')"));
  await activate(f,source); const revision=f.raw.getSelectedRawResourceRevision();
  f.progress.openProgressDb().prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(99,'test','2026-10-23'); f.context.close();
  const metadata=path.join(revision.directory,'raw.json'); if(damage==='missing')fs.unlinkSync(metadata); else fs.writeFileSync(metadata,'{broken','utf8');
  const context=loadMain(f.contentPath,f.progressPath,{bundledReadingPackagePath:null});
  try{
    const raw=context.load('resource-directory-config'); await raw.initializeResourceDirectory(); assert.equal(raw.getRawResourceDirectoryStatus().status,'error');
    const reused=author(f,'metadata-reused-'+damage,db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'different','复用')"));
    await assert.rejects(raw.prepareRawResourceDirectory(reused),/不能删除或复用/);
    const next=author(f,'metadata-next-'+damage,db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','新译')"));
    await raw.activateRawResourceDirectory((await raw.prepareRawResourceDirectory(next)).token);
    assert.equal(raw.getRawResourceDirectoryStatus().status,'active');
    assert.equal(context.load('progress-db').openProgressDb().prepare('SELECT COUNT(*) n FROM cards WHERE word_id=99').get().n,1);
  }finally{context.close();}
});

test('raw missing registration and historical DBs request explicit backup restoration and recover without resetting progress',async t=>{
  const f=setup(t),source=author(f,'restore-required-old',db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','旧词')"));
  await activate(f,source); const revision=f.raw.getSelectedRawResourceRevision();
  f.progress.openProgressDb().prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(99,'test','2026-10-23'); f.context.close();
  for(const name of ['raw.json','content.db','materials.db'])fs.unlinkSync(path.join(revision.directory,name));
  const context=loadMain(f.contentPath,f.progressPath,{bundledReadingPackagePath:null});
  try{
    const raw=context.load('resource-directory-config'); await raw.initializeResourceDirectory();
    const next=author(f,'restore-required-next',db=>db.exec("INSERT INTO words(id,lemma,translation) VALUES(99,'preserved','新译')"));
    await assert.rejects(raw.prepareRawResourceDirectory(next),/恢复.*content\.db.*materials\.db/);
    assert.equal(context.load('progress-db').openProgressDb().prepare('SELECT COUNT(*) n FROM cards WHERE word_id=99').get().n,1);
    for(const name of ['content.db','materials.db'])fs.copyFileSync(path.join(source,name),path.join(revision.directory,name));
    await raw.activateRawResourceDirectory((await raw.prepareRawResourceDirectory(next)).token);
    assert.equal(raw.getRawResourceDirectoryStatus().status,'active');
    assert.equal(context.load('progress-db').openProgressDb().prepare('SELECT COUNT(*) n FROM cards WHERE word_id=99').get().n,1);
  }finally{context.close();}
});
