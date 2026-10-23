'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sourceRoot = path.resolve(__dirname, '../src');
/** Execute trusted application TypeScript only; author folders contain JSON and bytes. */
function loadContentPackageCore() {
  const loaded = new Map();
  function load(filename) {
    filename = path.resolve(filename.endsWith('.ts') ? filename : filename + '.ts');
    const relative = path.relative(sourceRoot, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Content CLI cannot execute author-provided code');
    if (loaded.has(filename)) return loaded.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} }; loaded.set(filename, mod);
    function trustedRequire(name) {
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
      if (name.startsWith('node:') || name === 'sharp') return require(name);
      throw Error('Unapproved content author CLI dependency: ' + name);
    }
    new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(mod.exports, trustedRequire, mod, filename, path.dirname(filename));
    return mod.exports;
  }
  return load(path.join(sourceRoot, 'main/content-package-format.ts'));
}
module.exports = { loadContentPackageCore };
