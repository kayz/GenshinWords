const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');

function handoff(file, selected, nativeIni = false) {
  const ini = `${nativeIni ? '\r\n' : ''}[Base]\r\nPath=${selected}\r\n`;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ini, 'utf16le')]));
}

async function makeBase(f, name = 'base.gwcontent', kind = 'base') {
  const author = path.join(f.directory, `author-${name}`);
  fs.mkdirSync(author);
  fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify({
    id: kind === 'base' ? 'local.installer.base' : 'local.installer.materials',
    name: 'Fixture base', kind, version: '1.0.0', minAppVersion: '1.1.0',
    author: 'Fixture', createdAt: '2026-10-23T00:00:00.000Z',
  }), 'utf8');
  if (kind === 'base') {
    fs.copyFileSync(f.contentPath, path.join(author, 'content.db'));
    const clean = new Database(path.join(author, 'content.db'));
    clean.exec('UPDATE words SET audio_uk=NULL,audio_us=NULL'); clean.close();
    const materials = new Database(path.join(author, 'materials.db'));
    materials.exec('CREATE TABLE materials(id TEXT PRIMARY KEY); CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT)');
    materials.close();
  } else {
    fs.writeFileSync(path.join(author, 'data.json'), JSON.stringify({ chapters: [{
      id: 'chapter', title_en: 'Fixture', title_chs: '测试', type: 'quest', version: '1',
      sourceUrl: 'https://example.test/source', quests: [{ id: 'quest', title_en: 'Quest', title_chs: '任务',
        lines: [{ id: 'line', speaker: 'Paimon', text_en: 'A sword is here.', text_chs: '剑在这里。' }] }],
    }] }), 'utf8');
  }
  const output = path.join(f.directory, name);
  await f.context.load('content-package-format').packContentDirectory(author, output);
  return output;
}

test('installer selection loads an offline base package into the active cache and preserves progress', async t => {
  const f = fixture(t, { bundledReadingPackagePath: null });
  const store = f.context.load('content-package-store');
  const installer = f.context.load('installer-base');
  await store.initializeContentPackages();
  f.progress.openProgressDb().prepare('INSERT INTO cards(word_id,book_id,due) VALUES(?,?,?)').run(3, 'test', '2026-10-23');
  const packageFile = await makeBase(f, '提瓦特-base.gwcontent');
  const marker = path.join(f.directory, 'installer-base-selection.ini');
  handoff(marker, packageFile, true);
  assert.equal(installer.readInstallerBaseSelection(), packageFile);
  await installer.installSelectedBasePackage(packageFile);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(store.listContentPackages().find(item => item.id === 'local.installer.base').status, 'active');
  assert.equal(f.progress.openProgressDb().prepare('SELECT COUNT(*) AS count FROM cards').get().count, 1);
  handoff(marker, packageFile);
  await installer.installSelectedBasePackage(packageFile);
  assert.equal(fs.existsSync(marker), false, 'Reinstalling the same package should complete cleanly');
});

test('installer rejects wrong kinds, damaged files and malformed handoff without replacing the active base', async t => {
  const f = fixture(t, { bundledReadingPackagePath: null });
  const store = f.context.load('content-package-store');
  const installer = f.context.load('installer-base');
  await store.initializeContentPackages();
  const good = await makeBase(f);
  await installer.installSelectedBasePackage(good);
  const current = store.listContentPackages().find(item => item.id === 'local.installer.base');
  const marker = path.join(f.directory, 'installer-base-selection.ini');
  const wrong = await makeBase(f, 'materials.gwcontent', 'materials');
  handoff(marker, wrong);
  await assert.rejects(installer.installSelectedBasePackage(wrong), /不是完整基础素材包/);
  assert.equal(fs.existsSync(marker), true);
  const damaged = path.join(f.directory, 'damaged.gwcontent');
  fs.writeFileSync(damaged, 'GWCONTENT1\n');
  await assert.rejects(installer.installSelectedBasePackage(damaged));
  assert.equal(store.listContentPackages().find(item => item.id === current.id).status, 'active');
  fs.writeFileSync(marker, 'not a UTF-16 installer selection', 'utf8');
  assert.throws(() => installer.readInstallerBaseSelection(), /编码无效/);
});
