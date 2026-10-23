'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const { loadReadingPackageCore } = require('../scripts/reading-package-loader.cjs');
const { readAuthoringDirectory } = require('../scripts/reading-package.cjs');
const sample = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'reading-library/examples/shared-question.gwreading'))));
const core = loadReadingPackageCore();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function withImage(bytes, mimeType) {
  const data = structuredClone(sample), extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mimeType];
  const name = 'test/art.' + extension;
  data.units[0].definition.coverPath = name;
  data.images = [{ ...data.images[0], path: name, mimeType, sha256: digest(bytes), dataBase64: bytes.toString('base64') }];
  return data;
}
async function tiny(format) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#c43a27' } })[format]().toBuffer();
}
test('reading format rejects PNG compressed pixels even after SHA and chunk CRC are recomputed', async () => {
  const bytes = await tiny('png');
  core.validateReadingPackage(withImage(bytes, 'image/png'));
  let bad = Buffer.from(bytes);
  for (let offset = 8; offset < bad.length;) {
    const size = bad.readUInt32BE(offset), end = offset + size + 12;
    if (bad.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      bad.fill(0, offset + 8, end - 4);
      bad.writeUInt32BE(crc32(bad.subarray(offset + 4, end - 4)), end - 4);
    }
    offset = end;
  }
  assert.throws(() => core.validateReadingPackage(withImage(bad, 'image/png')), /图片像素流无法完整解码/);
});
test('reading format rejects JPEG compressed-table corruption with a recomputed SHA', async () => {
  const bytes = await tiny('jpeg');
  core.validateReadingPackage(withImage(bytes, 'image/jpeg'));
  const bad = Buffer.from(bytes);
  for (let offset = 2; offset + 4 < bad.length;) {
    assert.equal(bad[offset++], 255);
    while (bad[offset] === 255) offset++;
    const marker = bad[offset++], size = bad.readUInt16BE(offset);
    if (marker === 0xc4) { bad[offset + 2] = 255; break; }
    offset += size;
  }
  assert.throws(() => core.validateReadingPackage(withImage(bad, 'image/jpeg')), /图片像素流无法完整解码/);
});
test('reading format rejects WebP entropy corruption with a recomputed SHA', async () => {
  const bytes = await tiny('webp');
  core.validateReadingPackage(withImage(bytes, 'image/webp'));
  let bad = Buffer.from(bytes);
  for (let offset = 12; offset < bad.length;) {
    const size = bad.readUInt32LE(offset + 4), kind = bad.toString('ascii', offset, offset + 4);
    if (kind === 'VP8 ') {
      bad = Buffer.concat([bad.subarray(0, offset + 18)]);
      bad.writeUInt32LE(10, offset + 4);
      bad.writeUInt32LE(bad.length - 8, 4);
      break;
    }
    offset += 8 + size + size % 2;
  }
  assert.throws(() => core.validateReadingPackage(withImage(bad, 'image/webp')), /图片像素流无法完整解码/);
});
test('reading format image validation cache is safe across separate trusted TS loaders', async () => {
  const data = withImage(await tiny('png'), 'image/png');
  const first = core.validateReadingPackage(data);
  const second = loadReadingPackageCore().validateReadingPackage(data);
  assert.equal(first.digest, second.digest);
  const corrupt = structuredClone(data); corrupt.images[0].dataBase64 = Buffer.from('wrong bytes').toString('base64');
  assert.throws(() => loadReadingPackageCore().validateReadingPackage(corrupt), /SHA-256/);
});
test('reading format question identity excludes explanations, translations, hints and artwork corrections', () => {
  const baseline = core.validateReadingPackage(sample), corrected = structuredClone(sample);
  const definition = corrected.units[0].definition, source = corrected.sources[0];
  definition.questions[0].solution.explanation += ' 解析校正。';
  definition.questions[0].hint += ' 提示校正。';
  const original = source.chs.paragraphs[0];
  source.chs.paragraphs[0] += '（译文校正）';
  source.chs.text = source.chs.text.replace(original, source.chs.paragraphs[0]);
  source.chs.sha256 = digest(source.chs.text);
  definition.chsTextSha256 = source.chs.sha256;
  corrected.images[0].sourceTitle += ' · 来源校正';
  const updated = core.validateReadingPackage(corrected);
  assert.deepEqual(updated.questionFingerprints, baseline.questionFingerprints);
  assert.notEqual(updated.unitFingerprints[definition.id], baseline.unitFingerprints[definition.id]);
});
test('reading format matching question identity binds the original paragraphs represented by its option labels', () => {
  const base = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'content/reading/base.gwreading'))));
  const record = base.units.find(unit => unit.kind === 'passage' && unit.definition.type === 'matching');
  const data = { ...base, units: [{ kind: 'passage', definition: record.definition }], legacyGroups: [],
    sources: base.sources.filter(source => source.id === record.definition.materialId),
    images: base.images.filter(image => image.path === record.definition.coverPath) };
  const initial = core.validateReadingPackage(data), revised = structuredClone(data);
  const labels = revised.units[0].definition.paragraphLabels;
  [labels[0].paragraphs, labels[1].paragraphs] = [labels[1].paragraphs, labels[0].paragraphs];
  const updated = core.validateReadingPackage(revised), qid = record.definition.questions[0].id;
  assert.notEqual(updated.questionFingerprints[qid], initial.questionFingerprints[qid]);
});
function temporaryAuthor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gwreading-format-'));
  const author = path.join(directory, 'author');
  fs.cpSync(path.join(root, 'reading-library/examples/shared-question'), author, { recursive: true });
  t.after(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, author };
}
function directoryLink(t, target, link) {
  try { fs.symlinkSync(target, link, 'junction'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('OS sandbox denies junction creation; exercising the realpath boundary with a resolved-link fixture');
    const resolve = fs.realpathSync;
    t.mock.method(fs, 'realpathSync', file => {
      const name = path.resolve(file);
      return name === link || name.startsWith(link + path.sep) ? path.join(target, path.relative(link, name)) : resolve(file);
    });
  }
}
test('reading author CLI rejects an assets junction escaping its authoring root', t => {
  const { directory, author } = temporaryAuthor(t), outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  const imageRecords = JSON.parse(fs.readFileSync(path.join(author, 'images.json'), 'utf8'));
  fs.copyFileSync(path.join(author, imageRecords[0].file), path.join(outside, 'copy.png'));
  directoryLink(t, outside, path.join(author, 'assets/link'));
  imageRecords[0].file = 'assets/link/copy.png';
  fs.writeFileSync(path.join(author, 'images.json'), JSON.stringify(imageRecords), 'utf8');
  assert.throws(() => readAuthoringDirectory(author), /escapes its folder/);
});
test('reading author CLI rejects an assets junction into another authoring subfolder', t => {
  const { author } = temporaryAuthor(t), other = path.join(author, 'other');
  fs.mkdirSync(other);
  const imageRecords = JSON.parse(fs.readFileSync(path.join(author, 'images.json'), 'utf8'));
  fs.copyFileSync(path.join(author, imageRecords[0].file), path.join(other, 'copy.png'));
  directoryLink(t, other, path.join(author, 'assets/link'));
  imageRecords[0].file = 'assets/link/copy.png';
  fs.writeFileSync(path.join(author, 'images.json'), JSON.stringify(imageRecords), 'utf8');
  assert.throws(() => readAuthoringDirectory(author), /escapes assets/);
});
