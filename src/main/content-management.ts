import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ContentPackageInfo, ContentPackagePreview, ContentPackageImportResult } from '../shared/content-package';
import type { ReadingPackageInfo } from '../shared/reading-package-management';
import { listContentPackages as listResources, previewContentPackageFile, importContentPackage as importResource } from './content-package-store';
import { listReadingPackages, previewReadingPackageFile, importReadingPackage } from './reading-package-store';

const tokens = new Map<string, { kind: 'reading' | 'content'; delegate: string; expires: number }>();
function readingInfo(value: ReadingPackageInfo): ContentPackageInfo {
  return { id: value.id, name: value.name, kind: 'reading', version: value.version,
    formatVersion: value.formatVersion, builtIn: value.builtIn, status: value.status,
    message: value.message, minAppVersion: value.minAppVersion, maxAppVersion: value.maxAppVersion, description: value.description, counts: { readings: value.unitCount, questions: value.questionCount } };
}
export async function listManagedContentPackages(): Promise<ContentPackageInfo[]> {
  const result: ContentPackageInfo[] = [];
  const sources = await Promise.allSettled([Promise.resolve().then(() => listResources()), Promise.resolve().then(() => listReadingPackages())]);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source.status === 'fulfilled') result.push(...(index === 0 ? source.value as ContentPackageInfo[] : (source.value as ReadingPackageInfo[]).map(readingInfo)));
    else result.push({ id: index === 0 ? 'content-store-error' : 'reading-store-error', name: index === 0 ? '本地素材与词书' : '本地阅读题库',
      kind: index === 0 ? 'base' : 'reading', version: '—', formatVersion: 1, builtIn: false, status: 'error', counts: {},
      message: source.reason instanceof Error ? source.reason.message : '包目录暂时无法读取。' });
  }
  return result;
}
export async function previewManagedContentPackage(file: string): Promise<ContentPackagePreview> {
  const ext = path.extname(file).toLowerCase();
  if (!['.gwreading', '.gwcontent', '.gwwords'].includes(ext)) throw new Error('请选择 .gwcontent、.gwwords 或 .gwreading 文件。');
  let preview: ContentPackagePreview;
  let kind: 'reading' | 'content';
  if (ext === '.gwreading') {
    const value = await previewReadingPackageFile(file);
    preview = { ...value, package: readingInfo(value.package), restartRequired: false,
      warnings: value.action === 'upgrade' ? ['已开始的阅读继续使用原版本，新一轮使用新版。'] : [] };
    kind = 'reading';
  } else { preview = await previewContentPackageFile(file); kind = 'content'; }
  const now = Date.now();
  for (const [key, item] of tokens) if (item.expires < now) tokens.delete(key);
  while (tokens.size >= 128) tokens.delete(tokens.keys().next().value!);
  const token = randomUUID();
  tokens.set(token, { kind, delegate: preview.token, expires: now + 10 * 60 * 1000 });
  return { ...preview, token };
}
export async function importManagedContentPackage(token: string): Promise<ContentPackageImportResult> {
  if (typeof token !== 'string') throw new Error('请先选择并检查内容包。');
  const selected = tokens.get(token);
  if (!selected || selected.expires < Date.now()) { tokens.delete(token); throw new Error('检查结果已过期，请重新选择文件。'); }
  if (selected.kind === 'content') {
    const result = await importResource(selected.delegate); tokens.delete(token); return result;
  }
  const result = await importReadingPackage(selected.delegate); tokens.delete(token);
  return { ...result, package: readingInfo(result.package), restartRequired: false };
}
