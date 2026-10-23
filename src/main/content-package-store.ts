import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { version as applicationVersion } from '../../package.json';
import * as paths from './paths';
import { inspectContentPackage, extractContentPackage, validateWordPackageData, validateMaterialPackageData } from './content-package-format';
import { compareReadingPackageVersions as compareVersions } from './reading-package-format';
import { buildDerivedContent, validateBaseDatabase, validateBaseMedia, validateMaterialsDatabase, validateMaterialHistory, type ContentRevision } from './content-package-db';
import { initializeResourceDirectory, getActiveRawResourceRevision, getSelectedRawResourceRevision, getRawResourceIdentityFiles, getActiveRawResourcePath, resolveRawResourceMedia, beginRawResourceSelection, validatePreparedRawResourceRevision, type RawResourceRevision } from './resource-directory-config';
import type { ContentPackageHeader, ContentPackageInfo, ContentPackagePreview, ContentPackageImportResult, WordPackageData, MaterialPackageData } from '../shared/content-package';

interface Entry { header: ContentPackageHeader; digest: string; builtIn: boolean; activated?: boolean }
interface Registry { formatVersion: 1; active: Entry[]; pending: Entry[]; revisions: Entry[] }
interface State {
  root: string; fallback: string | null; registry: Registry; active: ContentRevision[]; errors: ContentPackageInfo[];
  prepared: boolean; opened: boolean; effective: string | null; managedBase: string | null;
}
interface Token { file: string; digest: string; directory: string; entry: Entry; expires: number }
interface Receipt { digest: string; files: Record<string, { size: number; mtimeMs: number }>; semanticValidated?: boolean }
const DIGEST = /^[a-f0-9]{64}$/;
const OFFICIAL_WORDS = 'genshinwords.words.';
let state: State | undefined;
let initialization: Promise<void> | undefined;
const tokens = new Map<string, Token>();
let importQueue: Promise<unknown> = Promise.resolve();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const appVersion = () => app?.getVersion?.() ?? applicationVersion;
function rootPath(): string {
  if (typeof paths.getContentPackagesDir === 'function') return path.resolve(paths.getContentPackagesDir());
  const progress = paths.getProgressDbPath();
  const profile = progress === ':memory:' ? path.dirname(paths.getReadingPackagesDir()) : path.dirname(progress);
  return path.resolve(profile, 'content-packages');
}
function safePath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..') ||
    relative.includes(':') || path.isAbsolute(relative)) throw new Error('素材资源路径无效。');
  const file = path.resolve(root, relative), rel = path.relative(path.resolve(root), file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('素材资源越出包目录。');
  return file;
}
function removeTemporary(file: string, store: State): void {
  const resolved = path.resolve(file), rel = path.relative(store.root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/^(?:staging|cache|revisions)[\\/]/.test(rel))
    throw new Error('拒绝删除包目录之外的临时文件。');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function atomicJson(file: string, value: unknown): void {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, 'wx'); fs.writeFileSync(handle, JSON.stringify(value), 'utf8'); fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined; fs.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function parseRegistry(raw: string): Registry {
  const value = JSON.parse(raw) as Registry;
  if (!value || value.formatVersion !== 1 || !Array.isArray(value.active) || !Array.isArray(value.pending) || !Array.isArray(value.revisions))
    throw new Error('素材包登记损坏。');
  for (const entries of [value.active, value.pending, value.revisions]) for (const entry of entries) {
    if (!entry || !DIGEST.test(entry.digest) || !entry.header || entry.header.format !== 'genshinwords.content' || entry.header.formatVersion !== 1 ||
      !entry.header.manifest || typeof entry.header.manifest.id !== 'string' || !entry.header.manifest.id ||
      !['base', 'materials', 'words'].includes(entry.header.manifest.kind) || !Array.isArray(entry.header.entries)) throw new Error('素材包版本登记损坏。');
    compareVersions(entry.header.manifest.version, entry.header.manifest.version);
    if (createHash('sha256').update(canonical(entry.header)).digest('hex') !== entry.digest) throw new Error('素材包登记指纹不一致。');
  }
  for (const entries of [value.active, value.pending]) {
    if (new Set(entries.map(entry => entry.header.manifest.id)).size !== entries.length || entries.filter(entry => entry.header.manifest.kind === 'base').length > 1)
      throw new Error('素材包活动目录存在重复编号。');
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function writeRegistry(store: State, registry: Registry): void {
  const file = path.join(store.root, 'registry.json');
  if (fs.existsSync(file)) {
    try { const old = fs.readFileSync(file, 'utf8'); parseRegistry(old); atomicJson(path.join(store.root, 'registry.backup.json'), JSON.parse(old)); }
    catch { /* Preserve the last intact backup. */ }
  }
  atomicJson(file, registry);
}
function info(entry: Entry, status: ContentPackageInfo['status'] = 'active', error?: string, data?: WordPackageData | MaterialPackageData): ContentPackageInfo {
  const manifest = entry.header.manifest;
  return { ...manifest, formatVersion: 1, builtIn: entry.builtIn, status, counts: { files: entry.header.entries.length,
    ...(manifest.kind === 'words' && data ? { books: (data as WordPackageData).books.length,
      words: new Set((data as WordPackageData).books.flatMap(book => book.lemmas.map(lemma => lemma.toLowerCase()))).size } : {}),
    ...(manifest.kind === 'materials' && data ? { chapters: (data as MaterialPackageData).chapters.length } : {}) },
    ...(error ? { message: error } : {}) };
}
function getState(fallback?: string): State {
  const root = rootPath();
  if (state?.root === root) { if (fallback && !state.fallback) state.fallback = path.resolve(fallback); return state; }
  fs.mkdirSync(root, { recursive: true });
  state = { root, fallback: fallback ? path.resolve(fallback) : typeof paths.getBundledContentDir === 'function' ? paths.getBundledContentDir() : null,
    registry: { formatVersion: 1, active: [], pending: [], revisions: [] }, active: [], errors: [], prepared: false, opened: false, effective: null, managedBase: null };
  tokens.clear(); initialization = undefined;
  for (const name of ['registry.json', 'registry.backup.json']) {
    const file = path.join(root, name); if (!fs.existsSync(file)) continue;
    try { state.registry = parseRegistry(fs.readFileSync(file, 'utf8')); break; }
    catch (error) { state.errors.push({ id: 'content-registry', name: '素材包目录', kind: 'base', version: '', formatVersion: 1, builtIn: false,
      status: 'error', counts: {}, message: message(error) }); }
  }
  return state;
}
function revisionDirectory(store: State, digest: string): string {
  if (!DIGEST.test(digest)) throw new Error('素材包存档编号无效。');
  return path.join(store.root, 'revisions', digest);
}
function fileHash(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), handle = fs.openSync(file, 'r');
  try { let count: number; while ((count = fs.readSync(handle, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(handle); }
  return hash.digest('hex');
}
function writeReceipt(entry: Entry, directory: string): void {
  const files: Receipt['files'] = Object.create(null);
  for (const item of entry.header.entries) {
    const stat = fs.lstatSync(safePath(directory, item.path));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size) throw new Error('素材包资源不完整：' + item.path);
    files[item.path] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  atomicJson(path.join(directory, '.verified.json'), { digest: entry.digest, files });
}
function loadRevision(store: State, entry: Entry, directory = revisionDirectory(store, entry.digest), verify = true, fullMedia = false): ContentRevision {
  let receipt: Receipt | undefined;
  try { receipt = JSON.parse(fs.readFileSync(path.join(directory, '.verified.json'), 'utf8')); } catch { /* Fully validate older archives once. */ }
  const cached = receipt?.digest === entry.digest && receipt.files && typeof receipt.files === 'object';
  for (const item of entry.header.entries) {
    // Imports validate every byte. Startup checks the immutable receipt and critical databases/data;
    // media is checked against its receipt when accessed, without rereading gigabytes every launch.
    if (cached && !fullMedia && !['content.db', 'materials.db', 'data.json'].includes(item.path)) continue;
    const file = safePath(directory, item.path), stat = fs.lstatSync(file);
    const stamp = cached ? receipt.files[item.path] : undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size ||
      (verify && (!stamp || stamp.size !== stat.size || stamp.mtimeMs !== stat.mtimeMs) && fileHash(file) !== item.sha256))
      throw new Error('素材包文件缺失或损坏：' + item.path);
  }
  if (!cached) writeReceipt(entry, directory);
  const revision: ContentRevision = { ...entry, directory };
  if (entry.header.manifest.kind !== 'base') {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'data.json'), 'utf8'));
    revision.data = entry.header.manifest.kind === 'words' ? validateWordPackageData(raw) : validateMaterialPackageData(raw);
  }
  return revision;
}
function selectedEntries(store: State, incoming?: Entry): Entry[] {
  const selected = [...store.registry.active];
  for (const entry of [...store.registry.pending, ...(incoming ? [incoming] : [])]) {
    const index = selected.findIndex(item => item.header.manifest.id === entry.header.manifest.id ||
      item.header.manifest.kind === 'base' && entry.header.manifest.kind === 'base');
    if (index < 0) selected.push(entry); else selected[index] = entry;
  }
  return selected;
}
function dependencies(entries: Entry[]): void {
  for (const entry of entries) {
    const manifest = entry.header.manifest;
    if (compareVersions(appVersion(), manifest.minAppVersion) < 0 || manifest.maxAppVersion && compareVersions(appVersion(), manifest.maxAppVersion) > 0)
      throw new Error('素材包与当前应用版本不兼容：' + manifest.name);
    for (const dependency of manifest.dependencies ?? []) {
      const target = entries.find(item => item.header.manifest.id === dependency.id);
      if (!target || compareVersions(target.header.manifest.version, dependency.minVersion) < 0)
        throw new Error('缺少素材包依赖或版本过低：' + dependency.id + ' >= ' + dependency.minVersion);
    }
  }
}
function actionFor(store: State, entry: Entry): 'install' | 'upgrade' | 'unchanged' {
  const manifest = entry.header.manifest;
  const known = store.registry.revisions.filter(item => item.header.manifest.id === manifest.id);
  for (const old of known) {
    if (old.header.manifest.kind !== manifest.kind) throw new Error('同一包编号不能改变包类型。');
    if (old.header.manifest.version === manifest.version && old.digest !== entry.digest) throw new Error('同一包版本内容不同，请提升版本号。');
  }
  const current = [...store.registry.active, ...store.registry.pending].filter(item => item.header.manifest.id === manifest.id)
    .sort((a, b) => compareVersions(b.header.manifest.version, a.header.manifest.version))[0];
  if (!current) return 'install';
  const comparison = compareVersions(manifest.version, current.header.manifest.version);
  if (comparison < 0) throw new Error('不能安装更低版本的素材包。');
  return comparison === 0 ? 'unchanged' : 'upgrade';
}
function materialHistory(store: State, selected: ContentRevision[]): ContentRevision[] {
  const histories: ContentRevision[] = [];
  for (const entry of store.registry.revisions) {
    if (!entry.activated || entry.header.manifest.kind !== 'materials' || selected.some(item => item.digest === entry.digest) ||
      !selected.some(item => item.header.manifest.id === entry.header.manifest.id)) continue;
    try { histories.push(loadRevision(store, entry)); }
    catch (error) { throw Object.assign(new Error('历史素材存档不可用：' + message(error)), { packageId: entry.header.manifest.id }); }
  }
  return histories.sort((a, b) => compareVersions(a.header.manifest.version, b.header.manifest.version));
}
function prepareSet(store: State, entries: Entry[], override?: { digest: string; directory: string }): { revisions: ContentRevision[]; base: string | null; effective: string } {
  const raw = getActiveRawResourceRevision();
  dependencies(raw ? entries.filter(entry => entry.header.manifest.kind !== 'base') : entries);
  const revisions = entries.map(entry => loadRevision(store, entry, override?.digest === entry.digest ? override.directory : undefined));
  const managedBase = revisions.find(item => item.header.manifest.kind === 'base');
  const base = raw ?? managedBase;
  const baseFile = base ? path.join(base.directory, 'content.db') : store.fallback ? path.join(store.fallback, 'content.db') : '';
  if (!baseFile || !fs.existsSync(baseFile)) {
    if (!entries.length) return { revisions, base: null, effective: baseFile };
    throw new Error('请先安装完整基础素材包，再导入词书或素材增补。');
  }
  if (base && !fs.existsSync(path.join(base.directory, 'materials.db'))) throw new Error('基础素材包缺少 materials.db。');
  const history = materialHistory(store, revisions);
  for (const revision of revisions) validateMaterialHistory(revision, history);
  const previousBase = store.registry.active.find(item => item.header.manifest.kind === 'base');
  const previousDirectory = previousBase ? revisionDirectory(store, previousBase.digest) : raw?.directory ?? store.fallback;
  const previousFile = previousDirectory ? path.join(previousDirectory, 'content.db') : undefined;
  if (managedBase) {
    const receiptFile = path.join(managedBase.directory, '.verified.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Receipt;
    const previousMaterials = previousDirectory ? path.join(previousDirectory, 'materials.db') : undefined;
    validateBaseDatabase(path.join(managedBase.directory, 'content.db'), previousFile, !receipt.semanticValidated);
    validateMaterialsDatabase(path.join(managedBase.directory, 'materials.db'), previousMaterials, !receipt.semanticValidated);
    if (!receipt.semanticValidated) { validateBaseMedia(managedBase); receipt.semanticValidated = true; atomicJson(receiptFile, receipt); }
  }
  const overlays = revisions.filter(item => item.header.manifest.kind !== 'base');
  if (!overlays.length && !base) return { revisions, base: null, effective: baseFile };
  if (!base) validateBaseDatabase(baseFile);
  const stat = fs.statSync(baseFile);
  const key = createHash('sha256').update(JSON.stringify([base?.digest ?? [baseFile, stat.size, stat.mtimeMs], overlays.map(item => item.digest), history.map(item => item.digest)])).digest('hex');
  const cache = path.join(store.root, 'cache'); fs.mkdirSync(cache, { recursive: true });
  const destination = path.join(cache, key + '.db');
  const cacheStamp = destination + '.stamp.json';
  if (fs.existsSync(destination)) {
    let intact = false;
    try {
      const stamp = JSON.parse(fs.readFileSync(cacheStamp, 'utf8')), actual = fs.statSync(destination);
      intact = stamp.size === actual.size && stamp.mtimeMs === actual.mtimeMs;
    } catch { /* Recreate old or externally modified derived files. */ }
    if (!intact) removeTemporary(destination, store);
  }
  if (!fs.existsSync(destination)) {
    const temporary = path.join(cache, randomUUID() + '.tmp');
    try { buildDerivedContent(temporary, baseFile, overlays, history, base); fs.renameSync(temporary, destination); atomicJson(cacheStamp, fs.statSync(destination)); }
    finally { if (fs.existsSync(temporary)) removeTemporary(temporary, store); }
  } else {
    // Rebuild externally damaged caches from the immutable package sources.
    try { validateBaseDatabase(destination); }
    catch {
      removeTemporary(destination, store);
      const temporary = path.join(cache, randomUUID() + '.tmp');
      try { buildDerivedContent(temporary, baseFile, overlays, history, base); fs.renameSync(temporary, destination); atomicJson(cacheStamp, fs.statSync(destination)); }
      finally { if (fs.existsSync(temporary)) removeTemporary(temporary, store); }
    }
  }
  return { revisions, base: raw ? getActiveRawResourcePath() : base?.directory ?? null, effective: destination };
}
function prepareStartup(store: State): void {
  if (store.prepared) return;
  store.prepared = true;
  if (store.registry.pending.length) {
    try {
      const selected = selectedEntries(store), prepared = prepareSet(store, selected);
      const registry = structuredClone(store.registry);
      registry.active = selected.map(entry => ({ ...entry, activated: true })); registry.pending = [];
      for (const entry of registry.revisions) if (selected.some(item => item.digest === entry.digest)) entry.activated = true;
      writeRegistry(store, registry); store.registry = registry;
      store.active = prepared.revisions; store.managedBase = prepared.base; store.effective = prepared.effective; return;
    } catch (error) { for (const entry of store.registry.pending) store.errors.push(info(entry, 'error', '待生效版本未激活，继续使用旧版：' + message(error))); }
  }
  // Isolate a damaged supplemental package while keeping the base and other packages usable.
  const healthy: Entry[] = [];
  for (const entry of store.registry.active) {
    try { loadRevision(store, entry); healthy.push(entry); }
    catch (error) { store.errors.push(info(entry, 'error', message(error))); }
  }
  let remaining = healthy;
  while (true) {
    const broken = remaining.filter(entry => (entry.header.manifest.dependencies ?? []).some(dependency =>
      !remaining.some(item => item.header.manifest.id === dependency.id && compareVersions(item.header.manifest.version, dependency.minVersion) >= 0)));
    if (!broken.length) break;
    for (const entry of broken) store.errors.push(info(entry, 'error', '依赖包不可用。'));
    remaining = remaining.filter(entry => !broken.includes(entry));
  }
  while (true) {
    try {
      const prepared = prepareSet(store, remaining); store.active = prepared.revisions; store.managedBase = prepared.base; store.effective = prepared.effective; break;
    } catch (error) {
      const packageId = (error as { packageId?: string }).packageId;
      const broken = remaining.find(entry => entry.header.manifest.id === packageId);
      if (broken) { store.errors.push(info(broken, 'error', message(error))); remaining = remaining.filter(entry => entry !== broken); continue; }
      for (const entry of remaining) store.errors.push(info(entry, 'error', message(error)));
      store.active = []; store.managedBase = null; store.effective = store.fallback ? path.join(store.fallback, 'content.db') : null; break;
    }
  }
}
function trustFor(store: State, header: ContentPackageHeader, bundled = false): boolean {
  return bundled || store.registry.revisions.some(entry => entry.builtIn && entry.header.manifest.id === header.manifest.id);
}
function archiveStage(store: State, pending: Token): void {
  loadRevision(store, pending.entry, pending.directory, true, true);
  const destination = revisionDirectory(store, pending.digest); fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    try { loadRevision(store, pending.entry, destination, true, true); removeTemporary(pending.directory, store); return; }
    catch { /* Restore exactly the revalidated original revision. */ }
    const corrupt = destination + '.corrupt-' + randomUUID();
    fs.renameSync(destination, corrupt);
    try { fs.renameSync(pending.directory, destination); }
    catch (error) { fs.renameSync(corrupt, destination); throw error; }
    removeTemporary(corrupt, store);
  } else fs.renameSync(pending.directory, destination);
}
function commitPending(store: State, entry: Entry): void {
  const registry = structuredClone(store.registry);
  registry.pending = registry.pending.filter(old => old.header.manifest.id !== entry.header.manifest.id &&
    !(old.header.manifest.kind === 'base' && entry.header.manifest.kind === 'base'));
  registry.pending.push(entry);
  if (!registry.revisions.some(old => old.digest === entry.digest)) registry.revisions.push(entry);
  writeRegistry(store, registry); store.registry = registry;
  store.errors = store.errors.filter(error => error.id !== entry.header.manifest.id && error.id !== 'content-registry');
}
/** Register bundled word books before opening the content database; all user imports remain pending this process. */
export async function initializeContentPackages(): Promise<void> {
  const store = getState();
  if (initialization) return initialization;
  initialization = (async () => {
    await initializeResourceDirectory();
    const folder = store.fallback && path.join(store.fallback, 'word-books');
    if (folder && fs.existsSync(folder)) for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.gwwords')).sort()) {
      try {
        const file = path.join(folder, name), inspected = await inspectContentPackage(file, { appVersion: appVersion() });
        const entry: Entry = { header: inspected.header, digest: inspected.digest, builtIn: true };
        if (entry.header.manifest.kind !== 'words' || !entry.header.manifest.id.startsWith(OFFICIAL_WORDS) ||
          !inspected.data || (inspected.data as WordPackageData).books.length !== 1 ||
          entry.header.manifest.id !== OFFICIAL_WORDS + (inspected.data as WordPackageData).books[0].id) throw new Error('内置词书包身份不正确。');
        const existing = [...store.registry.active, ...store.registry.pending].find(old => old.header.manifest.id === entry.header.manifest.id);
        if (existing && compareVersions(existing.header.manifest.version, entry.header.manifest.version) > 0) continue;
        if (existing?.digest === entry.digest) {
          try { loadRevision(store, existing); continue; } catch { /* Repair a damaged built-in revision from its bundled source. */ }
        }
        actionFor(store, entry);
        const directory = path.join(store.root, 'staging', randomUUID()); fs.mkdirSync(path.dirname(directory), { recursive: true });
        await extractContentPackage(file, directory, { appVersion: appVersion() });
        writeReceipt(entry, directory);
        archiveStage(store, { file, directory, entry, digest: entry.digest, expires: 0 }); commitPending(store, entry);
      } catch (error) { store.errors.push({ id: OFFICIAL_WORDS + name.replace(/\.gwwords$/, ''), name: '内置词书 ' + name, kind: 'words', version: '', formatVersion: 1, builtIn: true, status: 'error', counts: {}, message: message(error) }); }
    }
    if (!store.opened) { store.prepared = false; prepareStartup(store); }
  })();
  return initialization;
}
export function getManagedBaseDirectory(fallback: string): string {
  const store = getState(fallback); prepareStartup(store); return store.managedBase ?? fallback;
}
export function getEffectiveContentDbPath(baseFile: string): string {
  const store = getState(path.dirname(baseFile)); prepareStartup(store); store.opened = true; return store.effective || baseFile;
}
export function getManagedMediaPath(relative: string, audio: boolean): string | null {
  if (typeof relative !== 'string') throw new Error('素材资源路径无效。');
  const match = /^gwcontent\/([a-f0-9]{64})\/(.+)$/.exec(relative);
  if (!match || !(audio ? match[2].startsWith('audio/') : match[2].startsWith('images/'))) throw new Error('素材包媒体命名空间无效。');
  const raw = resolveRawResourceMedia(match[1], match[2]);
  if (raw !== undefined) return raw;
  const store = getState(); prepareStartup(store);
  const file = safePath(revisionDirectory(store, match[1]), match[2]);
  const entry = store.registry.revisions.find(entry => entry.digest === match[1]);
  if (!entry || !entry.header.entries.some(item => item.path === match[2])) return null;
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file), expected = entry.header.entries.find(item => item.path === match[2])!;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) return null;
  let receipt: Receipt | undefined;
  try { receipt = JSON.parse(fs.readFileSync(path.join(revisionDirectory(store, match[1]), '.verified.json'), 'utf8')); } catch { /* Verify the actual bytes. */ }
  const stamp = receipt?.digest === entry.digest ? receipt.files?.[match[2]] : undefined;
  return stamp?.size === stat.size && stamp.mtimeMs === stat.mtimeMs || fileHash(file) === expected.sha256 ? file : null;
}
export function listContentPackages(): ContentPackageInfo[] {
  const store = getState(); prepareStartup(store);
  const active = store.active.map(revision => ({ ...info(revision), counts: { files: revision.header.entries.length,
    ...(revision.header.manifest.kind === 'words' ? { books: (revision.data as import('../shared/content-package').WordPackageData).books.length,
      words: new Set((revision.data as import('../shared/content-package').WordPackageData).books.flatMap(book => book.lemmas)).size } : {}),
    ...(revision.header.manifest.kind === 'materials' ? { chapters: (revision.data as import('../shared/content-package').MaterialPackageData).chapters.length } : {}) },
    revisions: store.registry.revisions.filter(entry => entry.header.manifest.id === revision.header.manifest.id).map(entry => entry.header.manifest.version),
    ...(revision.header.manifest.kind === 'base' && getActiveRawResourceRevision() ? {
      message: '当前基础资源来自外部目录，此基础包保留供切换。',
      description: '当前基础资源来自外部目录，此基础包保留供切换。',
    } : {}) }));
  const pending = store.registry.pending.filter(entry => !store.errors.some(error => error.id === entry.header.manifest.id)).map(entry => {
    try { return info(entry, 'pending', undefined, loadRevision(store, entry).data); }
    catch (error) { return info(entry, 'error', message(error)); }
  });
  const missing: ContentPackageInfo[] = !store.effective || !fs.existsSync(store.effective) ? [{ id: 'base-resources-missing', name: '基础素材尚未安装',
    kind: 'base', version: '—', formatVersion: 1, builtIn: false, status: 'error', counts: {}, message: '请选择资源目录，或导入完整 .gwcontent 基础素材包后按提示启用。' }] : [];
  const legacy: ContentPackageInfo[] = !missing.length && !getActiveRawResourceRevision() && !store.active.some(entry => entry.header.manifest.kind === 'base') &&
    store.fallback && fs.existsSync(path.join(store.fallback, 'content.db')) ? [{ id: 'legacy-base-resources', name: '旧内置基础素材',
      kind: 'base', version: '未登记', formatVersion: 0, builtIn: true, status: 'active', counts: {},
      description: '旧布局尚无独立基础素材包版本。', message: '当前使用旧版完整资源目录，基础素材版本未登记。' }] : [];
  return [...legacy, ...active, ...pending, ...store.errors, ...missing];
}
export async function previewContentPackageFile(file: string): Promise<ContentPackagePreview> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择本机素材包文件。');
  const store = getState(); prepareStartup(store);
  for (const [token, item] of tokens) if (item.expires < Date.now()) { removeTemporary(item.directory, store); tokens.delete(token); }
  while (tokens.size >= 8) {
    const first = tokens.keys().next().value!, old = tokens.get(first)!; removeTemporary(old.directory, store); tokens.delete(first);
  }
  const inspected = await inspectContentPackage(file, { appVersion: appVersion() });
  const entry: Entry = { header: inspected.header, digest: inspected.digest, builtIn: trustFor(store, inspected.header) };
  const action = actionFor(store, entry);
  const directory = path.join(store.root, 'staging', randomUUID()); fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    const extracted = await extractContentPackage(file, directory, { appVersion: appVersion() });
    if (extracted.digest !== inspected.digest) throw new Error('素材包在校验期间发生变化，请重新选择。');
    writeReceipt(entry, directory);
    const history = store.registry.revisions.filter(old => old.digest !== entry.digest && old.header.manifest.id === entry.header.manifest.id && old.header.manifest.kind === 'materials')
      .map(old => loadRevision(store, old));
    validateMaterialHistory(loadRevision(store, entry, directory), history);
    prepareSet(store, selectedEntries(store, entry), { digest: entry.digest, directory });
    const token = randomUUID(); tokens.set(token, { file, digest: entry.digest, directory, entry, expires: Date.now() + 10 * 60_000 });
    const current = [...store.registry.pending, ...store.registry.active].find(old => old.header.manifest.id === entry.header.manifest.id);
    const pending = store.registry.pending.some(old => old.digest === entry.digest);
    return { token, package: info(entry, action === 'unchanged' && !pending ? 'active' : 'pending', undefined, inspected.data), action,
      ...(current ? { currentVersion: current.header.manifest.version } : {}),
      warnings: entry.header.manifest.kind === 'words' ? ['新版词表可能增加或移除选词；已有学习记录、收藏和奖励会保留。'] : [],
      restartRequired: action !== 'unchanged' || pending };
  } catch (error) { if (fs.existsSync(directory)) removeTemporary(directory, store); throw error; }
}
async function commitContentPackage(token: string): Promise<ContentPackageImportResult> {
  const store = getState(), pending = tokens.get(token);
  if (!pending || pending.expires < Date.now()) throw new Error('素材包预览已过期，请重新选择。');
  tokens.delete(token);
  try {
    const inspected = await inspectContentPackage(pending.file, { appVersion: appVersion() });
    if (inspected.digest !== pending.digest) throw new Error('素材包在预览后发生变化，请重新选择。');
    const action = actionFor(store, pending.entry);
    prepareSet(store, selectedEntries(store, pending.entry), { digest: pending.digest, directory: pending.directory });
    archiveStage(store, pending);
    const alreadyActive = store.registry.active.some(entry => entry.digest === pending.digest);
    const usableActive = alreadyActive && store.active.some(entry => entry.digest === pending.digest);
    const alreadyPending = store.registry.pending.some(entry => entry.digest === pending.digest);
    if ((!alreadyActive || !usableActive) && !alreadyPending) commitPending(store, pending.entry);
    store.errors = store.errors.filter(error => error.id !== pending.entry.header.manifest.id);
    return { action: action === 'install' ? 'installed' : action === 'upgrade' ? 'upgraded' : 'unchanged',
      package: info(pending.entry, usableActive ? 'active' : 'pending', undefined, inspected.data), restartRequired: !usableActive };
  } finally { if (fs.existsSync(pending.directory)) removeTemporary(pending.directory, store); }
}
export function importContentPackage(token: string): Promise<ContentPackageImportResult> {
  const result = importQueue.then(() => commitContentPackage(token));
  importQueue = result.catch(() => undefined);
  return result;
}

