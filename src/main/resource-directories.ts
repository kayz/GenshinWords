import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { app } from 'electron';
import { version as applicationVersion } from '../../package.json';
import { getContentPackagesDir } from './paths';
import { listManagedContentPackages, previewManagedContentPackage, importManagedContentPackage } from './content-management';
import { activatePendingContentPackages, discardPendingContentPackage } from './content-package-store';
import { inspectContentPackage, canonicalContentPackageJson, validateContentPackageHeader,
  CONTENT_PACKAGE_MAGIC, CONTENT_PACKAGE_LIMITS } from './content-package-format';
import { decodeReadingPackage, compareReadingPackageVersions as compareVersions, READING_PACKAGE_LIMITS } from './reading-package-format';
import { prepareRawResourceDirectory, activateRawResourceDirectory, hasRawResourceDirectory, getRawResourceDirectoryStatus } from './resource-directory-config';
import type { ContentPackageInfo, MaterialPackageData, WordPackageData } from '../shared/content-package';
import type { ResourceDirectoryPreview, ResourceDirectoryPackage, ResourceDirectoryStatus, ResourceDirectoryLoadResult,
  ResourceDirectoryItemResult, ResourceDirectoryRawInfo } from '../shared/resource-directory';

/** Scan only recognized shallow layouts; never recurse into a media or arbitrary author tree. */
export const RESOURCE_DIRECTORY_LIMITS = Object.freeze({ depth: 2, directories: 21, directoryEntries: 4096,
  packages: 128, totalBytes: 32 * 1024 ** 3, previews: 8, tokenMs: 30 * 60_000 });
