import type { ReadingDefinition } from '../main/reading-bank-types';
import type { IndependentReadingDefinition } from '../main/reading-paper-types';
import type { ReadingLevel } from './reading';

export const READING_PACKAGE_FORMAT = 'genshinwords.reading' as const;
export const READING_PACKAGE_FORMAT_VERSION = 1 as const;
export interface ReadingPackageManifest {
  id: string; name: string; version: string; minAppVersion: string; maxAppVersion?: string;
  engineVersion: 1; createdAt: string; description?: string;
}
export interface ReadingPackageSourceText { text: string; sha256: string; paragraphs: string[] }
export interface ReadingPackageSource {
  id: string; title: string; url: string; en: ReadingPackageSourceText; chs: ReadingPackageSourceText;
}
export interface ReadingPackageImage {
  path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; sha256: string;
  sourceTitle: string; sourceUrl: string; dataBase64: string;
}
export type ReadingPackageUnit = {
  kind: 'passage'; definition: IndependentReadingDefinition;
  composition?: 'independent' | 'split'; legacyGroupId?: string;
} | { kind: 'classic'; definition: ReadingDefinition };
export interface ReadingPackageLegacyGroup {
  id: string; title: string; level: ReadingLevel; background: string; estimatedMinutes: number;
  passages: Array<{ unitId: string; title?: string }>;
}
export interface ReadingPackageData {
  format: typeof READING_PACKAGE_FORMAT; formatVersion: typeof READING_PACKAGE_FORMAT_VERSION;
  manifest: ReadingPackageManifest; units: ReadingPackageUnit[]; legacyGroups: ReadingPackageLegacyGroup[];
  sources: ReadingPackageSource[]; images: ReadingPackageImage[];
}
export interface ReadingPackageParagraphs { en: string[]; chs: string[]; masked: string[] }
export interface ValidatedReadingPackage {
  data: ReadingPackageData; digest: string; units: ReadingDefinition[]; legacyUnits: ReadingDefinition[];
  paragraphs: Record<string, ReadingPackageParagraphs>;
  questionFingerprints: Record<string, string>; unitFingerprints: Record<string, string>;
}
