import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as paths from './paths';
import { openPackageDatabase, validateBaseDatabase, validateBaseMedia, validateMaterialsDatabase, type ContentRevision } from './content-package-db';
import type { ContentPackageEntry, ContentPackageHeader } from '../shared/content-package';
import type { ResourceDirectoryRawInfo } from '../shared/resource-directory';

interface Stamp { size: number; mtimeMs: number }
export interface RawResourceRevision {
  digest: string; source: string; snapshot: string; info: ResourceDirectoryRawInfo;
  header: ContentPackageHeader; stamps: Record<string, Stamp>;
}
interface Config { formatVersion: 1; selected: string | null; revisions: string[] }
interface Runtime { file: string; config: Config; revisions: Map<string, RawResourceRevision>; error?: string; initialized: boolean; snapshotValid: boolean }
interface Prepared { revision: RawResourceRevision; expires: number }
const tokens = new Map<string, Prepared>();
const DIGEST = /^[a-f0-9]{64}$/;
let runtime: Runtime | undefined;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Kept beside the package cache, independently of the personal learning database. */
export function getResourceDirectoryConfigPath(): string {
  return path.join(path.dirname(path.resolve(paths.getContentPackagesDir())), 'resource-directory-raw.json');
}
function getRuntime(): Runtime {
  const file = getResourceDirectoryConfigPath();
  if (runtime?.file === file) return runtime;
  runtime = { file, config: { formatVersion: 1, selected: null, revisions: [] }, revisions: new Map(), initialized: false, snapshotValid: false };
  tokens.clear();
  if (fs.existsSync(file)) try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
    if (!value || value.formatVersion !== 1 || !Array.isArray(value.revisions) || value.revisions.some(item => !DIGEST.test(item)) ||
      value.selected !== null && (!DIGEST.test(value.selected) || !value.revisions.includes(value.selected))) throw new Error('资源目录配置损坏，请重新指定目录。');
    runtime.config = value;
  } catch (error) { runtime.error = errorMessage(error); }
  return runtime;
}
function snapshotDirectory(digest: string): string {
  if (!DIGEST.test(digest)) throw new Error('资源目录快照编号无效。');
  return path.join(paths.getContentPackagesDir(), 'raw', digest);
}
function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), randomUUID() + '.tmp');
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx'); fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function equalPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function safeRoot(directory: string): string {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择绝对路径的本机资源目录。');
  const resolved = path.resolve(directory), stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(fs.realpathSync(resolved), resolved))
    throw new Error('资源目录不能使用符号链接、目录联接或跳转路径。');
  return resolved;
}
function safeFile(root: string, relative: string, directory = false): string {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') ||
    relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('资源目录含有不安全的资源路径。');
  const resolvedRoot = safeRoot(root), segments = relative.split('/');
  let target = resolvedRoot;
  for (let index = 0; index < segments.length; index++) {
    target = path.join(target, segments[index]);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (index < segments.length - 1 || directory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('资源目录不能包含符号链接、目录联接或特殊文件：' + relative);
  }
  const rel = path.relative(resolvedRoot, fs.realpathSync(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('资源文件越出了所选目录。');
  return target;
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function hashFileSync(file: string): string {
  const hash = createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let count: number; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function readRevision(digest: string): RawResourceRevision {
  const current = getRuntime(), cached = current.revisions.get(digest);
  if (cached) return cached;
  const snapshot = snapshotDirectory(digest), raw = JSON.parse(fs.readFileSync(path.join(snapshot, 'raw.json'), 'utf8')) as RawResourceRevision;
  if (!raw || raw.digest !== digest || typeof raw.source !== 'string' || !path.isAbsolute(raw.source) ||
    !raw.header || raw.header.format !== 'genshinwords.content' || raw.header.formatVersion !== 1 || raw.header.manifest?.kind !== 'base' ||
    !Array.isArray(raw.header.entries) || !raw.stamps || !raw.info || raw.info.path !== raw.source ||
    raw.header.entries.some(entry => typeof entry.path !== 'string' || !DIGEST.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0))
    throw new Error('资源目录快照登记损坏，请重新指定原始资源目录。');
  // A backup may move between users or disks. Only the current managed cache determines this path.
  raw.snapshot = snapshot;
  current.revisions.set(digest, raw); return raw;
}
function identityRecoveryError(digest: string, cause?: unknown): Error {
  return new Error('旧资源身份缓存缺失或不可读，暂不能安全切换。请从备份或旧版完整资源目录恢复 content.db 和 materials.db 到 ' +
    snapshotDirectory(digest) + '，恢复后再指定目录；学习记录无需重置。' + (cause ? ' 原因：' + errorMessage(cause) : ''));
}
/** Broken media registration must not hide the last readable word and source identities. */
export function getRawResourceIdentityFiles(): { content: string; materials: string } | null {
  const current = getRuntime(), digest = current.config.selected;
  if (!digest) return null;
  try {
    const directory = snapshotDirectory(digest), content = safeFile(directory, 'content.db'), materials = safeFile(directory, 'materials.db');
    let revision: RawResourceRevision | undefined;
    try { revision = readRevision(digest); } catch { /* Recover identities from the databases when their media receipt is lost. */ }
    if (revision) checkSnapshots(revision);
    validateBaseDatabase(content); validateMaterialsDatabase(materials);
    return { content, materials };
  } catch (error) { throw identityRecoveryError(digest, error); }
}
function checkSnapshots(revision: RawResourceRevision): void {
  for (const relative of ['content.db', 'materials.db']) {
    const entry = revision.header.entries.find(item => item.path === relative), file = safeFile(revision.snapshot, relative);
    if (!entry || hashFileSync(file) !== entry.sha256) throw new Error('资源目录数据库快照损坏，请重新指定目录。');
  }
}
function checkOriginalDatabases(revision: RawResourceRevision): void {
  safeRoot(revision.source);
  for (const relative of ['content.db', 'materials.db']) {
    const original = safeFile(revision.source, relative), entry = revision.header.entries.find(item => item.path === relative), expected = revision.stamps[relative];
    if (!entry || !expected) throw new Error('资源目录数据库登记损坏。');
    const actual = fs.statSync(original);
    if (actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
      if (hashFileSync(original) !== entry.sha256) throw new Error('资源目录中的数据库已改动，请重新预检并载入目录。');
    }
  }
}

/** A cheap shape probe. Full validation happens only when this returns true. */
export function hasRawResourceDirectory(directory: string): boolean {
  return typeof directory === 'string' && path.isAbsolute(directory) && fs.existsSync(path.join(directory, 'content.db'));
}
export async function initializeResourceDirectory(): Promise<void> {
  const current = getRuntime();
  if (current.initialized) return;
  current.initialized = true;
  if (!current.config.selected) return;
  try {
    const revision = readRevision(current.config.selected); checkSnapshots(revision);
    validateBaseDatabase(path.join(revision.snapshot, 'content.db'), undefined, false);
    validateMaterialsDatabase(path.join(revision.snapshot, 'materials.db'), undefined, false);
    current.snapshotValid = true;
    checkOriginalDatabases(revision);
    current.error = undefined;
  } catch (error) { current.error = '所选资源目录不可用：' + errorMessage(error); }
}
export function getRawResourceDirectoryStatus(): ResourceDirectoryRawInfo | null {
  const current = getRuntime();
  if (!current.config.selected) return current.error ? { path: '', name: '资源目录', version: '未登记', wordCount: 0, chapterCount: 0, lineCount: 0, status: 'error', message: current.error } : null;
  try {
    const revision = readRevision(current.config.selected);
    try {
      for (const relative of ['content.db', 'materials.db']) {
        const file = safeFile(revision.source, relative), actual = fs.statSync(file), expected = revision.stamps[relative];
        if (!expected || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)
          throw new Error('资源数据库已改动，请重新预检目录。');
      }
      safeFile(revision.source, 'images', true); safeFile(revision.source, 'audio', true);
    } catch (error) { current.error = '所选资源目录已移除、改动或不可访问，请重新指定目录：' + errorMessage(error); }
    return { ...revision.info, status: current.error ? 'error' : 'active', ...(current.error ? { message: current.error } : {}) };
  } catch {
    const directory = snapshotDirectory(current.config.selected);
    const readable = fs.existsSync(path.join(directory, 'content.db')) && fs.existsSync(path.join(directory, 'materials.db'));
    return { path: '', name: '资源目录', version: '未登记', wordCount: 0, chapterCount: 0, lineCount: 0, status: 'error',
      message: readable ? '资源版本登记损坏，请重新指定目录；保留的旧数据库仍会用于核对内容编号。' : identityRecoveryError(current.config.selected).message };
  }
}
/** An unavailable configured source never gets silently reinterpreted as another raw version. */
export function getActiveRawResourceRevision(): ContentRevision | null {
  const current = getRuntime();
  if (!current.initialized) void initializeResourceDirectory();
  if (!current.config.selected || !current.snapshotValid) return null;
  return getSelectedRawResourceRevision();
}
/** Keep historical identity checks even when the selected external directory is offline. */
export function getSelectedRawResourceRevision(): ContentRevision | null {
  const current = getRuntime();
  if (!current.config.selected) return null;
  try {
    const revision = readRevision(current.config.selected);
    return { header: revision.header, digest: revision.digest, directory: revision.snapshot, builtIn: false, activated: true };
  } catch (error) {
    current.snapshotValid = false; current.error = '资源版本登记损坏：' + errorMessage(error);
    return null;
  }
}
export function getActiveRawResourcePath(): string | null {
  const revision = getActiveRawResourceRevision();
  return revision ? readRevision(revision.digest).source : null;
}
export function getResourceDirectoryConfig(): { path: string | null; digest: string | null } {
  const current = getRuntime();
  let selectedPath: string | null = null;
  if (current.config.selected) try { selectedPath = readRevision(current.config.selected).source; } catch { /* Allow the directory picker to repair broken registration. */ }
  return { path: selectedPath, digest: current.config.selected };
}

/** The store owns the DB transaction; this selection is persisted only after its new DB opens. */
export function beginRawResourceSelection(revision: RawResourceRevision | null): { commit(): void; rollback(): void } {
  const current = getRuntime(), previous = structuredClone(current.config), oldError = current.error, oldSnapshotValid = current.snapshotValid;
  if (revision) current.revisions.set(revision.digest, revision);
  current.config = { formatVersion: 1, selected: revision?.digest ?? null,
    revisions: [...new Set([...current.config.revisions, ...(revision ? [revision.digest] : [])])] };
  current.error = undefined;
  current.snapshotValid = Boolean(revision);
  return {
    commit: () => atomicJson(current.file, current.config),
    rollback: () => { current.config = previous; current.error = oldError; current.snapshotValid = oldSnapshotValid; },
  };
}
export function resolveRawResourceMedia(digest: string, relative: string): string | undefined {
  const current = getRuntime();
  if (!current.config.revisions.includes(digest) && !current.revisions.has(digest)) return undefined;
  const revision = readRevision(digest), entry = revision.header.entries.find(item => item.path === relative);
  if (!entry || !(relative.startsWith('images/') || relative.startsWith('audio/'))) throw new Error('资源不属于该目录版本。');
  try {
    const file = safeFile(revision.source, relative), actual = fs.statSync(file), stamp = revision.stamps[relative];
    if (actual.size !== entry.size || !stamp || actual.mtimeMs !== stamp.mtimeMs && hashFileSync(file) !== entry.sha256)
      throw new Error('原始资源文件已改动。');
    return file;
  } catch (error) {
    const description = '外部资源目录中的旧资源已移除、改动或不可访问，请重新指定目录：' + errorMessage(error);
    if (current.config.selected === digest) current.error = description;
    throw new Error(description);
  }
}

export async function prepareRawResourceDirectory(directory: string): Promise<{ token: string; raw: ResourceDirectoryRawInfo; warnings: string[] }> {
  const source = safeRoot(directory), entries: ContentPackageEntry[] = [], stamps: Record<string, Stamp> = Object.create(null);
  for (const relative of ['content.db', 'materials.db']) {
    safeFile(source, relative);
    for (const suffix of ['-wal', '-journal']) if (fs.existsSync(path.join(source, relative + suffix)) && fs.statSync(path.join(source, relative + suffix)).size)
      throw new Error('资源数据库正在写入，请关闭修改它的程序后重试。');
  }
  const files = ['content.db', 'materials.db'];
  function walk(relative: string): void {
    const folder = safeFile(source, relative, true);
    for (const name of fs.readdirSync(folder).sort()) {
      const logical = relative + '/' + name, file = path.join(source, logical), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('资源目录不能包含符号链接或目录联接：' + logical);
      if (stat.isDirectory()) walk(logical);
      else if (stat.isFile()) { safeFile(source, logical); files.push(logical); }
      else throw new Error('资源目录不能包含特殊文件：' + logical);
    }
  }
  walk('images'); walk('audio');
  // Stream each asset once, without copying media into the application profile.
  for (const relative of files) {
    const file = safeFile(source, relative), before = fs.statSync(file), sha256 = await hashFile(file), after = fs.statSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('资源目录在预检期间发生变化，请重试。');
    entries.push({ path: relative, size: after.size, sha256 }); stamps[relative] = { size: after.size, mtimeMs: after.mtimeMs };
  }
  let name = path.basename(source) || '外部基础素材', version = '未登记';
  for (const metadata of ['resource-manifest.json', 'manifest.json']) if (fs.existsSync(path.join(source, metadata))) {
    const file = safeFile(source, metadata);
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('资源目录版本元数据过大。');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown };
    if (typeof manifest.name === 'string' && manifest.name.trim() && manifest.name.length <= 120) name = manifest.name;
    if (typeof manifest.version === 'string' && manifest.version.trim() && manifest.version.length <= 120) version = manifest.version;
    break;
  }
  const digest = createHash('sha256').update(JSON.stringify([source, name, version, entries])).digest('hex');
  const snapshot = snapshotDirectory(digest), temporary = path.join(paths.getContentPackagesDir(), 'raw', randomUUID());
  fs.mkdirSync(temporary, { recursive: true });
  try {
    for (const relative of ['content.db', 'materials.db']) {
      fs.copyFileSync(safeFile(source, relative), path.join(temporary, relative));
      if (await hashFile(path.join(temporary, relative)) !== entries.find(entry => entry.path === relative)!.sha256)
        throw new Error('资源数据库在预检期间发生变化，请重试。');
    }
    const store = await import('./content-package-store'), previous = store.getCurrentContentResourceFiles();
    const previousContent = previous.content && !equalPath(path.resolve(previous.content), path.join(source, 'content.db')) ? previous.content : undefined;
    const previousMaterials = previous.materials && !equalPath(path.resolve(previous.materials), path.join(source, 'materials.db')) ? previous.materials : undefined;
    validateBaseDatabase(path.join(temporary, 'content.db'), previousContent);
    validateMaterialsDatabase(path.join(temporary, 'materials.db'), previousMaterials);
    const header: ContentPackageHeader = { format: 'genshinwords.content', formatVersion: 1,
      manifest: { id: 'local.raw.' + digest, name, version: '1.0.0', kind: 'base', author: '本机资源目录', minAppVersion: '1.1.0', createdAt: '2026-10-23T00:00:00.000Z' }, entries };
    validateBaseMedia({ header, digest, directory: temporary, builtIn: false }, source);
    const db = openPackageDatabase(path.join(temporary, 'content.db'));
    let raw: ResourceDirectoryRawInfo;
    try {
      const count = (table: string) => (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
      raw = { path: source, name, version, wordCount: count('words'), chapterCount: count('chapters'), lineCount: count('dialog_lines'), status: 'ready' };
    } finally { db.close(); }
    const revision: RawResourceRevision = { digest, source, snapshot, header, stamps, info: raw };
    atomicJson(path.join(temporary, 'raw.json'), revision);
    if (fs.existsSync(snapshot)) {
      // A repeated preview must leave every possibly open immutable database in place.
      for (const relative of ['content.db', 'materials.db']) {
        const existing = safeFile(snapshot, relative);
        if (await hashFile(existing) !== entries.find(entry => entry.path === relative)!.sha256)
          throw new Error('已有资源快照损坏，无法复用；请在内容管理中修复缓存后重新载入。');
      }
      atomicJson(path.join(snapshot, 'raw.json'), revision);
    } else fs.renameSync(temporary, snapshot);
    const current = getRuntime(); current.revisions.set(digest, revision);
    for (const [key, pending] of tokens) if (pending.expires < Date.now()) tokens.delete(key);
    while (tokens.size >= 8) tokens.delete(tokens.keys().next().value!);
    const token = randomUUID(); tokens.set(token, { revision, expires: Date.now() + 10 * 60_000 });
    return { token, raw, warnings: ['图片和发音直接从所选目录读取，请保留完整目录并保持可访问。', ...(version === '未登记' ? ['此目录未登记独立素材版本。'] : [])] };
  } finally {
    if (fs.existsSync(temporary)) {
      if (path.dirname(path.resolve(temporary)) !== path.resolve(paths.getContentPackagesDir(), 'raw')) throw new Error('拒绝清理资源缓存之外的路径。');
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}
export function validatePreparedRawResourceRevision(revision: RawResourceRevision): void {
  checkSnapshots(revision); checkOriginalDatabases(revision);
  const source = safeRoot(revision.source), checkedDirectories = new Set<string>();
  for (const entry of revision.header.entries) {
    // Check each common parent once; thirty thousand files must not repeatedly resolve the same root.
    const parent = path.posix.dirname(entry.path);
    if (parent !== '.' && !checkedDirectories.has(parent)) { safeFile(source, parent, true); checkedDirectories.add(parent); }
    const file = path.join(source, entry.path), actual = fs.lstatSync(file), expected = revision.stamps[entry.path];
    if (!actual.isFile() || actual.isSymbolicLink()) throw new Error('资源目录在预览后包含了链接或特殊文件，请重新选择。');
    if (!expected || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) throw new Error('资源目录在预览后发生变化，请重新选择。');
  }
  // An ancestor replaced by a junction during the scan is rejected before committing the selection.
  for (const parent of checkedDirectories) safeFile(source, parent, true);
  safeRoot(source);
}
export async function activateRawResourceDirectory(token: string): Promise<ResourceDirectoryRawInfo> {
  const prepared = tokens.get(token);
  if (!prepared || prepared.expires < Date.now()) throw new Error('资源目录预览已过期，请重新选择。');
  tokens.delete(token);
  const revision = prepared.revision;
  validatePreparedRawResourceRevision(revision);
  const store = await import('./content-package-store');
  await store.activateContentPackagesWithRawRevision(revision);
  return { ...revision.info, status: 'active' };
}
