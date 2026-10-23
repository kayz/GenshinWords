#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadReadingPackageCore } = require('./reading-package-loader.cjs');
const core = loadReadingPackageCore();

function readFileLimited(file, maximum) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor); if (!stat.isFile() || stat.size > maximum) throw Error('File missing or too large: ' + file);
    const chunks = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const length = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length; if (total > maximum) throw Error('File grew beyond its size limit: ' + file);
      chunks.push(chunk.subarray(0, length));
    }
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(descriptor); }
}
function readJson(file, budget) {
  const bytes = readFileLimited(file, 8 * 1024 * 1024);
  budget.used += bytes.length;
  if (budget.used > core.READING_PACKAGE_LIMITS.decompressedBytes) throw Error('Author JSON data exceeds the total package size limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function childFile(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes(':') || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe author asset path: ' + file);
  const target = fs.realpathSync(path.resolve(root, file)), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Author asset escapes its folder: ' + file);
  return target;
}
function jsonFiles(folder, name, required, maximum, budget) {
  const target = path.join(folder, name);
  if (!fs.existsSync(target)) { if (required) throw Error('Missing author folder: ' + name); return []; }
  const files = fs.readdirSync(target, { withFileTypes: true });
  if (files.length > maximum) throw Error('Too many files in ' + name);
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en')).map(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw Error('Only direct .json data files are allowed in ' + name + ': ' + entry.name);
    return readJson(childFile(folder, name + '/' + entry.name), budget);
  });
}
function readAuthoringDirectory(directory) {
  const folder = fs.realpathSync(directory), budget = { used: 0 }, manifest = readJson(childFile(folder, 'manifest.json'), budget);
  const units = jsonFiles(folder, 'units', true, core.READING_PACKAGE_LIMITS.units, budget);
  const sources = jsonFiles(folder, 'sources', true, core.READING_PACKAGE_LIMITS.sources, budget);
  const legacyPath = path.join(folder, 'legacy-groups.json');
  const legacyGroups = fs.existsSync(legacyPath) ? readJson(childFile(folder, 'legacy-groups.json'), budget) : [];
  const records = readJson(childFile(folder, 'images.json'), budget);
  if (!Array.isArray(records) || records.length > core.READING_PACKAGE_LIMITS.images) throw Error('images.json must be a bounded array');
  let total = 0;
  const images = records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => !['path', 'file', 'mimeType', 'sha256', 'sourceTitle', 'sourceUrl'].includes(key))) throw Error('Invalid image metadata at ' + index);
    core.validateReadingPackagePath(record.path);
    if (typeof record.file !== 'string' || !record.file.startsWith('assets/')) throw Error('Image file must be inside assets/');
    const actual = childFile(folder, record.file), assetRoot = fs.realpathSync(path.join(folder, 'assets'));
    const relativeAsset = path.relative(assetRoot, actual);
    if (!relativeAsset || relativeAsset.startsWith('..') || path.isAbsolute(relativeAsset)) throw Error('Image file escapes assets/: ' + record.file);
    const bytes = readFileLimited(actual, core.READING_PACKAGE_LIMITS.imageBytes);
    total += bytes.length; if (total > core.READING_PACKAGE_LIMITS.totalImageBytes) throw Error('Image assets exceed total size limit');
    budget.used += Math.ceil(bytes.length / 3) * 4;
    if (budget.used > core.READING_PACKAGE_LIMITS.decompressedBytes) throw Error('Author data and embedded images exceed the total package size limit');
    const { file: _file, ...image } = record;
    return { ...image, dataBase64: bytes.toString('base64') };
  });
  return { format: 'genshinwords.reading', formatVersion: 1, manifest, units, legacyGroups, sources, images };
}
function summary(valid) {
  return { id: valid.data.manifest.id, version: valid.data.manifest.version, digest: valid.digest,
    units: valid.units.length, questions: valid.units.reduce((sum, unit) => sum + unit.questions.length, 0),
    legacyGroups: valid.legacyUnits.length, sources: valid.data.sources.length, images: valid.data.images.length };
}
function main(args) {
  const [command, input, ...rest] = args.filter(arg => arg !== '--');
  if (!['validate', 'pack'].includes(command) || !input) throw Error('Usage: node scripts/reading-package.cjs validate <folder|pack.gwreading> | pack <folder> --out <file.gwreading>');
  const isDirectory = fs.statSync(input).isDirectory();
  if (command === 'pack' && !isDirectory) throw Error('pack requires an authoring directory');
  const valid = isDirectory ? core.validateReadingPackage(readAuthoringDirectory(input)) : core.decodeReadingPackage(readFileLimited(input, core.READING_PACKAGE_LIMITS.compressedBytes));
  if (command === 'pack') {
    if (rest.length !== 2 || rest[0] !== '--out' || !rest[1].endsWith('.gwreading')) throw Error('pack requires --out <file.gwreading>');
    const output = path.resolve(rest[1]); fs.mkdirSync(path.dirname(output), { recursive: true });
    const bytes = core.encodeReadingPackage(valid.data);
    fs.writeFileSync(output, bytes, { flag: 'w' });
    process.stdout.write(JSON.stringify({ ...summary(valid), output, bytes: bytes.length }, null, 2) + '\n');
  } else {
    if (rest.length) throw Error('Unknown validate arguments');
    process.stdout.write(JSON.stringify(summary(valid), null, 2) + '\n');
  }
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; } }
module.exports = { readAuthoringDirectory, summary };