const standardDirectories = new Set(['content', 'reading', 'word-books', 'packages']);
const extensions = new Set(['.gwcontent', '.gwwords', '.gwreading']);
interface Candidate { file: string; item: ResourceDirectoryPackage; digest?: string }
interface Prepared { preview: ResourceDirectoryPreview; root: string; candidates: Candidate[]; rawToken?: string; expires: number }
const prepared = new Map<string, Prepared>();
let queue: Promise<unknown> = Promise.resolve();
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const version = (): string => app?.getVersion?.() ?? applicationVersion;
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const pending = queue.then(operation); queue = pending.catch(() => undefined); return pending;
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function assertRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, fs.realpathSync(root)))
    throw new Error('资源目录已移动或变成链接，请重新选择。');
}
function assertSource(root: string, file: string): fs.Stats {
  assertRoot(root);
  if (!contained(root, file) || file === root) throw new Error('内容包越出所选目录。');
  const parts = path.relative(root, file).split(path.sep); let cursor = root; let stat: fs.Stats;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]); stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('目录扫描不跟随符号链接，内容包必须是目录内的普通文件。');
  }
  if (!contained(root, fs.realpathSync(file))) throw new Error('内容包真实路径越出所选目录。');
  return stat!;
}
function configFile(): string { return path.join(path.dirname(path.resolve(getContentPackagesDir())), 'resource-package-directory.json'); }
function readConfiguration(): { directory: string | null; error?: string } {
  const file = configFile();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('包目录配置无效。');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.formatVersion !== 1 || typeof value.directory !== 'string' || !path.isAbsolute(value.directory) || value.directory.length > 32768)
      throw new Error('包目录配置无效。');
    return { directory: value.directory };
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { directory: null } : { directory: null, error: message(error) }; }
}
function writeConfiguration(directory: string): void {
  const file = configFile(); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), randomUUID() + '.tmp'); let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, 'wx'); fs.writeFileSync(handle, JSON.stringify({ formatVersion: 1, directory }), 'utf8'); fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined; fs.renameSync(temporary, file);
  } finally { if (handle !== undefined) fs.closeSync(handle); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function getResourceDirectoryStatus(): ResourceDirectoryStatus {
  const config = readConfiguration(); let available = false;
  if (config.directory) try { assertRoot(config.directory); available = true; } catch { /* Retain the saved path so it can be rescanned later. */ }
  return { raw: getRawResourceDirectoryStatus(), packageDirectory: config.directory, packageDirectoryAvailable: available,
    ...(config.error ? { message: config.error } : config.directory && !available ? { message: '已保存的包目录暂时不可用；已载入的缓存仍可继续使用。' } : {}) };
}
async function scan(root: string): Promise<{ files: string[]; warnings: string[] }> {
  const files: string[] = [], warnings: string[] = [], directories = [{ directory: root, depth: 0 }];
  let seen = 0, entries = 0, totalBytes = 0;
  for (let cursor = 0; cursor < directories.length; cursor++) {
    const current = directories[cursor]; if (++seen > RESOURCE_DIRECTORY_LIMITS.directories) { warnings.push('已达到目录扫描数量限制，剩余目录未扫描。'); break; }
    let handle: fs.Dir;
    try {
      if (current.directory !== root) {
        const stat = fs.lstatSync(current.directory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !contained(root, fs.realpathSync(current.directory))) { warnings.push('已跳过链接或越界目录：' + path.relative(root, current.directory)); continue; }
      }
      handle = await fs.promises.opendir(current.directory);
    } catch (error) {
      if (current.directory === root) throw error;
      warnings.push('无法扫描子目录，已继续检查其他内容：' + path.relative(root, current.directory) + '（' + message(error) + '）'); continue;
    }
    for await (const entry of handle) {
      if (++entries > RESOURCE_DIRECTORY_LIMITS.directoryEntries) { warnings.push('已达到目录条目扫描限制，请将所需包放在更小的专用目录。'); return { files, warnings }; }
      const file = path.join(current.directory, entry.name);
      if (extensions.has(path.extname(entry.name).toLowerCase())) {
        if (files.length >= RESOURCE_DIRECTORY_LIMITS.packages) { warnings.push('最多检查128个内容包，其余文件未扫描。'); continue; }
        let size = 0; try { size = fs.lstatSync(file).size; } catch { /* Report this individual file below. */ }
        if (totalBytes + size > RESOURCE_DIRECTORY_LIMITS.totalBytes) { warnings.push('内容包总大小超过32GiB，已跳过：' + path.relative(root, file)); continue; }
        totalBytes += size; files.push(file);
      } else if (standardDirectories.has(entry.name.toLowerCase()) && current.depth < RESOURCE_DIRECTORY_LIMITS.depth) {
        if (entry.isSymbolicLink()) warnings.push('已跳过符号链接目录：' + path.relative(root, file));
        else if (entry.isDirectory()) directories.push({ directory: file, depth: current.depth + 1 });
      }
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), warnings };
}
async function inspect(root: string, file: string): Promise<{ info: ContentPackageInfo; digest: string }> {
  const stat = assertSource(root, file);
  if (path.extname(file).toLowerCase() === '.gwreading') {
    if (stat.size > READING_PACKAGE_LIMITS.compressedBytes) throw new Error('阅读包文件过大。');
    const value = decodeReadingPackage(await fs.promises.readFile(file), { appVersion: version() });
    const after = assertSource(root, file);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error('扫描期间内容包发生变化。');
    const manifest = value.data.manifest;
    return { digest: value.digest, info: { ...manifest, name: manifest.name, kind: 'reading', formatVersion: 1, builtIn: false, status: 'active',
      counts: { readings: value.units.length, questions: Object.keys(value.questionFingerprints).length } } };
  }
  const value = await inspectContentPackage(file, { appVersion: version() });
  assertSource(root, file);
  if (path.extname(file).toLowerCase() === '.gwwords' && value.header.manifest.kind !== 'words') throw new Error('.gwwords文件必须是词书包。');
  const data = value.data;
  return { digest: value.digest, info: { ...value.header.manifest, formatVersion: 1, builtIn: false, status: 'pending', counts: { files: value.header.entries.length,
    ...(value.header.manifest.kind === 'words' && data ? { books: (data as WordPackageData).books.length,
      words: new Set((data as WordPackageData).books.flatMap(book => book.lemmas)).size } : {}),
    ...(value.header.manifest.kind === 'materials' && data ? { chapters: (data as MaterialPackageData).chapters.length } : {}) } } };
}
function failCandidate(candidate: Candidate, text: string, status: 'error' | 'skipped' = 'error'): void {
  candidate.item.status = status; candidate.item.message = text;
}
function selectVersions(candidates: Candidate[], current: ContentPackageInfo[], rawSelected: boolean): void {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) if (candidate.item.package) {
    const id = candidate.item.package.id; const list = groups.get(id) ?? []; list.push(candidate); groups.set(id, list);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => compareVersions(b.item.package!.version, a.item.package!.version));
    const highest = sorted[0], info = highest.item.package!;
    const peers = sorted.filter(item => compareVersions(item.item.package!.version, info.version) === 0);
    if (new Set(group.map(item => item.item.package!.kind)).size > 1 || new Set(peers.map(item => item.digest)).size > 1) {
      for (const item of group) failCandidate(item, '同一包编号的类型或最高版本内容冲突；请保留唯一来源后重新扫描。'); continue;
    }
    for (const item of sorted.slice(1)) failCandidate(item, '已选择同编号的最高有效版本：' + info.version, 'skipped');
    if (rawSelected && info.kind === 'base') { failCandidate(highest, '本目录含有效原始资源，优先使用原始目录；此基础包不会覆盖它。', 'skipped'); continue; }
    const installed = current.filter(item => item.id === info.id && item.status !== 'error').sort((a, b) => compareVersions(b.version, a.version))[0];
    if (installed && installed.formatVersion > 0) {
      if (installed.kind !== info.kind) { failCandidate(highest, '同一包编号不能改变包类型。'); continue; }
      const comparison = compareVersions(info.version, installed.version);
      if (comparison < 0) { failCandidate(highest, '已安装更高版本 ' + installed.version + '，不会降级。'); continue; }
      highest.item.action = comparison === 0 ? 'unchanged' : 'upgrade';
    } else highest.item.action = 'install';
  }
  const bases = candidates.filter(item => item.item.status === 'ready' && item.item.package?.kind === 'base');
  if (bases.length > 1) for (const item of bases) failCandidate(item, '目录包含多个不同编号的基础包，无法确定使用哪一份；请将所需基础包放入单独目录。');
}
function dependencyOrder(candidates: Candidate[], current: ContentPackageInfo[], usingRaw: boolean): Candidate[] {
  const pending = candidates.filter(item => item.item.status === 'ready'), ordered: Candidate[] = [];
  const available = new Map<string, ContentPackageInfo>();
  for (const item of current) if (item.status === 'active' && item.formatVersion > 0 && !(usingRaw && item.kind === 'base')) {
    const previous = available.get(item.id);
    if (!previous || compareVersions(item.version, previous.version) > 0) available.set(item.id, item);
  }
  const rank = (candidate: Candidate) => candidate.item.package!.kind === 'base' ? 0 : candidate.item.package!.kind === 'reading' ? 2 : 1;
  pending.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
  while (pending.length) {
    let progress = false;
    for (let index = 0; index < pending.length;) {
      const candidate = pending[index], info = candidate.item.package!;
      const ready = (info.dependencies ?? []).every(dependency => {
        if (pending.some(item => item.item.package!.id === dependency.id)) return false;
        const target = available.get(dependency.id);
        return target && target.kind !== 'reading' && compareVersions(target.version, dependency.minVersion) >= 0;
      });
      if (!ready) { index++; continue; }
      pending.splice(index, 1); ordered.push(candidate); available.set(info.id, info); progress = true;
    }
    if (!progress) {
      for (const candidate of pending) failCandidate(candidate, '依赖包缺失、版本过低或存在循环；原始目录不能替代有编号及版本要求的基础包依赖。'); break;
    }
  }
  // A reading package has no content dependency and is always loaded after content packages.
  return [...ordered.filter(item => item.item.package!.kind !== 'reading'), ...ordered.filter(item => item.item.package!.kind === 'reading')];
}
async function previewDirectory(directory: string): Promise<ResourceDirectoryPreview> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 32768) throw new Error('请从本机目录选择器选择资源目录。');
  assertRoot(path.resolve(directory));
  const root = fs.realpathSync(directory); assertRoot(root);
  const scanned = await scan(root), warnings = [...scanned.warnings], candidates: Candidate[] = [];
  let raw: ResourceDirectoryRawInfo | null = null, rawToken: string | undefined;
  for (const rawDirectory of [root, path.join(root, 'content')]) {
    if (!fs.existsSync(rawDirectory)) continue;
    if (rawDirectory !== root) {
      const stat = fs.lstatSync(rawDirectory); if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    }
    if (!hasRawResourceDirectory(rawDirectory) && !fs.existsSync(path.join(rawDirectory, 'content.db'))) continue;
    try {
      const result = await prepareRawResourceDirectory(rawDirectory);
      raw = result.raw; rawToken = result.token; warnings.push(...result.warnings); break;
    } catch (error) {
      raw = { path: rawDirectory, name: path.basename(rawDirectory), version: '未登记', wordCount: 0, chapterCount: 0, lineCount: 0, status: 'error', message: message(error) };
      warnings.push('原始资源未通过校验：' + message(error));
    }
  }
  for (const file of scanned.files) {
    const candidate: Candidate = { file, item: { file, relativePath: path.relative(root, file).split(path.sep).join('/'), package: null, status: 'ready' } };
    candidates.push(candidate);
    try { const value = await inspect(root, file); candidate.digest = value.digest; candidate.item.package = value.info; }
    catch (error) { failCandidate(candidate, message(error)); }
  }
  const current = await listManagedContentPackages(), rawSelected = Boolean(rawToken);
  selectVersions(candidates, current, rawSelected);
  const baseSelected = candidates.some(item => item.item.status === 'ready' && item.item.package?.kind === 'base');
  const usingRaw = rawSelected || !baseSelected && getRawResourceDirectoryStatus()?.status === 'active';
  dependencyOrder(candidates, current, usingRaw);
  if (rawSelected && candidates.some(item => item.item.package?.kind === 'base' && item.item.status === 'skipped')) warnings.push('本目录中的基础包已跳过，继续使用直接读取的资源目录。');
  else if (baseSelected && getRawResourceDirectoryStatus()?.status === 'active') warnings.push('成功载入基础包后将替换当前原始资源目录；校验失败时保留原目录。');
  if (scanned.files.length) warnings.push('内容包检查通过后会保存在本机缓存中，原目录文件不会改动。');
  if (scanned.files.length) warnings.push('载入时还会检查当前词库、历史内容编号及实际依赖；单包失败会显示原因，并继续处理其他包。');
  if (!raw && !scanned.files.length) warnings.push('未发现原始资源或支持的内容包。仅扫描所选目录及两层标准 content、reading、word-books、packages 子目录。');
  const token = randomUUID(), preview: ResourceDirectoryPreview = { token, directory: root,
    kind: raw ? scanned.files.length ? 'mixed' : 'raw' : 'packages', raw, packages: candidates.map(item => item.item), warnings,
    canLoad: rawSelected || candidates.some(item => item.item.status === 'ready') };
  const now = Date.now(); for (const [key, value] of prepared) if (value.expires < now) prepared.delete(key);
  while (prepared.size >= RESOURCE_DIRECTORY_LIMITS.previews) prepared.delete(prepared.keys().next().value!);
  prepared.set(token, { preview, root, candidates, rawToken, expires: now + RESOURCE_DIRECTORY_LIMITS.tokenMs });
  return structuredClone(preview);
}
export function previewResourceDirectory(directory: string): Promise<ResourceDirectoryPreview> { return serialize(() => previewDirectory(directory)); }

