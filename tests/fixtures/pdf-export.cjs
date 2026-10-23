const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const ts = require('typescript');
const sharp = require('sharp');
const RealPdf = require('pdfkit');
const root = path.resolve(__dirname, '../..');
const directory = process.argv[3];
let mode = process.argv[2];
let destination;

// 未捕获错误必须让子进程失败，不能把进程退出误当作导出失败已处理。
process.on('uncaughtException', error => { console.error(error); process.exit(70); });
process.on('unhandledRejection', error => { console.error(error); process.exit(71); });
const io = {
  ...fs,
  createWriteStream(file, options) {
    if (mode === 'disk-full') {
      destination = new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error('simulated disk full');
          error.code = 'ENOSPC';
          callback(error);
        },
      });
    } else destination = fs.createWriteStream(file, options);
    return destination;
  },
};
class ErrorPdf extends RealPdf {
  constructor(options) {
    super(options);
    if (mode === 'source-error') process.nextTick(() => this.destroy(new Error('simulated PDF source error')));
  }
}
const fakeContent = {
  listBooks: () => [{ id: 'test', name_zh: 'Test' }],
  getBookWords: () => [{ lemma: 'word' }],
  getChapter: () => ({ title_en: 'Export fixture', source_label: 'Fixture', cover_path: 'cover.webp' }),
  listQuests: () => [{ id: 1, title_en: 'Quest' }],
  listDialogLines: () => [{ speaker: 'Tester', text_en: 'A word appears in this fixture.', text_chs: '' }],
};
const filename = path.join(root, 'src/main/pdf.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
const load = name => {
  if (name === 'node:fs') return io;
  if (name === '../shared/speaker-initial') { const output={};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(root,'src/shared/speaker-initial.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(output);return output; }
  if (name === 'pdfkit') return mode === 'source-error' ? ErrorPdf : RealPdf;
  if (name === 'electron') return {
    dialog: { showSaveDialog: async () => ({
      canceled: false,
      filePath: path.join(directory, mode === 'missing-directory' ? 'missing/output.pdf' : 'output.pdf'),
    }) },
  };
  if (name === './paths') return { getImagePath(file) {
    if (mode === 'render-error') throw new Error('simulated image resolver failure');
    return path.join(directory, file);
  } };
  if (name === './content-db') return fakeContent;
  if (name === './progress-db') return { getSetting: () => 'test' };
  return require(name);
};

(async () => {
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).webp().toFile(path.join(directory, 'cover.webp'));
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(mod.exports, load, mod, filename, path.dirname(filename));
  const request = { scope: 'chapter', chapterId: 1, bookId: 'test' };
  let result;
  try {
    result = { kind: 'resolved', result: await mod.exports.exportDialoguePdf(null, request) };
  } catch (error) {
    result = { kind: 'rejected', code: error.code, message: error.message };
  }
  await nextTurn();
  result.destinationDestroyed = destination.destroyed;
  result.destinationClosed = destination.closed;
  if (mode !== 'success') {
    mode = 'success';
    // 在同一个进程再次导出，验证失败后可继续使用。
    result.retry = await mod.exports.exportDialoguePdf(null, request);
  }
  const output = fs.readFileSync(path.join(directory, 'output.pdf'));
  result.validPdf = output.subarray(0, 5).toString() === '%PDF-' && /%%EOF\s*$/.test(output.toString('latin1'));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
