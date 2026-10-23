import { version as programVersion } from '../../package.json';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { getBundledReadingPackagePath, getReadingPackagesDir } from './paths';
import { openProgressDb } from './progress-db';
import { decodeReadingPackage, encodeReadingPackage, compareReadingPackageVersions, READING_PACKAGE_LIMITS } from './reading-package-format';
import type { ValidatedReadingPackage, ReadingPackageParagraphs } from '../shared/reading-package';
import type { ReadingDefinition } from './reading-bank-types';
import type { ReadingPackageInfo, ReadingPackagePreview, ReadingPackageImportResult } from '../shared/reading-package-management';

interface RegistryEntry { id: string; digest: string; info: ReadingPackageInfo }
interface Registry {
  formatVersion: 1; active: RegistryEntry[];
  questions: Record<string, string>; versions: Record<string, Record<string, string>>;
  unitOwners: Record<string, Record<string, string[]>>;
}
interface Revision { validated: ValidatedReadingPackage; units: ReadingDefinition[]; legacyUnits: ReadingDefinition[] }
interface Store {
  root: string; bundle: string | null; registry: Registry; revisions: Map<string, Revision>;
  active: Map<string, Revision>; errors: ReadingPackageInfo[]; initializing: boolean;
}
interface PreviewToken { file: string; digest: string; expires: number }
let currentStore: Store | undefined;
const previews = new Map<string, PreviewToken>();
export const activeReadingUnits: ReadingDefinition[] = [];
export const activeLegacyReadingUnits: ReadingDefinition[] = [];
const DIGEST = /^[a-f0-9]{64}$/;

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function emptyRegistry(): Registry { return { formatVersion: 1, active: [], questions: {}, versions: {}, unitOwners: {} }; }
function safeRecordKey(key: string): boolean { return !Object.prototype.hasOwnProperty.call(Object.prototype, key); }
function revisionFile(store: Store, digest: string): string {
  if (!DIGEST.test(digest)) throw new Error('阅读包版本编号无效。');
  return path.join(store.root, 'revisions', digest + '.gwreading');
}
function readPackage(file: string, checkCompatibility = true): ValidatedReadingPackage {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > READING_PACKAGE_LIMITS.compressedBytes) throw new Error('阅读包文件过大或不是普通文件。');
  return decodeReadingPackage(fs.readFileSync(file), checkCompatibility ? { appVersion: app?.getVersion?.() ?? programVersion } : undefined);
}
function infoFor(value: ValidatedReadingPackage, builtIn: boolean): ReadingPackageInfo {
  return { id: value.data.manifest.id, name: value.data.manifest.name, version: value.data.manifest.version,
    formatVersion: value.data.formatVersion, unitCount: value.units.length,
    questionCount: new Set(value.units.flatMap(unit => unit.questions.map(question => question.id))).size,
    minAppVersion: value.data.manifest.minAppVersion, maxAppVersion: value.data.manifest.maxAppVersion,
    description: value.data.manifest.description, builtIn, status: 'active' };
}
function extension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  throw new Error('阅读包图片格式无效。');
}
function freezeContent<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeContent(child);
    Object.freeze(value);
  }
  return value;
}
function createRevision(validated: ValidatedReadingPackage): Revision {
  const imagePaths = new Map(validated.data.images.map(image => [image.path,
    `gwreading/${validated.digest}/${image.sha256}.${extension(image.mimeType)}`]));
  const remap = (unit: ReadingDefinition): ReadingDefinition => {
    const copy = structuredClone(unit);
    copy.coverPath = imagePaths.get(copy.coverPath) ?? copy.coverPath;
    if (copy.paper) for (const passage of copy.paper.passages)
      passage.coverPath = imagePaths.get(passage.coverPath) ?? passage.coverPath;
    return copy;
  };
  return freezeContent({ validated, units: validated.units.map(remap), legacyUnits: validated.legacyUnits.map(remap) });
}
function loadRevision(store: Store, digest: string): Revision {
  const cached = store.revisions.get(digest);
  if (cached) return cached;
  // App compatibility controls activation; a supported archived engine remains readable for history.
  const validated = readPackage(revisionFile(store, digest), false);
  if (validated.digest !== digest) throw new Error('阅读包存档校验失败。');
  for (const image of validated.data.images) {
    const file = path.join(store.root, 'assets', digest, image.sha256 + '.' + extension(image.mimeType));
    if (!fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== image.sha256)
      throw new Error('阅读包图片缺失或损坏，请重新导入原阅读包修复。');
  }
  const revision = createRevision(validated);
  store.revisions.set(digest, revision);
  return revision;
}
function parseRegistry(raw: string): Registry {
  const value = JSON.parse(raw) as Registry;
  if (!value || value.formatVersion !== 1 || !Array.isArray(value.active) ||
    !value.questions || typeof value.questions !== 'object' || Array.isArray(value.questions) ||
    !value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions))
    throw new Error('阅读包目录登记损坏。');
  const ids = new Set<string>();
  for (const entry of value.active) {
    if (!entry || typeof entry.id !== 'string' || !safeRecordKey(entry.id) || ids.has(entry.id) || !DIGEST.test(entry.digest) ||
      !entry.info || entry.info.id !== entry.id || typeof entry.info.name !== 'string' || typeof entry.info.version !== 'string')
      throw new Error('阅读包目录登记损坏。');
    ids.add(entry.id);
  }
  for (const [id, fingerprint] of Object.entries(value.questions)) if (!safeRecordKey(id) || !DIGEST.test(fingerprint))
    throw new Error('阅读包题目登记损坏。');
  for (const [id, versions] of Object.entries(value.versions)) {
    if (!safeRecordKey(id) || !versions || typeof versions !== 'object' || Array.isArray(versions) ||
      Object.values(versions).some(digest => !DIGEST.test(digest))) throw new Error('阅读包版本登记损坏。');
  }
  value.unitOwners ??= {};
  if (typeof value.unitOwners !== 'object' || Array.isArray(value.unitOwners)) throw new Error('阅读包篇目登记损坏。');
  for (const [unitId, owners] of Object.entries(value.unitOwners)) {
    if (!safeRecordKey(unitId) || !owners || typeof owners !== 'object' || Array.isArray(owners)) throw new Error('阅读包篇目登记损坏。');
    for (const [packageId, hashes] of Object.entries(owners)) if (!safeRecordKey(packageId) || !Array.isArray(hashes) ||
      hashes.some(hash => !DIGEST.test(hash))) throw new Error('阅读包篇目登记损坏。');
  }
  for (const entry of value.active) if (value.versions[entry.id]?.[entry.info.version] !== entry.digest)
    throw new Error('阅读包当前版本与历史登记不一致。');
  return value;
}
function rememberUnitIdentities(registry: Registry, value: ValidatedReadingPackage): void {
  for (const [id, fingerprint] of Object.entries(value.unitFingerprints)) {
    if (!safeRecordKey(id) || !safeRecordKey(value.data.manifest.id)) throw new Error('阅读包使用了保留编号。');
    const hashes = ((registry.unitOwners[id] ??= {})[value.data.manifest.id] ??= []);
    if (!hashes.includes(fingerprint)) hashes.push(fingerprint);
  }
}
function atomicWrite(file: string, bytes: Buffer | string): void {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, bytes, typeof bytes === 'string' ? { encoding: 'utf8' } : undefined);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function writeRegistry(store: Store, registry: Registry): void {
  const file = path.join(store.root, 'registry.json');
  // A second complete registry permits recovery after external damage to the primary file.
  if (fs.existsSync(file)) {
    try { const previous = fs.readFileSync(file, 'utf8'); parseRegistry(previous); atomicWrite(path.join(store.root, 'registry.backup.json'), previous); }
    catch { /* Keep the last readable backup. */ }
  }
  atomicWrite(file, JSON.stringify(registry));
}
function publishArrays(store: Store): void {
  activeReadingUnits.splice(0, activeReadingUnits.length);
  activeLegacyReadingUnits.splice(0, activeLegacyReadingUnits.length);
  const seen = new Set<string>(), legacySeen = new Set<string>();
  for (const revision of store.active.values()) {
    for (const unit of revision.units) if (!seen.has(unit.id)) { seen.add(unit.id); activeReadingUnits.push(unit); }
    for (const unit of revision.legacyUnits) if (!legacySeen.has(unit.id)) { legacySeen.add(unit.id); activeLegacyReadingUnits.push(unit); }
  }
}
function checkConflicts(store: Store, value: ValidatedReadingPackage): 'install' | 'upgrade' | 'unchanged' {
  const manifest = value.data.manifest;
  if (!safeRecordKey(manifest.id) || Object.keys(value.questionFingerprints).some(id => !safeRecordKey(id)))
    throw new Error('阅读包使用了保留编号。');
  const existingVersion = store.registry.versions[manifest.id]?.[manifest.version];
  if (existingVersion && existingVersion !== value.digest) throw new Error('同一阅读包版本的内容不同，请提升版本号。');
  for (const [id, fingerprint] of Object.entries(value.questionFingerprints)) {
    const previous = store.registry.questions[id];
    if (previous && previous !== fingerprint) throw new Error('题目编号已有不同的题意或评分规则，请使用新题号：' + id);
  }
  for (const [id, fingerprint] of Object.entries(value.unitFingerprints)) {
    if (!safeRecordKey(id)) throw new Error('阅读包使用了保留编号。');
    for (const [owner, hashes] of Object.entries(store.registry.unitOwners[id] ?? {}))
      if (owner !== manifest.id && hashes.some(hash => hash !== fingerprint))
        throw new Error('阅读篇目编号与另一阅读包的历史内容冲突：' + id);
  }
  for (const [id, revision] of store.active) {
    if (id === manifest.id) continue;
    for (const [unitId, fingerprint] of Object.entries(value.unitFingerprints)) {
      const previous = revision.validated.unitFingerprints[unitId];
      if (previous && previous !== fingerprint) throw new Error('阅读篇目编号与另一阅读包的内容冲突：' + unitId);
    }
  }
  // Archived packages retain question identities, including revisions no longer in the catalog.
  for (const revision of store.revisions.values()) {
    for (const [id, fingerprint] of Object.entries(value.questionFingerprints)) {
      const previous = revision.validated.questionFingerprints[id];
      if (previous && previous !== fingerprint) throw new Error('题目编号与历史阅读包的题意冲突，请使用新题号：' + id);
    }
    if (revision.validated.data.manifest.id !== manifest.id) for (const [id, fingerprint] of Object.entries(value.unitFingerprints)) {
      const previous = revision.validated.unitFingerprints[id];
      if (previous && previous !== fingerprint) throw new Error('阅读篇目编号与另一阅读包的历史内容冲突：' + id);
    }
  }
  const previous = store.registry.active.find(entry => entry.id === manifest.id);
  if (!previous) return 'install';
  const comparison = compareReadingPackageVersions(manifest.version, previous.info.version);
  if (comparison < 0) throw new Error('不能导入更低版本的阅读包。');
  if (comparison === 0) {
    if (previous.digest !== value.digest) throw new Error('同一阅读包版本的内容不同，请提升版本号。');
    return 'unchanged';
  }
  return 'upgrade';
}
function archiveRevision(store: Store, value: ValidatedReadingPackage): Revision {
  fs.mkdirSync(path.join(store.root, 'revisions'), { recursive: true });
  const file = revisionFile(store, value.digest);
  if (fs.existsSync(file)) {
    let intact = false;
    try { intact = readPackage(file, false).digest === value.digest; } catch { /* Repair only from the fully revalidated original. */ }
    if (!intact) atomicWrite(file, encodeReadingPackage(value.data));
  } else atomicWrite(file, encodeReadingPackage(value.data));
  const directory = path.join(store.root, 'assets', value.digest);
  fs.mkdirSync(directory, { recursive: true });
  for (const image of value.data.images) {
    const asset = path.join(directory, image.sha256 + '.' + extension(image.mimeType));
    const bytes = Buffer.from(image.dataBase64, 'base64');
    if (fs.existsSync(asset)) {
      if (createHash('sha256').update(fs.readFileSync(asset)).digest('hex') !== image.sha256)
        atomicWrite(asset, bytes);
    } else atomicWrite(asset, bytes);
  }
  const revision = createRevision(value);
  return revision;
}
function pinNullSessions(store: Store, fallback?: Revision): void {
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_sessions'").get()) return;
  const columns = db.prepare('PRAGMA table_info(reading_sessions)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'content_revision')) db.exec('ALTER TABLE reading_sessions ADD COLUMN content_revision TEXT');
  const revisions = [...store.active.values(), ...(fallback ? [fallback] : [])];
  const update = db.prepare('UPDATE reading_sessions SET content_revision=? WHERE unit_id=? AND content_revision IS NULL');
  db.transaction(() => {
    for (const revision of revisions) for (const unit of [...revision.units, ...revision.legacyUnits])
      update.run(revision.validated.digest, unit.id);
  })();
}
function loadPinnedRevisions(store: Store): void {
  const db = openProgressDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_sessions'").get()) return;
  const columns = db.prepare('PRAGMA table_info(reading_sessions)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'content_revision')) return;
  const rows = db.prepare('SELECT DISTINCT content_revision FROM reading_sessions WHERE content_revision IS NOT NULL').all() as Array<{ content_revision: string }>;
  for (const { content_revision: digest } of rows) {
    if (!DIGEST.test(digest)) continue;
    try {
      const value = readPackage(revisionFile(store, digest), false);
      if (value.digest !== digest || !safeRecordKey(value.data.manifest.id)) continue;
      const knownVersion = store.registry.versions[value.data.manifest.id]?.[value.data.manifest.version];
      if (knownVersion && knownVersion !== digest) throw new Error('历史阅读包版本与目录登记不一致。');
      for (const [id, fingerprint] of Object.entries(value.questionFingerprints)) {
        if (!safeRecordKey(id)) continue;
        const previous = store.registry.questions[id];
        if (previous && previous !== fingerprint) throw new Error('历史阅读包题号与目录登记不一致。');
        store.registry.questions[id] = fingerprint;
      }
      (store.registry.versions[value.data.manifest.id] ??= {})[value.data.manifest.version] = digest;
      rememberUnitIdentities(store.registry, value);
      try { loadRevision(store, digest); } catch { /* Missing assets do not erase the persisted question identity. */ }
    } catch { /* A damaged pinned archive remains unavailable; never substitute an active version. */ }
  }
}
function activate(store: Store, value: ValidatedReadingPackage, builtIn: boolean): ReadingPackageImportResult {
  const action = checkConflicts(store, value);
  const revision = archiveRevision(store, value);
  const existing = store.registry.active.find(entry => entry.id === value.data.manifest.id);
  const info = infoFor(value, builtIn || Boolean(existing?.info.builtIn));
  if (action === 'unchanged' && store.active.has(info.id)) return { package: info, action: 'unchanged' };
  pinNullSessions(store, store.active.size ? undefined : revision);
  const registry = structuredClone(store.registry);
  const entry = { id: info.id, digest: value.digest, info };
  const index = registry.active.findIndex(item => item.id === info.id);
  if (index < 0) registry.active.push(entry); else registry.active[index] = entry;
  Object.assign(registry.questions, value.questionFingerprints);
  rememberUnitIdentities(registry, value);
  (registry.versions[info.id] ??= {})[info.version] = value.digest;
  writeRegistry(store, registry);
  store.registry = registry; store.revisions.set(value.digest, revision); store.active.set(info.id, revision);
  store.errors = store.errors.filter(error => error.id !== info.id && error.id !== 'registry');
  publishArrays(store);
  return { package: info, action: action === 'install' ? 'installed' : action === 'upgrade' ? 'upgraded' : 'unchanged' };
}

/** Lazily initialize only after app paths (or an isolated fixture's paths) have been selected. */
export function ensureReadingPackages(): void {
  const root = path.resolve(getReadingPackagesDir());
  const bundle = getBundledReadingPackagePath();
  if (currentStore?.root === root && currentStore.bundle === bundle) return;
  const store: Store = { root, bundle, registry: emptyRegistry(), revisions: new Map(), active: new Map(), errors: [], initializing: true };
  currentStore = store;
  activeReadingUnits.splice(0); activeLegacyReadingUnits.splice(0); previews.clear();
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['registry.json', 'registry.backup.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try { store.registry = parseRegistry(fs.readFileSync(file, 'utf8')); break; }
    catch (error) {
      store.errors.push({ id: 'registry', name: '阅读包目录', version: '', formatVersion: 1, unitCount: 0, questionCount: 0,
        builtIn: false, status: 'error', message: errorText(error) });
    }
  }
  // Load archives independently. A damaged revision never disables a healthy package.
  for (const digest of new Set(Object.values(store.registry.versions).flatMap(versions => Object.values(versions)))) {
    try { rememberUnitIdentities(store.registry, loadRevision(store, digest).validated); } catch { /* Active entries below provide actionable errors. */ }
  }
  for (const entry of store.registry.active) {
    try {
      const revision = loadRevision(store, entry.digest);
      const manifest = revision.validated.data.manifest;
      if (manifest.id !== entry.id || manifest.version !== entry.info.version) throw new Error('阅读包目录与存档不一致。');
      const appVersion = app?.getVersion?.() ?? '1.0.0';
      if (compareReadingPackageVersions(appVersion, manifest.minAppVersion) < 0 ||
        (manifest.maxAppVersion && compareReadingPackageVersions(appVersion, manifest.maxAppVersion) > 0))
        throw new Error('此阅读包与当前应用版本不兼容。');
      store.active.set(entry.id, revision);
    } catch (error) { store.errors.push({ ...entry.info, status: 'error', message: errorText(error) }); }
  }
  loadPinnedRevisions(store);
  publishArrays(store);
  if (bundle) {
    try {
      const value = readPackage(bundle);
      const existing = store.registry.active.find(entry => entry.id === value.data.manifest.id);
      if (!existing || compareReadingPackageVersions(existing.info.version, value.data.manifest.version) <= 0)
        activate(store, value, true);
    }
    catch (error) {
      let id = 'bundled-base', name = '内置阅读包';
      try { const value = readPackage(bundle); id = value.data.manifest.id; name = value.data.manifest.name; } catch { /* Display a bundle-level error. */ }
      store.errors.push({ id, name, version: '', formatVersion: 1, unitCount: 0, questionCount: 0,
        builtIn: true, status: 'error', message: errorText(error) });
    }
  }
  pinNullSessions(store);
  store.initializing = false;
}
function store(): Store { ensureReadingPackages(); return currentStore!; }
export function bindUnversionedReadingSessions(): void { pinNullSessions(store()); }
export function listReadingPackages(): ReadingPackageInfo[] {
  const state = store();
  return [...state.registry.active.flatMap(entry => state.active.has(entry.id) ? [{ ...entry.info, status: 'active' as const }] : []),
    ...state.errors.map(error => ({ ...error }))];
}
export async function previewReadingPackageFile(filePath: string): Promise<ReadingPackagePreview> {
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) throw new Error('请选择本机阅读包文件。');
  const state = store(), value = readPackage(filePath), action = checkConflicts(state, value);
  for (const [token, item] of previews) if (item.expires < Date.now()) previews.delete(token);
  if (previews.size >= 24) previews.delete(previews.keys().next().value!);
  const token = randomUUID();
  previews.set(token, { file: filePath, digest: value.digest, expires: Date.now() + 10 * 60_000 });
  const current = state.registry.active.find(entry => entry.id === value.data.manifest.id);
  return { token, package: infoFor(value, Boolean(current?.info.builtIn)), action, ...(current ? { currentVersion: current.info.version } : {}) };
}
export async function importReadingPackage(token: string): Promise<ReadingPackageImportResult> {
  const state = store(), pending = previews.get(token);
  if (!pending || pending.expires < Date.now()) { previews.delete(token); throw new Error('阅读包预览已过期，请重新选择文件。'); }
  previews.delete(token);
  const value = readPackage(pending.file);
  if (value.digest !== pending.digest) throw new Error('阅读包在预览后发生变化，请重新选择文件。');
  return activate(state, value, false);
}
export function getReadingDefinition(unitId: string, revisionDigest?: string | null): ReadingDefinition {
  if (typeof unitId !== 'string' || !unitId) throw new Error('阅读单元编号无效。');
  const state = store();
  const revisions = revisionDigest ? [loadRevision(state, revisionDigest)] : knownRevisions(state);
  for (const revision of revisions) {
    const unit = [...revision.units, ...revision.legacyUnits].find(item => item.id === unitId);
    if (unit) return unit;
  }
  throw new Error('找不到这篇阅读材料的内容版本。');
}
export function getReadingContentRevision(unitId: string): string {
  for (const revision of knownRevisions(store())) if ([...revision.units, ...revision.legacyUnits].some(unit => unit.id === unitId))
    return revision.validated.digest;
  throw new Error('找不到这篇阅读材料。');
}
export function getReadingParagraphs(unitId: string, revisionDigest?: string | null): ReadingPackageParagraphs {
  const state = store();
  const revision = loadRevision(state, revisionDigest || getReadingContentRevision(unitId));
  const paragraphs = revision.validated.paragraphs[unitId];
  if (!paragraphs) throw new Error('找不到这篇阅读材料的原文。');
  return paragraphs;
}
export function getReadingPackageMetadata(unitId: string, revisionDigest?: string | null) {
  const state = store(), digest = revisionDigest || getReadingContentRevision(unitId);
  const revision = loadRevision(state, digest), manifest = revision.validated.data.manifest;
  const active = state.active.get(manifest.id);
  return { contentVersion: manifest.version, packageName: manifest.name,
    updateAvailable: Boolean(active && active.validated.digest !== digest && active.units.some(unit => unit.id === unitId)) };
}
export function getReadingRevisionUnits(digest: string): { units: ReadingDefinition[]; legacyUnits: ReadingDefinition[] } {
  return loadRevision(store(), digest);
}
function knownRevisions(state: Store): Revision[] {
  const active = [...state.active.values()];
  const activeDigests = new Set(active.map(revision => revision.validated.digest));
  const archived = [...state.revisions.values()].filter(revision => !activeDigests.has(revision.validated.digest));
  archived.sort((left, right) => compareReadingPackageVersions(right.validated.data.manifest.version, left.validated.data.manifest.version));
  return [...active, ...archived];
}
export function getReadingKnownDefinitions(): { units: ReadingDefinition[]; legacyUnits: ReadingDefinition[] } {
  const revisions = knownRevisions(store());
  return { units: revisions.flatMap(revision => revision.units), legacyUnits: revisions.flatMap(revision => revision.legacyUnits) };
}
