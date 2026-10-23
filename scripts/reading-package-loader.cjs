'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

/** Transpile only trusted application source, never any file in an authoring folder. */
function loadReadingPackageCore() {
  const modules = new Map();
  function load(filename) {
    filename = path.resolve(filename.endsWith('.ts') ? filename : filename + '.ts');
    const relative = path.relative(path.join(root, 'src'), filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Author CLI cannot execute files outside trusted src/');
    if (modules.has(filename)) return modules.get(filename).exports;
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} }; modules.set(filename, mod);
    function localRequire(name) {
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
      if (!name.startsWith('node:')) throw Error('Author CLI dependency is not a Node builtin: ' + name);
      return require(name);
    }
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(mod.exports, localRequire, mod, filename, path.dirname(filename));
    return mod.exports;
  }
  return load(path.join(root, 'src/main/reading-package-format.ts'));
}
module.exports = { loadReadingPackageCore };
