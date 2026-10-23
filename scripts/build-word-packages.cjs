const fs = require('node:fs/promises');
const path = require('node:path');
const { loadContentPackageCore } = require('./content-package-loader.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const format = loadContentPackageCore();
  const source = path.join(root, 'content-library/word-books');
  const target = path.join(root, 'content/word-books');
  const directories = (await fs.readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name));
  if (!directories.length) throw Error('词书作者目录为空');
  await fs.mkdir(target, { recursive: true });
  const packages = [];
  for (const directory of directories) {
    const result = await format.packContentDirectory(path.join(source, directory.name), path.join(target, directory.name + '.gwwords'));
    packages.push({ id: result.header.manifest.id, version: result.header.manifest.version, books: result.data.books.length, words: result.data.books.reduce((sum, book) => sum + book.lemmas.length, 0) });
  }
  console.log(JSON.stringify({ packages }, null, 2));
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
