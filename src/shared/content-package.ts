/** Offline content packages are data only; learning records never belong in a package. */
export type ContentPackageKind = 'base' | 'materials' | 'words';
export interface ContentPackageDependency { id: string; minVersion: string }
export interface ContentPackageManifest {
  id: string; name: string; kind: ContentPackageKind; version: string;
  minAppVersion: string; maxAppVersion?: string; author: string; description?: string;
  createdAt: string; dependencies?: ContentPackageDependency[];
}
export interface ContentPackageEntry { path: string; size: number; sha256: string }
export interface ContentPackageHeader {
  format: 'genshinwords.content'; formatVersion: 1;
  manifest: ContentPackageManifest; entries: ContentPackageEntry[];
}
export interface WordBookData {
  id: string; name: string; name_zh: string; description: string;
  lemmas: string[];
}
export interface WordPackageData { books: WordBookData[] }
export interface MaterialLineData { id: string; speaker: string; text_en: string; text_chs: string }
export interface MaterialQuestData { id: string; title_en: string; title_chs: string; lines: MaterialLineData[] }
export interface MaterialChapterData {
  id: string; title_en: string; title_chs: string; type: 'quest' | 'voice' | 'hangout' | 'book';
  version: string; sourceUrl: string; coverPath?: string; quests: MaterialQuestData[];
}
export interface MaterialPackageData { chapters: MaterialChapterData[] }
export interface ContentPackageInfo {
  id: string; name: string; kind: ContentPackageKind | 'reading'; version: string;
  formatVersion: number; minAppVersion?: string; maxAppVersion?: string;
  author?: string; description?: string; builtIn: boolean;
  status: 'active' | 'pending' | 'error'; message?: string;
  counts: { books?: number; words?: number; chapters?: number; files?: number; readings?: number; questions?: number };
  dependencies?: ContentPackageDependency[]; revisions?: string[];
}
export interface ContentPackagePreview {
  token: string; package: ContentPackageInfo; action: 'install' | 'upgrade' | 'unchanged';
  currentVersion?: string; warnings: string[]; restartRequired: boolean;
}
export interface ContentPackageImportResult {
  action: 'installed' | 'upgraded' | 'unchanged'; package: ContentPackageInfo;
  restartRequired: boolean;
}
