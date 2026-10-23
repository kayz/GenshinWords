import type { ContentPackageInfo, ContentPackagePreview } from './content-package';

/** User-selected resource sources. These never contain personal learning records. */
export interface ResourceDirectoryRawInfo {
  path: string; name: string; version: string;
  wordCount: number; chapterCount: number; lineCount: number;
  status: 'ready' | 'active' | 'error'; message?: string;
}
export interface ResourceDirectoryPackage {
  file: string; relativePath: string;
  package: ContentPackageInfo | null;
  status: 'ready' | 'error' | 'skipped';
  action?: ContentPackagePreview['action']; message?: string;
}
export interface ResourceDirectoryStatus {
  raw: ResourceDirectoryRawInfo | null;
  packageDirectory: string | null;
  packageDirectoryAvailable: boolean;
  message?: string;
}
export interface ResourceDirectoryPreview {
  token: string; directory: string; kind: 'raw' | 'packages' | 'mixed';
  raw: ResourceDirectoryRawInfo | null;
  packages: ResourceDirectoryPackage[];
  warnings: string[]; canLoad: boolean;
}
export interface ResourceDirectoryItemResult {
  file: string; package?: ContentPackageInfo;
  status: 'loaded' | 'unchanged' | 'error' | 'skipped';
  message?: string;
}
export interface ResourceDirectoryLoadResult {
  directory: string; status: ResourceDirectoryStatus;
  raw: ResourceDirectoryRawInfo | null;
  results: ResourceDirectoryItemResult[];
  loadedCount: number; failedCount: number; warnings: string[];
}
