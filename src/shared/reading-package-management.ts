/** Metadata safe to display before and after importing a local reading package. */
export interface ReadingPackageInfo {
  id: string;
  name: string;
  version: string;
  formatVersion: number;
  minAppVersion?: string;
  maxAppVersion?: string;
  description?: string;
  unitCount: number;
  questionCount: number;
  builtIn: boolean;
  status: 'active' | 'error';
  message?: string;
}

/** The token refers to a complete validation performed in the main process. */
export interface ReadingPackagePreview {
  token: string;
  package: ReadingPackageInfo;
  action: 'install' | 'upgrade' | 'unchanged';
  currentVersion?: string;
}

export interface ReadingPackageImportResult {
  package: ReadingPackageInfo;
  action: 'installed' | 'upgraded' | 'unchanged';
}