/** Identity checks compare the underlying base, excluding optional material overlays. */
export function getCurrentContentResourceFiles(): { content: string | null; materials: string | null } {
  const store = getState(), raw = getRawResourceIdentityFiles();
  if (raw) return raw;
  prepareStartup(store);
  const base = store.active.find(revision => revision.header.manifest.kind === 'base');
  const directory = base?.directory ?? store.fallback;
  const existing = (name: string) => directory && fs.existsSync(path.join(directory, name)) ? path.join(directory, name) : null;
  return { content: existing('content.db'), materials: existing('materials.db') };
}

async function hotActivate(raw?: RawResourceRevision | null): Promise<void> {
  await initializeContentPackages();
  const store = getState(), previous = getCurrentContentResourceFiles();
  if (raw === undefined && getSelectedRawResourceRevision() && !getActiveRawResourceRevision())
    throw new Error('当前资源目录不可用，请重新指定资源目录或载入完整基础素材包。');
  const old: State = { ...store, registry: structuredClone(store.registry), active: [...store.active], errors: [...store.errors] };
  const selection = raw === undefined ? undefined : beginRawResourceSelection(raw);
  const content = await import('./content-db');
  const wasOpen = Boolean(content.contentDb);
  let closed = false, wroteRegistry = false;
  try {
    const selected = selectedEntries(store), prepared = prepareSet(store, selected);
    if (!prepared.effective || !fs.existsSync(prepared.effective)) throw new Error('目录中没有可用的基础素材数据库。');
    const nextRaw = getActiveRawResourceRevision();
    const nextBase = nextRaw ?? prepared.revisions.find(revision => revision.header.manifest.kind === 'base');
    if (raw === null && !nextBase) throw new Error('切换资源来源前，请先准备完整基础素材包。');
    if (raw !== undefined && nextBase) {
      const previousContent = raw && previous.content && path.resolve(previous.content).toLowerCase() === path.join(raw.source, 'content.db').toLowerCase() ? undefined : previous.content ?? undefined;
      const previousMaterials = raw && previous.materials && path.resolve(previous.materials).toLowerCase() === path.join(raw.source, 'materials.db').toLowerCase() ? undefined : previous.materials ?? undefined;
      validateBaseDatabase(path.join(nextBase.directory, 'content.db'), previousContent);
      validateMaterialsDatabase(path.join(nextBase.directory, 'materials.db'), previousMaterials);
    }
    if (raw) validatePreparedRawResourceRevision(raw);
    const registry = structuredClone(store.registry);
    registry.active = selected.map(entry => ({ ...entry, activated: true })); registry.pending = [];
    for (const entry of registry.revisions) if (selected.some(item => item.digest === entry.digest)) entry.activated = true;
    content.closeContentDb(); closed = true;
    store.active = prepared.revisions; store.managedBase = prepared.base; store.effective = prepared.effective;
    store.prepared = true; store.opened = false;
    if (!content.openContentDb()) throw new Error('新目录的基础素材数据库无法打开。');
    writeRegistry(store, registry); wroteRegistry = true;
    selection?.commit();
    store.registry = registry;
    store.errors = store.errors.filter(error => !selected.some(entry => entry.header.manifest.id === error.id));
  } catch (error) {
    if (closed) content.closeContentDb();
    selection?.rollback();
    Object.assign(store, old);
    if (wroteRegistry) writeRegistry(store, old.registry);
    if (closed && wasOpen) content.openContentDb();
    throw error;
  }
}
/** Activate imported packages in this process. A new base can atomically replace the selected raw source. */
export function activatePendingContentPackages(options: { clearRaw?: boolean } = {}): Promise<void> {
  const result = importQueue.then(() => hotActivate(options.clearRaw ? null : undefined));
  importQueue = result.catch(() => undefined); return result;
}
/** Internal RAW entry point shares the same transaction queue as package imports and hot activation. */
export function activateContentPackagesWithRawRevision(revision: RawResourceRevision): Promise<void> {
  const result = importQueue.then(() => hotActivate(revision));
  importQueue = result.catch(() => undefined); return result;
}

/** Directory loading may discard its own failed pending import without disturbing other packages. */
export function discardPendingContentPackage(id: string, reason?: string): Promise<void> {
  const result = importQueue.then(() => {
    const store = getState(), rejected = store.registry.pending.find(entry => entry.header.manifest.id === id);
    if (!rejected) return;
    const registry = structuredClone(store.registry); registry.pending = registry.pending.filter(entry => entry.header.manifest.id !== id);
    writeRegistry(store, registry); store.registry = registry;
    if (reason) store.errors.push(info(rejected, 'error', reason));
  });
  importQueue = result.catch(() => undefined); return result;
}
