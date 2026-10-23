import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mark = await sharp(path.join(root, 'src/renderer/src/assets/logo.png')).trim().png().toBuffer();
// Remove only transparent margins so the approved mark stays legible at taskbar sizes.
await fs.writeFile(path.join(root, 'src/renderer/src/assets/logo.png'), mark);
async function framed(size) {
  const inset = size >= 48 ? 2 : 1;
  const stroke = size >= 128 ? 2 : 1;
  const image = mark.toString('base64');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#2a435b"/><stop offset="1" stop-color="#111f32"/></linearGradient></defs><rect x="'+stroke/2+'" y="'+stroke/2+'" width="'+(size-stroke)+'" height="'+(size-stroke)+'" rx="'+size*.23+'" fill="url(#b)" stroke="#d1b57c" stroke-width="'+stroke+'"/><image x="'+inset+'" y="'+inset+'" width="'+(size-inset*2)+'" height="'+(size-inset*2)+'" href="data:image/png;base64,'+image+'"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const sizes = [16,20,24,32,40,48,64,128,256];
const pngs = await Promise.all(sizes.map(framed));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i=0; i<sizes.length; i++) {
  const at=6+i*16, size=sizes[i];
  header[at]=size===256?0:size; header[at+1]=size===256?0:size;
  header.writeUInt16LE(1,at+4); header.writeUInt16LE(32,at+6);
  header.writeUInt32LE(pngs[i].length,at+8); header.writeUInt32LE(offset,at+12);
  offset += pngs[i].length;
}
await fs.writeFile(path.join(root,'resources/icon.ico'),Buffer.concat([header,...pngs]));
await fs.writeFile(path.join(root,'resources/icon.png'),await framed(512));
console.log(JSON.stringify({ok:true,icoSizes:sizes,theme:'champagne-gold / navy'}));
