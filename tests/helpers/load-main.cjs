const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const compiled = new Map();

// Actual main-process code with isolated paths. No fixture touches the user's profile.
function loadMain(contentPath, progressPath = ':memory:', options = {}) {
  const modules = new Map();
  const memoryDirectory = progressPath === ':memory:' && !options.readingPackagesDir
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'gwreading-test-')) : null;
  const packageDirectory = options.readingPackagesDir || path.join(memoryDirectory || path.dirname(progressPath), 'reading-packages');
  const bundledPackage = Object.prototype.hasOwnProperty.call(options, 'bundledReadingPackagePath')
    ? options.bundledReadingPackagePath
    : (fs.existsSync(path.join(path.dirname(contentPath), 'reading/base.gwreading'))
      ? path.join(path.dirname(contentPath), 'reading/base.gwreading')
      : path.join(root, 'content/reading/base.gwreading'));
  function load(filename) {
    filename = path.resolve(root, 'src/main', filename);
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (filename.endsWith('.cjs') || filename.endsWith('.js')) return require(filename);
    if (!filename.endsWith('.ts')) filename += '.ts';
    if (modules.has(filename)) return modules.get(filename).exports;
    let code = compiled.get(filename);
    if (!code) {
      code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule:true },
      }).outputText;
      compiled.set(filename, code);
    }
    const mod = { exports: {} };
    modules.set(filename, mod);
    const resolve = name => {
      if (name === './paths') {
        const directory = path.dirname(contentPath);
        const media = fs.existsSync(path.join(directory, 'assets.asar')) ? path.join(directory, 'assets.asar') : directory;
        function asset(base, file) {
          const target = path.resolve(base, file);
          const relative = path.relative(base, target);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Invalid fixture asset path');
          return target;
        }
        function image(file) {
          if (file.startsWith('gwcontent/')) { const resolved = load('content-package-store').getManagedMediaPath(file, false); if (!resolved) throw Error('Invalid fixture managed image path'); return resolved; }
          const match = /^gwreading\/([a-f0-9]{64})\/([a-f0-9]{64}\.(?:webp|png|jpe?g))$/.exec(file);
          if (match) return asset(path.join(packageDirectory,'assets',match[1]),match[2]);
          if (file.startsWith('gwreading/')) throw Error('Invalid fixture reading image path');
          return asset(path.join(media, 'images'), file);
        }
        return { getContentDbPath: () => contentPath, getProgressDbPath: () => progressPath,
          getContentDir:()=>directory, getBundledContentDir:()=>directory, getMediaDir:()=>media,
          getContentPackagesDir:()=>options.contentPackagesDir || path.join(memoryDirectory || path.dirname(progressPath), 'content-packages'),
          getReadingPackagesDir:()=>packageDirectory, getBundledReadingPackagePath:()=>bundledPackage,
          getImagePath: image, getAudioPath: file => { if (file.startsWith('gwcontent/')) { const resolved = load('content-package-store').getManagedMediaPath(file, true); if (!resolved) throw Error('Invalid fixture managed audio path'); return resolved; } return asset(media, file); }, containedPath:asset };
      }
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
      return require(name);
    };
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
      mod.exports, resolve, mod, filename, path.dirname(filename));
    return mod.exports;
  }
  return {
    load, readingPackagesDir:packageDirectory,
    close() {
      for (const [filename, mod] of modules) {
        if (filename.endsWith('content-db.ts')) mod.exports.closeContentDb();
        if (filename.endsWith('progress-db.ts')) mod.exports.closeProgressDb();
      }
      if(memoryDirectory){
        const resolved=path.resolve(memoryDirectory), temporaryRoot=path.resolve(os.tmpdir());
        if(path.dirname(resolved)!==temporaryRoot||!path.basename(resolved).startsWith('gwreading-test-'))throw Error('Unsafe fixture cleanup path');
        fs.rmSync(resolved,{recursive:true,force:true});
      }
    },
  };
}
module.exports = { loadMain, root };
