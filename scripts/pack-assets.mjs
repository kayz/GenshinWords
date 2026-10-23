/**
 * 可选素材归档：默认输出 content/assets.asar，发布 EXE 不要求预先归档。
 * --out 指定其他 .asar 文件；--force 覆盖已有归档。
 * --prune 仅允许默认输出路径，并在逐文件校验后清理源文件。
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createPackageFromFiles, listPackage, extractFile } = require('@electron/asar');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['audio', 'images'];

function parseArgs(argv, contentDir) {
  const opts = { out: path.join(contentDir, 'assets.asar'), prune: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prune') opts.prune = true;
    else if (argv[i] === '--force') opts.force = true;
    else if (argv[i] === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--out 缺少输出路径');
      opts.out = path.resolve(argv[++i]);
    } else if (argv[i].startsWith('--out=')) {
      if (!argv[i].slice(6)) throw new Error('--out 缺少输出路径');
      opts.out = path.resolve(argv[i].slice(6));
    } else throw new Error('未知参数：' + argv[i]);
  }
  return opts;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// 解析已经存在的父目录，防止 junction / 符号链接绕过输出路径检查。
function resolveOutput(file) {
  let parent = path.dirname(path.resolve(file));
  const names = [path.basename(file)];
  while (!fs.existsSync(parent)) {
    names.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('输出目录不可用');
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...names);
}

function scan(directory, entries = []) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('素材目录不支持符号链接或 junction：' + directory);
  if (!stat.isDirectory()) throw new Error('素材路径不是目录：' + directory);
  entries.push({ file: directory, directory: true });
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('素材中不支持符号链接：' + file);
    if (item.isDirectory()) scan(file, entries);
    else if (item.isFile()) entries.push({ file, directory: false });
    else throw new Error('不支持的素材文件类型：' + file);
  }
  return entries;
}

function namesOf(entries, contentDir) {
  return entries.map(({ file }) => path.relative(contentDir, file).replace(/\\/g, '/')).sort();
}

function verifyArchive(archive, entries, contentDir) {
  const expected = namesOf(entries, contentDir);
  const actual = listPackage(archive).map(name => name.replace(/\\/g, '/').replace(/^\/+/, '')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('归档条目校验失败，保留所有源文件');
  const verified = new Map();
  for (const entry of entries) {
    if (entry.directory) continue;
    const relative = path.relative(contentDir, entry.file);
    const stat = fs.lstatSync(entry.file);
    if (!stat.isFile() || !fs.readFileSync(entry.file).equals(extractFile(archive, relative))) {
      throw new Error('归档内容校验失败，保留源文件：' + relative);
    }
    verified.set(entry.file, stat);
  }
  return verified;
}

function pruneSources(entries, verified, contentDir, present) {
  const current = present.flatMap(dir => scan(path.join(contentDir, dir)));
  if (JSON.stringify(namesOf(current, contentDir)) !== JSON.stringify(namesOf(entries, contentDir))) {
    throw new Error('打包期间素材目录发生变化，取消清理');
  }
  for (const entry of entries) {
    if (!isWithin(contentDir, entry.file) || path.relative(contentDir, entry.file) === '') {
      throw new Error('清理目标不在素材目录内：' + entry.file);
    }
    if (entry.directory && path.relative(entry.file, fs.realpathSync(entry.file)) !== '') {
      throw new Error('素材目录路径发生变化，取消清理');
    }
    if (!entry.directory) {
      const before = verified.get(entry.file);
      const currentStat = fs.lstatSync(entry.file);
      if (!currentStat.isFile() || currentStat.size !== before.size || currentStat.mtimeMs !== before.mtimeMs || currentStat.ino !== before.ino) {
        throw new Error('打包期间素材文件发生变化，取消清理：' + entry.file);
      }
    }
  }
  // 只删已经校验的文件；新增文件会阻止 rmdir，不做递归删除。
  for (const entry of entries) if (!entry.directory) fs.unlinkSync(entry.file);
  for (const entry of [...entries].reverse()) if (entry.directory) fs.rmdirSync(entry.file);
}

async function main() {
  const contentDir = fs.realpathSync(path.resolve(process.env.GENSHINWORDS_CONTENT_DIR || path.join(projectRoot, 'content')));
  const opts = parseArgs(process.argv.slice(2), contentDir);
  opts.out = resolveOutput(opts.out);
  if (path.extname(opts.out).toLowerCase() !== '.asar') throw new Error('输出文件必须使用 .asar 扩展名');
  for (const directory of INCLUDE) {
    if (isWithin(path.join(contentDir, directory), opts.out)) throw new Error('输出归档不能位于待打包的素材目录内');
  }
  if (opts.prune && path.relative(path.join(contentDir, 'assets.asar'), opts.out) !== '') {
    throw new Error('--prune 只能与默认 content/assets.asar 输出路径一起使用');
  }
  if (fs.existsSync(opts.out)) {
    const outputStat = fs.lstatSync(opts.out);
    if (!outputStat.isFile()) throw new Error('输出路径必须是普通文件，不能是目录或符号链接');
    if (!opts.force) throw new Error('目标已存在；加 --force 覆盖：' + opts.out);
  }
  const present = INCLUDE.filter(dir => fs.existsSync(path.join(contentDir, dir)));
  if (!present.length) throw new Error('内容目录下没有 audio/ 或 images/ 可打包');
  const entries = present.flatMap(dir => scan(path.join(contentDir, dir)));
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const temporary = path.join(path.dirname(opts.out), '.' + path.basename(opts.out) + '.' + randomUUID() + '.tmp');
  try {
    console.log('打包并逐文件校验：' + opts.out);
    const output = await createPackageFromFiles(contentDir, temporary, entries.map(entry => entry.file));
    // ASAR 返回时 WriteStream 可能尚未关闭；关闭后再校验和替换，兼容 Windows。
    await finished(output, { cleanup: true });
    const verified = verifyArchive(temporary, entries, contentDir);
    // 校验通过才替换旧归档，打包或校验失败时不覆盖可用版本。
    fs.renameSync(temporary, opts.out);
    if (opts.prune) pruneSources(entries, verified, contentDir, present);
    console.log('完成：' + fs.statSync(opts.out).size + ' B，' + entries.length + ' 个条目' + (opts.prune ? '；已校验并清理源素材' : '；源素材已保留'));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

main().catch(error => {
  console.error('打包失败：', error.message);
  process.exitCode = 1;
});
