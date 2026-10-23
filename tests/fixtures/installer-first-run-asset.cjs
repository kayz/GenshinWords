// Generate a small, entirely synthetic base package for isolated installer checks.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('../helpers/practice-fixture.cjs');

async function create(output) {
  const callbacks = [];
  const f = fixture({ after(callback) { callbacks.push(callback); } }, { bundledReadingPackagePath: null });
  const author = path.join(f.directory, 'author');
  fs.mkdirSync(author);
  fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify({
    id: 'synthetic.installer.base', name: 'Isolated installer fixture', kind: 'base', version: '1.0.0',
    minAppVersion: '1.1.0', author: 'GenshinWords tests', createdAt: '2026-10-23T00:00:00.000Z',
  }), 'utf8');
  fs.copyFileSync(f.contentPath, path.join(author, 'content.db'));
  const words = new Database(path.join(author, 'content.db'));
  words.exec('UPDATE words SET audio_uk=NULL,audio_us=NULL'); words.close();
  const materials = new Database(path.join(author, 'materials.db'));
  materials.exec('CREATE TABLE materials(id TEXT PRIMARY KEY); CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT)');
  materials.close();
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const packed = await f.context.load('content-package-format').packContentDirectory(author, output);
    process.stdout.write(JSON.stringify({ file: output, kind: packed.header.manifest.kind, bytes: packed.totalSize }) + '\n');
  } finally {
    for (const callback of callbacks.reverse()) callback();
  }
}

create(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
