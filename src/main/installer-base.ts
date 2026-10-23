import fs from 'node:fs';
import path from 'node:path';
import { getContentPackagesDir } from './paths';
import { previewContentPackageFile, importContentPackage, activatePendingContentPackages, discardPendingContentPackage } from './content-package-store';

const selectionName = 'installer-base-selection.ini';

function selectionFile(): string {
  return path.join(path.dirname(path.resolve(getContentPackagesDir())), selectionName);
}

/** The installer writes a UTF-16 INI file outside the learning profile. */
export function readInstallerBaseSelection(): string | null {
  const file = selectionFile();
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > 8192)
    throw new Error('安装程序的素材选择记录无效，请在内容管理中重新选择。');
  const bytes = fs.readFileSync(file);
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe || bytes.length % 2 !== 0)
    throw new Error('安装程序的素材选择记录编码无效，请在内容管理中重新选择。');
  const lines = bytes.subarray(2).toString('utf16le').split(/\r?\n/u);
  // WriteINIStr may place a blank line before its first section.
  while (lines[0] === '') lines.shift();
  if (lines[0] !== '[Base]') throw new Error('安装程序的素材选择记录无效，请在内容管理中重新选择。');
  const selected = lines.filter(line => line.startsWith('Path='));
  if (selected.length !== 1) throw new Error('安装程序的素材选择记录无效，请在内容管理中重新选择。');
  const filePath = selected[0].slice(5);
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.gwcontent' || /[\r\n\0]/u.test(filePath))
    throw new Error('请选择完整的本机 .gwcontent 基础素材包。');
  return filePath;
}

export function clearInstallerBaseSelection(): void {
  try { fs.unlinkSync(selectionFile()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Reuse the same version, identity, resource and rollback checks as directory import. */
export async function installSelectedBasePackage(file: string): Promise<void> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.gwcontent')
    throw new Error('请选择完整的本机 .gwcontent 基础素材包。');
  const preview = await previewContentPackageFile(file);
  if (preview.package.kind !== 'base') throw new Error('所选文件不是完整基础素材包，请重新选择。');
  const imported = await importContentPackage(preview.token);
  if (imported.package.status === 'pending') {
    try { await activatePendingContentPackages({ clearRaw: true }); }
    catch (error) {
      await discardPendingContentPackage(imported.package.id).catch(() => undefined);
      throw error;
    }
  }
  clearInstallerBaseSelection();
}
