import { getManagedBaseDirectory, getManagedMediaPath } from './content-package-store';
import { getResourceDirectoryConfig } from './resource-directory-config';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';


export function getBundledContentDir() {
  const candidates = [
    ...(process.env.GENSHINWORDS_CONTENT_DIR ? [process.env.GENSHINWORDS_CONTENT_DIR] : []),
    path.join(process.resourcesPath, 'content'),
    path.join(app.getAppPath(), '..', 'content'),
    path.join(app.getAppPath(), 'content'),
    path.join(__dirname, '../../../../content'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'content.db')) || fs.existsSync(dir)) {
      if (fs.existsSync(path.join(dir, 'content.db'))) return dir;
    }
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[1];
}
export function getContentPackagesDir(): string {
  if (process.env.GENSHINWORDS_CONTENT_PACKAGES_DIR) return process.env.GENSHINWORDS_CONTENT_PACKAGES_DIR;
  if (process.env.GENSHINWORDS_USER_DATA) return path.join(process.env.GENSHINWORDS_USER_DATA, 'content-packages');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'GenshinWords', 'content-packages');
  return path.join(app.getPath('userData'), 'content-packages');
}
export function getContentDir() { return getManagedBaseDirectory(getBundledContentDir()); }
export function getContentDbPath() {
  return process.env.GENSHINWORDS_CONTENT_DB || path.join(getContentDir(), 'content.db');
}
export function getProgressDbPath() {
  return path.join(
    process.env.GENSHINWORDS_USER_DATA || app.getPath('userData'),
    'progress.db',
  );
}
export function getReadingPackagesDir(): string {
  return process.env.GENSHINWORDS_READING_PACKAGES_DIR || path.join(
    process.env.GENSHINWORDS_USER_DATA || app.getPath('userData'), 'reading-packages',
  );
}
export function getBundledReadingPackagePath(): string | null {
  const file = path.join(getBundledContentDir(), 'reading', 'base.gwreading');
  return fs.existsSync(file) ? file : null;
}
export function getImagePath(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('Invalid local asset path');
  if (/^gwcontent(?:[\\/]|$)/i.test(relativePath)) {
    const file = getManagedMediaPath(relativePath, false);
    if (!file) throw new Error('Invalid content package image path');
    return file;
  }
  if (relativePath.startsWith('gwreading/')) {
    if (!/^gwreading\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(relativePath))
      throw new Error('Invalid reading package image path');
    return containedPath(path.join(getReadingPackagesDir(), 'assets'), relativePath.slice('gwreading/'.length));
  }
  if (/^gwreading(?:[\\/]|$)/i.test(relativePath)) throw new Error('Invalid reading package image path');
  const raw = selectedRawMedia();
  if (raw) {
    const file = getManagedMediaPath('gwcontent/' + raw.digest + '/images/' + relativePath, false);
    if (!file) throw new Error('外部资源目录中的图片不可用，请重新指定目录。');
    return file;
  }
  return containedPath(path.join(getMediaDir(), 'images'), relativePath);
}
export function getAudioPath(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('Invalid audio path');
  if (/^gwcontent(?:[\\/]|$)/i.test(relativePath)) {
    const file = getManagedMediaPath(relativePath, true);
    if (!file) throw new Error('Invalid content package audio path');
    return file;
  }
  if (!relativePath.replace(/\\/g, '/').startsWith('audio/')) throw new Error('Invalid audio path');
  const raw = selectedRawMedia();
  if (raw) {
    const file = getManagedMediaPath('gwcontent/' + raw.digest + '/' + relativePath, true);
    if (!file) throw new Error('外部资源目录中的音频不可用，请重新指定目录。');
    return file;
  }
  return containedPath(getMediaDir(), relativePath);
}
function selectedRawMedia(contentDir = getContentDir()): { path: string; digest: string } | null {
  try {
    const raw = getResourceDirectoryConfig();
    return raw.path && raw.digest && path.resolve(raw.path).toLowerCase() === path.resolve(contentDir).toLowerCase()
      ? { path: raw.path, digest: raw.digest } : null;
  } catch { return null; }
}
export function getMediaDir() {
  const contentDir = getContentDir();
  if (selectedRawMedia(contentDir)) return contentDir;
  const archive = path.join(contentDir, 'assets.asar');
  return fs.existsSync(archive) ? archive : contentDir;
}
export function containedPath(root, file) {
  const target = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error('Invalid local asset path');
  return target;
}
