import fs from 'node:fs';
import { getAudioPath, getImagePath } from './paths';


export const assetCache = new Map<string, string>();
export let cachedBytes = 0;
export function assetDataUrl(relativePath: string, audio = false): string | null {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const key = `${audio ? 'a' : 'i'}:${relativePath}`;
  const cached = assetCache.get(key);
  if (cached) return cached;
  try {
    const full = audio ? getAudioPath(relativePath) : getImagePath(relativePath);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    let mime = '';
    if (audio) {
      if (buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 255 && (buf[1] & 224) === 224))
        mime = 'audio/mpeg';
      else if (
        buf.subarray(0, 4).toString() === 'RIFF' &&
        buf.subarray(8, 12).toString() === 'WAVE'
      )
        mime = 'audio/wav';
      else if (buf.subarray(0, 4).toString() === 'OggS') mime = 'audio/ogg';
    } else {
      if (buf[0] === 137 && buf.subarray(1, 4).toString() === 'PNG') mime = 'image/png';
      else if (buf[0] === 255 && buf[1] === 216) mime = 'image/jpeg';
      else if (
        buf.subarray(0, 4).toString() === 'RIFF' &&
        buf.subarray(8, 12).toString() === 'WEBP'
      )
        mime = 'image/webp';
    }
    if (!mime) return null;
    const result = `data:${mime};base64,${buf.toString('base64')}`;
    while (cachedBytes + result.length > 32 * 1024 * 1024 && assetCache.size) {
      const oldest = assetCache.keys().next().value;
      cachedBytes -= assetCache.get(oldest).length;
      assetCache.delete(oldest);
    }
    if (result.length <= 32 * 1024 * 1024) {
      assetCache.set(key, result);
      cachedBytes += result.length;
    }
    return result;
  } catch {
    return null;
  }
}