/** Only the envelope is read here. The delegated importer rechecks every payload byte before committing. */
async function assertUnchanged(root: string, candidate: Candidate): Promise<void> {
  assertSource(root, candidate.file);
  if (candidate.item.package!.kind === 'reading') {
    if ((await inspect(root, candidate.file)).digest !== candidate.digest) throw new Error('内容包在目录预览后发生变化，请重新扫描。');
    return;
  }
  const source = await fs.promises.open(candidate.file, 'r');
  try {
    const read = async (position: number, length: number): Promise<Buffer> => {
      const bytes = Buffer.allocUnsafe(length); let count = 0;
      while (count < length) { const result = await source.read(bytes, count, length - count, position + count); if (!result.bytesRead) throw new Error('内容包头部已截断。'); count += result.bytesRead; }
      return bytes;
    };
    const prefix = await read(0, CONTENT_PACKAGE_MAGIC.length + 4);
    if (!prefix.subarray(0, CONTENT_PACKAGE_MAGIC.length).equals(CONTENT_PACKAGE_MAGIC)) throw new Error('内容包标识已改变。');
    const length = prefix.readUInt32BE(CONTENT_PACKAGE_MAGIC.length);
    if (!length || length > CONTENT_PACKAGE_LIMITS.headerBytes) throw new Error('内容包头部超出限制。');
    const header = validateContentPackageHeader(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(prefix.length, length))), { appVersion: version() });
    const digest = createHash('sha256').update(canonicalContentPackageJson(header), 'utf8').digest('hex');
    if (digest !== candidate.digest) throw new Error('内容包在目录预览后发生变化，请重新扫描。');
  } finally { await source.close(); }
  assertSource(root, candidate.file);
}
async function loadDirectory(selected: Prepared): Promise<ResourceDirectoryLoadResult> {
  assertRoot(selected.root);
  const results: ResourceDirectoryItemResult[] = [], warnings = [...selected.preview.warnings];
  let raw: ResourceDirectoryRawInfo | null = null, changed = false;
  if (selected.rawToken) {
    try { raw = await activateRawResourceDirectory(selected.rawToken); changed = true; }
    catch (error) {
      const detail = '原始资源未切换，继续使用之前的内容：' + message(error);
      raw = { ...selected.preview.raw!, status: 'error', message: detail }; warnings.push(detail);
    }
  }
  const current = await listManagedContentPackages();
  const candidates = structuredClone(selected.candidates);
  const baseSelected = candidates.some(item => item.item.status === 'ready' && item.item.package?.kind === 'base');
  const usingRaw = raw?.status === 'active' || !baseSelected && getRawResourceDirectoryStatus()?.status === 'active';
  const ordered = dependencyOrder(candidates, current, usingRaw);
  for (const candidate of candidates) if (candidate.item.status !== 'ready') results.push({ file: candidate.file,
    ...(candidate.item.package ? { package: candidate.item.package } : {}), status: candidate.item.status, message: candidate.item.message });
  for (const candidate of ordered) {
    let pendingId: string | undefined;
    try {
      const currentPackages = await listManagedContentPackages(), rawActive = getRawResourceDirectoryStatus()?.status === 'active';
      for (const dependency of candidate.item.package!.dependencies ?? []) {
        if (!currentPackages.some(item => item.id === dependency.id && item.status === 'active' && item.formatVersion > 0 && item.kind !== 'reading' &&
          !(rawActive && item.kind === 'base') && compareVersions(item.version, dependency.minVersion) >= 0))
          throw new Error('依赖包未成功载入或版本不满足：' + dependency.id + ' >= ' + dependency.minVersion);
      }
      await assertUnchanged(selected.root, candidate);
      const actual = await previewManagedContentPackage(candidate.file);
      await assertUnchanged(selected.root, candidate);
      const imported = await importManagedContentPackage(actual.token);
      if (imported.package.kind !== 'reading') {
        if (imported.package.status === 'pending') pendingId = imported.package.id;
        await activatePendingContentPackages({ clearRaw: imported.package.kind === 'base' && !selected.rawToken });
        imported.package.status = 'active'; imported.restartRequired = false;
      }
      results.push({ file: candidate.file, package: imported.package, status: imported.action === 'unchanged' ? 'unchanged' : 'loaded' });
      changed = true;
    } catch (error) {
      if (pendingId) try { await discardPendingContentPackage(pendingId, message(error)); }
      catch (cleanup) { warnings.push('无法清除本次未生效的包登记：' + message(cleanup)); }
      results.push({ file: candidate.file, package: candidate.item.package!, status: 'error', message: message(error) });
    }
  }
  if (changed && selected.candidates.length) {
    try { writeConfiguration(selected.root); } catch (error) { warnings.push('内容已载入，但无法保存目录位置：' + message(error)); }
  }
  return { directory: selected.root, status: getResourceDirectoryStatus(), raw, results,
    loadedCount: results.filter(item => item.status === 'loaded' || item.status === 'unchanged').length,
    failedCount: results.filter(item => item.status === 'error').length + (selected.rawToken && raw?.status !== 'active' ? 1 : 0), warnings };
}
export function loadResourceDirectory(token: string): Promise<ResourceDirectoryLoadResult> {
  if (typeof token !== 'string') return Promise.reject(new Error('请先选择并检查资源目录。'));
  const selected = prepared.get(token); prepared.delete(token);
  if (!selected || selected.expires < Date.now()) return Promise.reject(new Error('目录预览已过期或已经使用，请重新扫描。'));
  if (!selected.preview.canLoad) return Promise.reject(new Error('此目录没有可载入的有效资源。'));
  return serialize(() => loadDirectory(selected));
}
export function scanConfiguredResourceDirectory(): Promise<ResourceDirectoryPreview | null> {
  return serialize(async () => {
    const config = readConfiguration();
    if (config.error) throw new Error(config.error);
    const directory = config.directory ?? getRawResourceDirectoryStatus()?.path;
    if (!directory) return null;
    return previewDirectory(directory);
  });
}
