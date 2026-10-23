import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';
import { spawnSync } from 'node:child_process';

const contentDir = fileURLToPath(new URL('../content/', import.meta.url));

function checkContent() {
  const database = path.join(contentDir, 'content.db');
  const fd = fs.openSync(database, 'r');
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, header.length, 0);
    if (header.toString('ascii') !== 'SQLite format 3\0') {
      throw new Error('content.db 不是有效的 SQLite 文件');
    }
  } finally {
    fs.closeSync(fd);
  }

  const archive = path.join(contentDir, 'assets.asar');
  if (fs.existsSync(archive)) {
    const entries = listPackage(archive).map((name) => name.replace(/\\/g, '/'));
    for (const directory of ['audio', 'images']) {
      if (!entries.some((name) => name.startsWith(`/${directory}/`))) {
        throw new Error(`assets.asar 缺少 ${directory}/ 素材`);
      }
    }
  } else {
    for (const directory of ['audio', 'images']) {
      const mediaDir = path.join(contentDir, directory);
      if (!fs.statSync(mediaDir).isDirectory() || fs.readdirSync(mediaDir).length === 0) {
        throw new Error(`缺少 ${directory}/ 素材`);
      }
    }
  }
  const materialsCheck = spawnSync(process.execPath, [fileURLToPath(new URL('./check-materials.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true });
  if (materialsCheck.error) throw materialsCheck.error;
  if (materialsCheck.status !== 0) throw new Error('补充资料库或横版题图检查未通过');
  const readingCheck = spawnSync(process.execPath, [fileURLToPath(new URL('./reading-package.cjs', import.meta.url)), 'validate', path.join(contentDir, 'reading', 'base.gwreading')], { stdio: 'inherit', windowsHide: true });
  if (readingCheck.error) throw readingCheck.error;
  if (readingCheck.status !== 0) throw new Error('基础阅读包格式或资源检查未通过');
  console.log('离线内容入口检查通过（原词库、补充资料库、匹配索引、媒体与基础阅读包）。');
}

try {
  checkContent();
} catch (error) {
  console.error(`无法构建完整离线版：${error.message}`);
  console.error(`请先将完整资料库放在 ${contentDir}`);
  process.exitCode = 1;
}
