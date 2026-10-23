#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { loadContentPackageCore } = require('./content-package-loader.cjs');
function summary(result) {
  const data = result.data;
  return { id: result.header.manifest.id, kind: result.header.manifest.kind, version: result.header.manifest.version,
    digest: result.digest, files: result.header.entries.length, bytes: result.totalSize,
    ...(data?.books ? { books: data.books.length, words: data.books.reduce((sum, book) => sum + book.lemmas.length, 0) } : {}),
    ...(data?.chapters ? { chapters: data.chapters.length } : {}) };
}
async function main(args) {
  const core = loadContentPackageCore(), [command, input, ...rest] = args.filter(arg => arg !== '--');
  if (command === 'validate' && input && !rest.length) {
    process.stdout.write(JSON.stringify(summary(await core.inspectContentPackage(path.resolve(input))), null, 2) + '\n'); return;
  }
  if (command === 'pack' && input) {
    let out, manifestPath;
    for (let index = 0; index < rest.length; index += 2) {
      if (!rest[index + 1] || !['--out', '--manifest'].includes(rest[index])) throw Error('pack accepts --out <file> and optional --manifest <external.json>');
      if (rest[index] === '--out') { if (out) throw Error('Duplicate --out'); out = rest[index + 1]; }
      else { if (manifestPath) throw Error('Duplicate --manifest'); manifestPath = rest[index + 1]; }
    }
    if (!out) throw Error('pack requires --out <file.gwcontent|file.gwwords>');
    const result = await core.packContentDirectory(path.resolve(input), path.resolve(out), manifestPath ? { manifestPath: path.resolve(manifestPath) } : {});
    process.stdout.write(JSON.stringify({ ...summary(result), output: path.resolve(out) }, null, 2) + '\n'); return;
  }
  throw Error('Usage: node scripts/content-package.cjs validate <package> | pack <authorDir> --out <package> [--manifest <external.json>]');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
module.exports = { summary };
