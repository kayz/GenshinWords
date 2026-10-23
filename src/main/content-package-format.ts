import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import sharp from 'sharp';
import type { ContentPackageEntry, ContentPackageHeader, ContentPackageManifest, ContentPackageKind, WordPackageData, MaterialPackageData } from '../shared/content-package';

export type { ContentPackageHeader, ContentPackageManifest, WordPackageData, MaterialPackageData } from '../shared/content-package';
export interface ContentPackageInspection {
  header: ContentPackageHeader; digest: string; offsets: Record<string, { offset: number; size: number }>;
  totalSize: number; data?: WordPackageData | MaterialPackageData;
}
export type InspectedContentPackage = ContentPackageInspection;
export const CONTENT_PACKAGE_MAGIC = Buffer.from('GWCONTENT1\n', 'ascii');
export const CONTENT_PACKAGE_LIMITS = Object.freeze({
  headerBytes: 24 * 1024 * 1024, packageBytes: 16 * 1024 ** 3, entryBytes: 8 * 1024 ** 3,
  entries: 100000, dataBytes: 32 * 1024 * 1024, imageBytes: 32 * 1024 * 1024,
  audioBytes: 128 * 1024 * 1024, imagePixels: 64 * 1024 * 1024, bufferBytes: 256 * 1024,
});
type Obj = Record<string, unknown>;
function invalid(where: string, why: string): never { throw new Error(`离线素材包 ${where}：${why}`); }
function object(value: unknown, where: string, allowed: string[], required = allowed): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(where, '必须是JSON对象');
  const record = value as Obj;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) invalid(where, '未知字段 ' + key);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) invalid(where, '缺少字段 ' + key);
  return record;
}
function text(value: unknown, where: string, maximum = 2000, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(where, '文字为空、过长或包含控制字符');
  return value as string;
}
function identifier(value: unknown, where: string): string {
  const result = text(value, where, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) || Object.prototype.hasOwnProperty.call(Object.prototype, result) || result === 'prototype') invalid(where, '编号无效或使用原型保留名称');
  return result;
}
function array(value: unknown, where: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(where, `数组数量须在${minimum}至${maximum}之间`);
  return value as unknown[];
}
function integer(value: unknown, where: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid(where, '整数超出允许范围');
  return value as number;
}
function unique(values: string[], where: string) { if (new Set(values).size !== values.length) invalid(where, '存在重复编号或条目'); }
export function canonicalContentPackageJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalContentPackageJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalContentPackageJson((value as Obj)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function guard(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 1000000 || depth > 24) invalid('JSON', '结构过大或过深');
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value, 'utf8'); if (budget.bytes > CONTENT_PACKAGE_LIMITS.dataBytes) invalid('JSON', '文字总量超过限制'); return; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) guard(child, depth + 1, budget); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid('JSON', '禁止原型字段'); budget.bytes += Buffer.byteLength(key); guard(child, depth + 1, budget); }
    return;
  }
  invalid('JSON', '只允许数据，不能包含函数或特殊对象');
}
function parseJson(bytes: Buffer, where: string): unknown {
  try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); guard(value); return value; }
  catch (error) { return invalid(where, error instanceof Error ? error.message : '无效UTF-8 JSON'); }
}
function semver(value: unknown, where: string): string {
  const result = text(value, where, 128);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(result)) invalid(where, '须使用严格SemVer版本');
  return result;
}
export function compareContentPackageVersions(a: string, b: string): number {
  semver(a, 'version'); semver(b, 'version');
  const parts = (value: string) => { const base = value.split('+')[0], dash = base.indexOf('-'); return { main: (dash < 0 ? base : base.slice(0, dash)).split('.').map(BigInt), pre: dash < 0 ? undefined : base.slice(dash + 1).split('.') }; };
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] > y.main[i] ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i]; if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    return ln && rn ? BigInt(left) > BigInt(right) ? 1 : -1 : ln !== rn ? ln ? -1 : 1 : left > right ? 1 : -1;
  }
  return 0;
}
function httpUrl(value: unknown, where: string) {
  const address = text(value, where, 4096); let parsed: URL;
  try { parsed = new URL(address); } catch { return invalid(where, '须为完整HTTP(S)来源地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(where, '须为无凭据HTTP(S)来源地址');
}
export function validateContentPackageManifest(input: unknown, options: { appVersion?: string } = {}): ContentPackageManifest {
  guard(input);
  const record = object(input, 'manifest', ['id', 'name', 'kind', 'version', 'minAppVersion', 'maxAppVersion', 'author', 'description', 'createdAt', 'dependencies'], ['id', 'name', 'kind', 'version', 'minAppVersion', 'author', 'createdAt']);
  const name = identifier(record.id, 'manifest.id'); if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name)) invalid('manifest.id', '只允许小写字母、数字、点、下划线和连字符');
  text(record.name, 'manifest.name', 200); text(record.author, 'manifest.author', 200);
  if (!['base', 'materials', 'words'].includes(String(record.kind))) invalid('manifest.kind', '不支持的素材包种类');
  semver(record.version, 'manifest.version'); semver(record.minAppVersion, 'manifest.minAppVersion');
  if (record.maxAppVersion !== undefined) { semver(record.maxAppVersion, 'manifest.maxAppVersion'); if (compareContentPackageVersions(String(record.maxAppVersion), String(record.minAppVersion)) < 0) invalid('manifest', '应用版本范围无效'); }
  if (record.description !== undefined) text(record.description, 'manifest.description', 8000, true);
  const date = text(record.createdAt, 'manifest.createdAt', 40);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10)) invalid('manifest.createdAt', '无效ISO日期');
  if (record.dependencies !== undefined) {
    const dependencies = array(record.dependencies, 'dependencies', 0, 100).map(value => { const dep = object(value, 'dependency', ['id', 'minVersion']); const depId = identifier(dep.id, 'dependency.id'); semver(dep.minVersion, 'dependency.minVersion'); if (depId === name) invalid('dependencies', '包不能依赖自身'); return depId; });
    unique(dependencies, 'dependencies');
  }
  if (options.appVersion !== undefined && (compareContentPackageVersions(options.appVersion, String(record.minAppVersion)) < 0 || record.maxAppVersion !== undefined && compareContentPackageVersions(options.appVersion, String(record.maxAppVersion)) > 0)) invalid('manifest', '当前程序版本不满足要求');
  return input as ContentPackageManifest;
}
export function validateWordPackageData(input: unknown): WordPackageData {
  guard(input); const root = object(input, 'data.json', ['books']); let references = 0;
  const ids = array(root.books, 'books', 1, 256).map(value => {
    const book = object(value, 'book', ['id', 'name', 'name_zh', 'description', 'lemmas']);
    const bookId = identifier(book.id, 'book.id'); text(book.name, 'book.name', 200); text(book.name_zh, 'book.name_zh', 200); text(book.description, 'book.description', 8000, true);
    const lemmas = array(book.lemmas, 'book.lemmas', 1, 100000).map(value => {
      const lemma = text(value, 'lemma', 160);
      if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’‘.-]*$/u.test(lemma) || lemma !== lemma.trim()) invalid('lemma', '只允许已有词库的单词或短语引用');
      return lemma.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLowerCase();
    });
    references += lemmas.length; if (references > 1000000) invalid('books', '单词引用总量超过限制'); unique(lemmas, 'book.lemmas'); return bookId;
  }); unique(ids, 'books');
  return JSON.parse(JSON.stringify(input)) as WordPackageData;
}
export function validateMaterialPackageData(input: unknown): MaterialPackageData {
  guard(input); const root = object(input, 'data.json', ['chapters']), questIds: string[] = [], lineIds: string[] = [];
  const chapters = array(root.chapters, 'chapters', 1, 10000).map(value => {
    const chapter = object(value, 'chapter', ['id', 'title_en', 'title_chs', 'type', 'version', 'sourceUrl', 'coverPath', 'quests'], ['id', 'title_en', 'title_chs', 'type', 'version', 'sourceUrl', 'quests']);
    const chapterId = identifier(chapter.id, 'chapter.id'); text(chapter.title_en, 'chapter.title_en', 1000); text(chapter.title_chs, 'chapter.title_chs', 1000); text(chapter.version, 'chapter.version', 80, true); httpUrl(chapter.sourceUrl, 'chapter.sourceUrl');
    if (!['quest', 'voice', 'hangout', 'book'].includes(String(chapter.type))) invalid('chapter.type', '不支持的章节类型');
    if (chapter.coverPath !== undefined && !/^images\/.+\.(?:png|jpe?g|webp)$/i.test(validateContentPackagePath(chapter.coverPath))) invalid('chapter.coverPath', '题图必须引用包内images图片');
    for (const value of array(chapter.quests, 'chapter.quests', 1, 10000)) {
      const quest = object(value, 'quest', ['id', 'title_en', 'title_chs', 'lines']); questIds.push(identifier(quest.id, 'quest.id')); text(quest.title_en, 'quest.title_en', 1000); text(quest.title_chs, 'quest.title_chs', 1000);
      for (const value of array(quest.lines, 'quest.lines', 1, 100000)) { const line = object(value, 'line', ['id', 'speaker', 'text_en', 'text_chs']); lineIds.push(identifier(line.id, 'line.id')); text(line.speaker, 'line.speaker', 300, true); text(line.text_en, 'line.text_en', 24000); text(line.text_chs, 'line.text_chs', 24000); }
      if (questIds.length > 100000 || lineIds.length > 1000000) invalid('chapters', '资料条目总量超过限制');
    }
    return chapterId;
  }); unique(chapters, 'chapters'); unique(questIds, 'quests'); unique(lineIds, 'lines');
  return JSON.parse(JSON.stringify(input)) as MaterialPackageData;
}
export function validateContentPackagePath(input: unknown): string {
  const value = text(input, 'entry.path', 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid('entry.path', '禁止路径跳转、绝对路径、反斜线及Windows设备名');
  return value;
}
const BASE_FILES = new Set(['content.db', 'materials.db', 'materials_manifest.json', 'pronunciation_sources.json', 'speaker_names_report.json']);
function entryLimit(kind: ContentPackageKind, file: string): number {
  if (file === 'data.json' && kind !== 'base') return CONTENT_PACKAGE_LIMITS.dataBytes;
  if (kind === 'words') return invalid(file, '词书包只允许data.json，不允许外部词条或资源');
  if (/^images\/.+\.(?:png|jpe?g|webp)$/i.test(file)) return CONTENT_PACKAGE_LIMITS.imageBytes;
  if (/^audio\/.+\.(?:mp3|ogg|opus|wav)$/i.test(file)) return CONTENT_PACKAGE_LIMITS.audioBytes;
  if (kind === 'base' && (BASE_FILES.has(file) || file === 'images/art_manifest.json')) return file.endsWith('.json') ? CONTENT_PACKAGE_LIMITS.dataBytes : CONTENT_PACKAGE_LIMITS.entryBytes;
  return invalid(file, '不允许的资源类型或学习数据库；禁止代码、进度和任意数据库');
}
export function validateContentPackageHeader(input: unknown, options: { appVersion?: string } = {}): ContentPackageHeader {
  guard(input); const root = object(input, 'header', ['format', 'formatVersion', 'manifest', 'entries']);
  if (root.format !== 'genshinwords.content' || root.formatVersion !== 1) invalid('header', '不支持的文件格式或格式版本');
  const manifest = validateContentPackageManifest(root.manifest, options), names: string[] = []; let total = 0;
  for (const value of array(root.entries, 'entries', 1, CONTENT_PACKAGE_LIMITS.entries)) {
    const entry = object(value, 'entry', ['path', 'size', 'sha256']), file = validateContentPackagePath(entry.path);
    const size = integer(entry.size, file + '.size', 1, entryLimit(manifest.kind, file));
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) invalid(file, '无效SHA-256');
    total += size; if (total > CONTENT_PACKAGE_LIMITS.packageBytes) invalid('entries', '素材总量超过限制'); names.push(file.toLowerCase());
  }
  unique(names, 'entries'); const seen = new Set(names);
  for (const name of names) for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) if (seen.has(name.slice(0, slash))) invalid(name, '文件与父目录路径冲突');
  if (manifest.kind === 'base' ? !seen.has('content.db') : !seen.has('data.json')) invalid('entries', manifest.kind === 'base' ? '基础包缺少content.db' : '缺少data.json');
  return input as ContentPackageHeader;
}
function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid(file, '路径超出目标边界');
}
async function exact(handle: FileHandle, position: number, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size); let read = 0;
  while (read < size) { const result = await handle.read(bytes, read, size - read, position + read); if (!result.bytesRead) invalid('file', '文件意外截断'); read += result.bytesRead; }
  return bytes;
}
async function readHeader(handle: FileHandle, options: { appVersion?: string }): Promise<ContentPackageInspection> {
  const stat = await handle.stat(); if (!stat.isFile() || stat.size < CONTENT_PACKAGE_MAGIC.length + 6 || stat.size > CONTENT_PACKAGE_LIMITS.packageBytes + CONTENT_PACKAGE_LIMITS.headerBytes + 15) invalid('file', '文件大小超出范围');
  const prefix = await exact(handle, 0, CONTENT_PACKAGE_MAGIC.length + 4);
  if (!prefix.subarray(0, CONTENT_PACKAGE_MAGIC.length).equals(CONTENT_PACKAGE_MAGIC)) invalid('file', '不是GWCONTENT1离线素材包');
  const size = prefix.readUInt32BE(CONTENT_PACKAGE_MAGIC.length); if (!size || size > CONTENT_PACKAGE_LIMITS.headerBytes) invalid('header', '头部长度超出限制');
  const start = prefix.length + size; if (start >= stat.size) invalid('file', '缺少头部或文件内容');
  const header = validateContentPackageHeader(parseJson(await exact(handle, prefix.length, size), 'header'), options);
  const offsets: ContentPackageInspection['offsets'] = Object.create(null); let offset = start;
  for (const entry of header.entries) { offsets[entry.path] = { offset, size: entry.size }; offset += entry.size; }
  if (offset !== stat.size) invalid('file', '总长度不符，文件截断或包含多余字节');
  return { header, digest: createHash('sha256').update(canonicalContentPackageJson(header), 'utf8').digest('hex'), offsets, totalSize: stat.size };
}
async function media(bytes: Buffer, file: string) {
  const lower = file.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(lower)) {
    const format = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpeg';
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: CONTENT_PACKAGE_LIMITS.imagePixels, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > CONTENT_PACKAGE_LIMITS.imagePixels) invalid(file, '图片类型、页数或像素尺寸无效');
    await image.raw().toBuffer();
  } else if (/\.(ogg|opus)$/.test(lower)) { if (bytes.toString('ascii', 0, 4) !== 'OggS') invalid(file, '无效Ogg/Opus音频'); }
  else if (lower.endsWith('.wav')) { if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') invalid(file, '无效WAV音频'); }
  else if (lower.endsWith('.mp3')) {
    // Legacy dictionary assets include valid WAV/Ogg files with an .mp3 filename.
    const wave = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    const ogg = bytes.toString('ascii', 0, 4) === 'OggS';
    if (!wave && !ogg && bytes.toString('ascii', 0, 3) !== 'ID3' && !(bytes[0] === 255 && (bytes[1] & 224) === 224)) invalid(file, '无效MP3/WAV/Ogg音频');
  }
}
async function verifyEntry(handle: FileHandle, entry: ContentPackageEntry, offset: number, output?: FileHandle): Promise<Buffer | undefined> {
  const hash = createHash('sha256'), collected: Buffer[] = [], needsBody = entry.path === 'data.json' || /\.(?:png|jpe?g|webp|json)$/i.test(entry.path);
  const bytes = Buffer.allocUnsafe(Math.min(CONTENT_PACKAGE_LIMITS.bufferBytes, entry.size)); let done = 0, first: Buffer | undefined;
  while (done < entry.size) {
    const read = await handle.read(bytes, 0, Math.min(bytes.length, entry.size - done), offset + done);
    if (!read.bytesRead) invalid(entry.path, '文件意外截断'); const chunk = bytes.subarray(0, read.bytesRead);
    if (!first) first = Buffer.from(chunk.subarray(0, 32)); hash.update(chunk); if (needsBody) collected.push(Buffer.from(chunk));
    if (output) { let written = 0; while (written < chunk.length) { const result = await output.write(chunk, written, chunk.length - written, done + written); if (!result.bytesWritten) invalid(entry.path, '无法写入文件'); written += result.bytesWritten; } }
    done += read.bytesRead;
  }
  if (hash.digest('hex') !== entry.sha256) invalid(entry.path, 'SHA-256不匹配，文件可能损坏或已被替换');
  if (entry.path.endsWith('.db') && first!.toString('ascii', 0, 16) !== 'SQLite format 3\0') invalid(entry.path, '不是有效SQLite文件头');
  const body = needsBody ? Buffer.concat(collected, entry.size) : undefined;
  if (entry.path.endsWith('.json')) parseJson(body!, entry.path);
  if (/^images\//.test(entry.path) && !entry.path.endsWith('.json')) await media(body!, entry.path);
  if (/^audio\//.test(entry.path)) await media(first!, entry.path);
  return entry.path === 'data.json' ? body : undefined;
}
async function ensureParent(root: string, target: string) {
  inside(root, target); const components = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean); let cursor = root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    try { const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid(cursor, '目标父路径不是普通目录'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(cursor, { mode: 0o700 }); }
    const real = await fs.realpath(cursor); inside(root, real);
  }
  if (path.dirname(target) !== root) inside(root, await fs.realpath(path.dirname(target)));
}
async function processPackage(file: string, destination: string | undefined, options: { appVersion?: string }): Promise<ContentPackageInspection> {
  const source = await fs.open(file, 'r'); let created: string | undefined;
  try {
    const before = await source.stat(), result = await readHeader(source, options);
    if (destination !== undefined) {
      const absolute = path.resolve(destination), parent = await fs.realpath(path.dirname(absolute));
      const target = path.join(parent, path.basename(absolute)); inside(parent, target);
      await fs.mkdir(target, { mode: 0o700 }); created = target;
      if ((await fs.lstat(target)).isSymbolicLink()) invalid(target, '目标不能是链接');
    }
    let data: Buffer | undefined;
    for (const entry of result.header.entries) {
      let output: FileHandle | undefined;
      try {
        if (created) { const target = path.resolve(created, entry.path); await ensureParent(created, target); output = await fs.open(target, 'wx', 0o600); }
        const body = await verifyEntry(source, entry, result.offsets[entry.path].offset, output); if (entry.path === 'data.json') data = body;
        if (output) await output.sync();
      } finally { await output?.close(); }
    }
    if (data) {
      const raw = parseJson(data, 'data.json');
      result.data = result.header.manifest.kind === 'words' ? validateWordPackageData(raw) : validateMaterialPackageData(raw);
      if (result.header.manifest.kind === 'materials') for (const chapter of (result.data as MaterialPackageData).chapters) if (chapter.coverPath && !Object.prototype.hasOwnProperty.call(result.offsets, chapter.coverPath)) invalid(chapter.id, '题图资源未包含在包内');
    }
    const after = await source.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) invalid('file', '验证期间文件发生变化');
    return result;
  } catch (error) { if (created) await fs.rm(created, { recursive: true, force: true }); throw error; }
  finally { await source.close(); }
}
export async function inspectContentPackage(file: string, options: { appVersion?: string } = {}): Promise<ContentPackageInspection> { return processPackage(file, undefined, options); }
export async function extractContentPackage(file: string, destination: string, options: { appVersion?: string } = {}): Promise<ContentPackageInspection> { return processPackage(file, destination, options); }

