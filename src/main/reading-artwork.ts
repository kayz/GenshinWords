import fs from 'node:fs/promises';
import sharp from 'sharp';
import { getImagePath } from './paths';
import { getReadingDocument } from './reading';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BANNERS = 12;
const bannerCache = new Map<string, Promise<Buffer | null>>();

/** x/y identify the subject in the original image, independently of the viewport. */
export function readingBannerCrop(width: number, height: number, focus: { x: number; y: number }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 4 || height < 1) {
    throw new Error('阅读题图尺寸无效');
  }
  const cropHeight = Math.min(height, Math.floor(width / 4));
  const cropWidth = cropHeight * 4;
  const x = Number.isFinite(focus.x) ? Math.max(0, Math.min(1, focus.x)) : 0.5;
  const y = Number.isFinite(focus.y) ? Math.max(0, Math.min(1, focus.y)) : 0.5;
  return {
    left: Math.max(0, Math.min(width - cropWidth, Math.round(width * x - cropWidth / 2))),
    top: Math.max(0, Math.min(height - cropHeight, Math.round(height * y - cropHeight / 2))),
    width: cropWidth,
    height: cropHeight,
  };
}

async function renderBanner(relativePath: string, focus: { x: number; y: number }): Promise<Buffer | null> {
  // Resolve inside the existing images boundary; a failed path check must not be swallowed.
  const imagePath = getImagePath(relativePath);
  let raw: Buffer;
  try {
    const stat = await fs.stat(imagePath);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    raw = await fs.readFile(imagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const metadata = await sharp(raw, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
  if (!metadata.width || !metadata.height) return null;
  return sharp(raw, { limitInputPixels: 64 * 1024 * 1024 })
    .extract(readingBannerCrop(metadata.width, metadata.height, focus))
    .resize(1600, 400, { fit: 'fill' })
    .flatten({ background: '#e8ede6' })
    .png()
    .toBuffer();
}

/** The page and PDF deliberately consume exactly the same 4:1 image. */
export async function getReadingBannerBuffer(unitId: string, passageId?: string, attemptId?: string): Promise<Buffer | null> {
  if(passageId!==undefined&&(typeof passageId!=='string'||!passageId||passageId.length>128))throw new Error('阅读篇目编号无效');
  const document = getReadingDocument(unitId, attemptId);
  const unit = passageId ? document.unit.sections?.find(section=>section.id===passageId) : document.unit;
  if(!unit)throw new Error("阅读篇目不存在");
  if (!unit.coverPath) return null;
  const key = `${unit.coverPath}:${unit.coverFocus.x}:${unit.coverFocus.y}`;
  let pending = bannerCache.get(key);
  if (!pending) {
    if (bannerCache.size >= MAX_BANNERS) bannerCache.delete(bannerCache.keys().next().value!);
    pending = renderBanner(unit.coverPath, unit.coverFocus);
    bannerCache.set(key, pending);
    pending.catch(() => bannerCache.delete(key));
  }
  return pending;
}

export async function getReadingBanner(unitId: string, passageId?: string, attemptId?: string): Promise<string | null> {
  const image = await getReadingBannerBuffer(unitId, passageId, attemptId);
  return image ? `data:image/png;base64,${image.toString('base64')}` : null;
}
