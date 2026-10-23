'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { loadContentPackageCore } = require('../scripts/content-package-loader.cjs');
const core = loadContentPackageCore();
const root = path.resolve(__dirname, '..');
const words = JSON.parse(fs.readFileSync(path.join(root, 'content-library/examples/local-word-book/data.json'), 'utf8'));
const materials = JSON.parse(fs.readFileSync(path.join(root, 'content-library/examples/noelle-evening/data.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function manifest(kind = 'words') { return { id: 'example.test.' + kind, name: '测试离线素材包', kind, version: '1.0.0', minAppVersion: '1.1.0', author: 'Tests', createdAt: '2026-10-23' }; }
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcontent-format-'));
  t.after(() => { const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), 'utf8'); }
function author(directory, kind = 'words', data = words) { const folder = path.join(directory, 'author'); fs.mkdirSync(folder); json(path.join(folder, 'manifest.json'), manifest(kind)); json(path.join(folder, 'data.json'), data); return folder; }
function binary(file, kind = 'words', files = { 'data.json': Buffer.from(JSON.stringify(words)) }, mutateHeader, pretty = false) {
  const entries = Object.entries(files).map(([path, body]) => ({ path, size: body.length, sha256: sha(body) }));
  const header = { format: 'genshinwords.content', formatVersion: 1, manifest: manifest(kind), entries };
  mutateHeader?.(header);
  const encoded = Buffer.from(JSON.stringify(header, null, pretty ? 2 : 0), 'utf8'), length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
  fs.writeFileSync(file, Buffer.concat([core.CONTENT_PACKAGE_MAGIC, length, encoded, ...Object.values(files)])); return header;
}
test('content format packs/extracts exact bytes with canonical header identity and independent lemma-only books', async t => {
  const directory = workspace(t), folder = author(directory), file = path.join(directory, 'words.gwwords');
  const packed = await core.packContentDirectory(folder, file), inspected = await core.inspectContentPackage(file, { appVersion: '1.1.0' });
  assert.equal(packed.digest, inspected.digest); assert.deepEqual(inspected.data, words);
  assert.equal(inspected.header.entries.length, 1); assert.equal(inspected.offsets['data.json'].size, fs.statSync(path.join(folder, 'data.json')).size);
  const output = path.join(directory, 'revision'); await core.extractContentPackage(file, output);
  assert.deepEqual(fs.readFileSync(path.join(output, 'data.json')), fs.readFileSync(path.join(folder, 'data.json')));
  const pretty = path.join(directory, 'pretty.gwwords'); binary(pretty, 'words', { 'data.json': fs.readFileSync(path.join(folder, 'data.json')) }, undefined, true);
  assert.equal((await core.inspectContentPackage(pretty)).digest, packed.digest);
});
test('content format rejects corruption, trailing data, truncation and excessive header lengths', async t => {
  const directory = workspace(t), file = path.join(directory, 'words.gwwords'); binary(file);
  const original = fs.readFileSync(file), corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  fs.writeFileSync(file, corrupt); await assert.rejects(core.inspectContentPackage(file), /SHA-256/);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from('extra')])); await assert.rejects(core.inspectContentPackage(file), /总长度/);
  fs.writeFileSync(file, original.subarray(0, original.length - 1)); await assert.rejects(core.inspectContentPackage(file), /总长度/);
  const huge = Buffer.from(original); huge.writeUInt32BE(0xffffffff, core.CONTENT_PACKAGE_MAGIC.length); fs.writeFileSync(file, huge); await assert.rejects(core.inspectContentPackage(file), /头部长度/);
});
test('content author pack creates missing output parents outside the read-only source tree', async t => {
  const directory = workspace(t), folder = author(directory), file = path.join(directory, 'new/output/subfolder/book.gwwords');
  const packed = await core.packContentDirectory(folder, file);
  assert.equal(fs.existsSync(file), true); assert.equal((await core.inspectContentPackage(file)).digest, packed.digest);
});
test('content author pack refuses an output within its own source before creating directories', async t => {
  const directory = workspace(t), folder = author(directory), file = path.join(folder, 'new/subfolder/book.gwwords');
  await assert.rejects(core.packContentDirectory(folder, file), /作者目录内/);
  assert.equal(fs.existsSync(path.join(folder, 'new')), false);
  await assert.rejects(core.packContentDirectory(folder, path.join(folder, '..author-output/book.gwwords')), /作者目录内/);
  assert.equal(fs.existsSync(path.join(folder, '..author-output')), false);
});
test('content format validates app and format versions, finite sizes and data-only entry types before extraction', async t => {
  const directory = workspace(t), file = path.join(directory, 'words.gwwords'); binary(file);
  await assert.rejects(core.inspectContentPackage(file, { appVersion: '1.0.0' }), /程序版本/);
  for (const change of [header => header.formatVersion = 2, header => header.entries[0].size = -1, header => header.entries[0].size = Number.MAX_SAFE_INTEGER, header => header.entries[0].path = 'progress.db', header => header.entries[0].path = 'evil.js', header => header.manifest.version = '01.0.0']) {
    binary(file, 'words', undefined, change); await assert.rejects(core.inspectContentPackage(file));
  }
});
test('content manifest preserves safe underscores in existing official word-book package IDs', () => {
  for (const bookId of ['sh_gaokao', 'sh_zhongkao']) {
    const input = { ...manifest(), id: 'genshinwords.words.' + bookId };
    assert.equal(core.validateContentPackageManifest(input).id, input.id);
  }
  assert.throws(() => core.validateContentPackageManifest({ ...manifest(), id: 'genshinwords.words/escape' }));
});
test('content format rejects path traversal, drive/UNC paths, device names and case aliases', async t => {
  const directory = workspace(t), file = path.join(directory, 'bad.gwcontent');
  for (const name of ['../escape.png', '/absolute.png', 'C:/escape.png', 'images\\escape.png', 'images/CON.png', 'images/dir./picture.png', '//server/picture.png', 'images/%2e%2e/x.png']) {
    binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(materials)) }, header => header.entries[0].path = name);
    await assert.rejects(core.inspectContentPackage(file), /路径|设备名|资源类型/);
  }
  binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(materials)), 'images/A.png': Buffer.from('a'), 'images/a.png': Buffer.from('a') });
  await assert.rejects(core.inspectContentPackage(file), /重复/);
});
test('content format rejects foreign word definitions, duplicate lemma references and reserved book IDs', () => {
  for (const change of [data => data.books[0].definitions = [{ lemma: 'new', translation: '外部词条' }], data => data.books[0].lemmas.push('PURSUIT'), data => data.books[0].id = 'constructor', data => data.books[0].lemmas[0] = '<script>code</script>']) {
    const data = structuredClone(words); change(data); assert.throws(() => core.validateWordPackageData(data));
  }
});
test('content material schema keeps IDs unique and requires bilingual text and safe provenance', () => {
  const good = core.validateMaterialPackageData(materials); assert.deepEqual(good, materials);
  const duplicate = structuredClone(materials); duplicate.chapters[0].quests[0].lines.push({ ...duplicate.chapters[0].quests[0].lines[0] }); assert.throws(() => core.validateMaterialPackageData(duplicate), /重复/);
  const unsafe = structuredClone(materials); unsafe.chapters[0].sourceUrl = 'javascript:alert(1)'; assert.throws(() => core.validateMaterialPackageData(unsafe), /HTTP/);
  const untranslated = structuredClone(materials); untranslated.chapters[0].quests[0].lines[0].text_chs = ''; assert.throws(() => core.validateMaterialPackageData(untranslated), /文字/);
});
test('content extraction rolls back its new staging directory after corruption and never touches an existing destination', async t => {
  const directory = workspace(t), file = path.join(directory, 'bad.gwcontent'), destination = path.join(directory, 'revision');
  binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(materials)), 'images/art.png': Buffer.from('not an image') });
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  json(path.join(directory, 'sibling.json'), { keep: true });
  await assert.rejects(core.extractContentPackage(file, destination), /SHA-256/); assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'sibling.json'), 'utf8')), { keep: true });
  fs.mkdirSync(destination); json(path.join(destination, 'keep.json'), { keep: true });
  await assert.rejects(core.extractContentPackage(file, destination), /EEXIST/); assert.equal(fs.existsSync(path.join(destination, 'keep.json')), true);
});
test('content materials reject missing cover resources and invalid pixels even when their hashes match', async t => {
  const directory = workspace(t), file = path.join(directory, 'materials.gwcontent'), data = structuredClone(materials); data.chapters[0].coverPath = 'images/art.png';
  binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(data)) }); await assert.rejects(core.inspectContentPackage(file), /题图资源/);
  binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(data)), 'images/art.png': Buffer.from('not real PNG pixels') }); await assert.rejects(core.inspectContentPackage(file));
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#aaccdd' } }).png().toBuffer();
  binary(file, 'materials', { 'data.json': Buffer.from(JSON.stringify(data)), 'images/art.png': png }); assert.equal((await core.inspectContentPackage(file)).data.chapters.length, 1);
});
test('base CLI packs read-only loose sources using an external manifest and skips author/development-only material', async t => {
  const directory = workspace(t), source = path.join(directory, 'source'); fs.mkdirSync(source);
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1024 * 1024)]); fs.writeFileSync(path.join(source, 'content.db'), sqlite); fs.writeFileSync(path.join(source, 'materials.db'), sqlite);
  fs.writeFileSync(path.join(source, 'material_matches.db'), 'must not enter release'); json(path.join(source, 'material_match_report.json'), { development: true });
  json(path.join(source, 'reading/private-author.json'), { notBase: true }); json(path.join(source, 'word-books/data.json'), words);
  const external = path.join(directory, 'external-manifest.json'); json(external, manifest('base'));
  const file = path.join(directory, 'base.gwcontent'), packed = await core.packContentDirectory(source, file, { manifestPath: external });
  assert.deepEqual(packed.header.entries.map(entry => entry.path), ['content.db', 'materials.db']);
  assert.deepEqual(fs.readFileSync(path.join(source, 'content.db')), sqlite); assert.equal(fs.existsSync(path.join(source, 'manifest.json')), false);
});
test('base CLI fails explicitly when media exist only in an unchecked ASAR', async t => {
  const directory = workspace(t), source = path.join(directory, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'content.db'), Buffer.from('SQLite format 3\0')); fs.writeFileSync(path.join(source, 'assets.asar'), Buffer.from('opaque'));
  const external = path.join(directory, 'base-manifest.json'); json(external, manifest('base'));
  await assert.rejects(core.packContentDirectory(source, path.join(directory, 'base.gwcontent'), { manifestPath: external }), /ASAR/);
});
test('content author pack refuses a symbolic-link source and publishes no partial output', async t => {
  const directory = workspace(t), folder = author(directory), file = path.join(directory, 'book.gwwords'), original = fsp.lstat;
  t.mock.method(fsp, 'lstat', async name => { const stat = await original(name); return path.resolve(name) === path.join(folder, 'data.json') ? new Proxy(stat, { get(target, key) { return key === 'isSymbolicLink' ? () => true : Reflect.get(target, key); } }) : stat; });
  await assert.rejects(core.packContentDirectory(folder, file), /符号链接/); assert.equal(fs.existsSync(file), false);
});

test('base content accepts legacy WAV/Ogg audio with .mp3 names but rejects non-audio bytes', async t => {
  const directory = workspace(t), file = path.join(directory, 'legacy.gwcontent');
  const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]);
  const wave = Buffer.alloc(64); wave.write('RIFF', 0, 'ascii'); wave.writeUInt32LE(56, 4); wave.write('WAVEfmt ', 8, 'ascii'); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36, 'ascii'); wave.writeUInt32LE(20, 40);
  binary(file, 'base', { 'content.db': db, 'materials.db': db, 'audio/words/legacy.mp3': wave });
  assert.equal((await core.inspectContentPackage(file)).header.manifest.kind, 'base');
  binary(file, 'base', { 'content.db': db, 'materials.db': db, 'audio/words/legacy.mp3': Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]) });
  assert.equal((await core.inspectContentPackage(file)).header.manifest.kind, 'base');
  binary(file, 'base', { 'content.db': db, 'materials.db': db, 'audio/words/legacy.mp3': Buffer.from('<html>not audio</html>') });
  await assert.rejects(core.inspectContentPackage(file), /无效MP3/);
});