async function authorFiles(root: string, manifest: ContentPackageManifest): Promise<Array<{ entry: ContentPackageEntry; file: string }>> {
  const result: Array<{ entry: ContentPackageEntry; file: string }> = []; let total = 0, visited = 0;
  async function walk(directory: string) {
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      if (++visited > CONTENT_PACKAGE_LIMITS.entries * 2) invalid('files', '文件和目录总量超过限制');
      if (directory === root && child.name === 'manifest.json') continue;
      if (directory === root && manifest.kind === 'base' && !BASE_FILES.has(child.name) && !['images', 'audio'].includes(child.name)) continue;
      const actual = path.join(directory, child.name), stat = await fs.lstat(actual); inside(root, await fs.realpath(actual));
      if (stat.isSymbolicLink()) invalid(actual, '作者源禁止符号链接或junction');
      if (stat.isDirectory()) { await walk(actual); continue; }
      if (!stat.isFile()) invalid(actual, '只允许普通文件');
      const logical = validateContentPackagePath(path.relative(root, actual).replace(/\\/g, '/'));
      integer(stat.size, logical, 1, entryLimit(manifest.kind, logical));
      total += stat.size; if (total > CONTENT_PACKAGE_LIMITS.packageBytes) invalid('files', '文件总大小超过限制');
      const handle = await fs.open(actual, 'r'); const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(Math.min(CONTENT_PACKAGE_LIMITS.bufferBytes, stat.size)); let offset = 0;
      try { while (offset < stat.size) { const part = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (!part.bytesRead) invalid(logical, '作者源文件截断'); hash.update(chunk.subarray(0, part.bytesRead)); offset += part.bytesRead; } const after = await handle.stat(); if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) invalid(logical, '作者源文件在打包中变化'); }
      finally { await handle.close(); }
      result.push({ file: actual, entry: { path: logical, size: stat.size, sha256: hash.digest('hex') } });
      if (result.length > CONTENT_PACKAGE_LIMITS.entries) invalid('files', '文件数量超过限制');
    }
  }
  await walk(root); return result.sort((a, b) => a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);
}
function outsideAuthor(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) invalid('output', '输出文件不能位于作者目录内');
}
async function outputTarget(root: string, out: string): Promise<{ target: string; parent: string }> {
  const absolute = path.resolve(out), missing: string[] = []; let ancestor = path.dirname(absolute);
  for (;;) {
    try { await fs.lstat(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const above = path.dirname(ancestor); if (above === ancestor) invalid('output', '输出父目录不可用');
      missing.unshift(path.basename(ancestor)); ancestor = above;
    }
  }
  const existing = await fs.realpath(ancestor); if (!(await fs.stat(existing)).isDirectory()) invalid('output', '输出父路径不是目录');
  const plannedParent = path.join(existing, ...missing), planned = path.join(plannedParent, path.basename(absolute));
  // Check physical ancestry before mkdir so a forbidden output cannot add folders
  // to the source tree, including when an existing parent is a junction into it.
  outsideAuthor(root, planned);
  await fs.mkdir(plannedParent, { recursive: true });
  const parent = await fs.realpath(plannedParent), target = path.join(parent, path.basename(absolute));
  outsideAuthor(root, target); return { parent, target };
}
export async function packContentDirectory(authorDir: string, out: string, options: { manifestPath?: string } = {}): Promise<ContentPackageInspection> {
  const root = await fs.realpath(authorDir), manifestFile = options.manifestPath ? path.resolve(options.manifestPath) : path.join(root, 'manifest.json');
  const manifestStat = await fs.lstat(manifestFile); if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) invalid('manifest.json', '须为不超过64KiB的普通JSON文件');
  const manifest = validateContentPackageManifest(parseJson(await fs.readFile(manifestFile), 'manifest.json'));
  if (manifest.kind === 'base') {
    const archive = await fs.stat(path.join(root, 'assets.asar')).then(stat => stat.isFile()).catch(() => false);
    const audio = await fs.stat(path.join(root, 'audio')).then(stat => stat.isDirectory()).catch(() => false), images = await fs.stat(path.join(root, 'images')).then(stat => stat.isDirectory()).catch(() => false);
    if (archive && (!audio || !images)) invalid('assets.asar', '此格式版本只接受松散images/audio作者源，不能跳过仅存于未检查ASAR中的媒体');
  }
  const { parent, target } = await outputTarget(root, out);
  if (path.extname(target).toLowerCase() !== (manifest.kind === 'words' ? '.gwwords' : '.gwcontent')) invalid('output', '包扩展名须与kind匹配');
  try { const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) invalid('output', '目标须为普通文件'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = await authorFiles(root, manifest), header = validateContentPackageHeader({ format: 'genshinwords.content', formatVersion: 1, manifest, entries: files.map(file => file.entry) });
  const json = Buffer.from(canonicalContentPackageJson(header), 'utf8'); if (json.length > CONTENT_PACKAGE_LIMITS.headerBytes) invalid('header', '头部超过限制');
  const prefix = Buffer.alloc(CONTENT_PACKAGE_MAGIC.length + 4); CONTENT_PACKAGE_MAGIC.copy(prefix); prefix.writeUInt32BE(json.length, CONTENT_PACKAGE_MAGIC.length);
  const temporary = path.join(parent, '.' + path.basename(target) + '.' + randomUUID() + '.tmp'), outputFile = await fs.open(temporary, 'wx', 0o600);
  try {
    await outputFile.writeFile(Buffer.concat([prefix, json])); let offset = prefix.length + json.length;
    for (const file of files) {
      const input = await fs.open(file.file, 'r');
      try {
        const before = await input.stat(); if (before.size !== file.entry.size) invalid(file.entry.path, '作者源文件已变化');
        const buffer = Buffer.allocUnsafe(Math.min(CONTENT_PACKAGE_LIMITS.bufferBytes, file.entry.size)), hash = createHash('sha256'); let copied = 0;
        while (copied < file.entry.size) { const part = await input.read(buffer, 0, Math.min(buffer.length, file.entry.size - copied), copied); if (!part.bytesRead) invalid(file.entry.path, '作者源文件截断'); const chunk = buffer.subarray(0, part.bytesRead); hash.update(chunk); let written = 0; while (written < chunk.length) { const put = await outputFile.write(chunk, written, chunk.length - written, offset + copied + written); if (!put.bytesWritten) invalid('output', '写入失败'); written += put.bytesWritten; } copied += part.bytesRead; }
        const after = await input.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== file.entry.sha256) invalid(file.entry.path, '作者源文件在打包中变化'); offset += copied;
      } finally { await input.close(); }
    }
    await outputFile.sync(); await outputFile.close();
    const valid = await inspectContentPackage(temporary); await fs.rename(temporary, target); return valid;
  } catch (error) { await outputFile.close().catch(() => {}); await fs.rm(temporary, { force: true }); throw error; }
}
