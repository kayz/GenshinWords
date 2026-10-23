import { speakerInitial } from '../shared/speaker-initial';
import type { PdfRequest, PdfResult } from '../shared/models';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { dialog, app } from 'electron';
import { getImagePath } from './paths';
import {
  listBooks,
  getBookWords,
  getChapter,
  getQuestChapter,
  listQuests,
  listDialogLines,
} from './content-db';
import { getSetting } from './progress-db';

export function findFont() {
  const project = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  const assetDirs = [path.join(project, 'out/renderer/assets'), path.join(__dirname, '../renderer/assets')];
  const bundled = assetDirs.flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^NotoSerifSC-Medium.*\.otf$/.test(name)).map(name => path.join(dir,name)) : []);
  const candidates = [...bundled, path.join(project,'src/renderer/src/assets/fonts/NotoSerifSC-Medium.otf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simkai.ttf',
    'C:\\Windows\\Fonts\\SIMLI.TTF',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\NotoSansSC-Regular.otf',
    'C:\\Windows\\Fonts\\SourceHanSansSC-Regular.otf',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'Helvetica';
}
export function normalizeLemma(raw) {
  return raw.toLowerCase().replace(/'s$/, '').replace(/'$/, '');
}
export function segmentByLemmas(text, lemmas, seen) {
  const parts = text.match(/[A-Za-z']+|[^A-Za-z']+/g) || [text];
  return parts.map((p) => {
    if (/^[A-Za-z']+$/.test(p) && p.length > 1) {
      const key = normalizeLemma(p);
      const inBook = lemmas.has(key) || lemmas.has(p.toLowerCase());
      if (!inBook) return { text: p, highlight: false };
      if (seen.has(key)) return { text: p, highlight: false };
      seen.add(key);
      return { text: p, highlight: true };
    }
    return { text: p, highlight: false };
  });
}
export function isPng(buf) {
  return buf.length >= 4 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
}
export function isJpeg(buf) {
  return buf.length >= 2 && buf[0] === 255 && buf[1] === 216;
}
export function isWebp(buf) {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}
export class PdfImageLoader {
  cache = new Map();
  async load(relativePath) {
    if (!relativePath) return null;
    if (this.cache.has(relativePath)) return this.cache.get(relativePath) ?? null;
    const full = getImagePath(relativePath);
    if (!fs.existsSync(full)) {
      this.cache.set(relativePath, null);
      return null;
    }
    let result = null;
    try {
      const raw = fs.readFileSync(full);
      if (isPng(raw) || isJpeg(raw)) {
        result = raw;
      } else if (isWebp(raw)) {
        result = await sharp(raw).png().toBuffer();
      } else {
        result = await sharp(raw).png().toBuffer();
      }
    } catch {
      result = null;
    }
    this.cache.set(relativePath, result);
    return result;
  }
}
export function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}
export function drawCover(doc, buf) {
  if (!buf) return;
  const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxH = 160;
  try {
    ensureSpace(doc, maxH + 12);
    const x = doc.page.margins.left;
    const y = doc.y;
    doc.image(buf, x, y, { fit: [maxW, maxH], align: 'center' });
    doc.y = y + maxH + 10;
    doc.x = doc.page.margins.left;
  } catch {}
}
export function writeWrapped(doc, text, opts) {
  doc.font(opts.font).fontSize(opts.fontSize).fillColor(opts.color);
  doc.text(text, doc.page.margins.left + opts.indent, doc.y, {
    width: opts.width - opts.indent,
    align: 'left',
  });
}
export function writeHighlightedLine(doc, text, lemmas, seen, font, fontSize, indent) {
  const segs = segmentByLemmas(text, lemmas, seen);
  doc.font(font).fontSize(fontSize);
  const startX = doc.page.margins.left + indent;
  const maxX = doc.page.width - doc.page.margins.right;
  let x = startX;
  let y = doc.y;
  const lineHeight = fontSize * 1.4;
  for (const seg of segs) {
    const width = doc.widthOfString(seg.text);
    if (x > startX && x + width > maxX) {
      x = startX;
      y += lineHeight;
      if (y > doc.page.height - doc.page.margins.bottom - lineHeight) {
        doc.addPage();
        y = doc.page.margins.top;
      }
    }
    if (seg.highlight) {
      doc.save();
      doc.rect(x - 1, y - 1, width + 2, fontSize + 3).fill('#ffe08a');
      doc.restore();
    }
    doc.fillColor(seg.highlight ? '#7a4b00' : '#222222').text(seg.text, x, y, {
      lineBreak: false,
    });
    x += width;
  }
  doc.x = doc.page.margins.left;
  doc.y = y + lineHeight;
  doc.fillColor('#222222');
}
export const AVATAR = 28;
export const AVATAR_GAP = 8;
export function drawDialogueLine(doc, line, avatarBuf, lemmas, seen, font) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const indent = AVATAR + AVATAR_GAP;
  ensureSpace(doc, 54);
  const rowTop = doc.y;
  const rowPage = doc.page;
  let avatarDrawn = false;
  if (avatarBuf) {
    try {
      doc.image(avatarBuf, doc.page.margins.left, rowTop, {
        fit: [AVATAR, AVATAR],
      });
      avatarDrawn = true;
    } catch {}
  }
  if (!avatarDrawn) {
    const cx = doc.page.margins.left + AVATAR / 2, cy = rowTop + AVATAR / 2;
    doc.save();
    doc.circle(cx, cy, AVATAR / 2).fillAndStroke('#e8dfcc', '#b29b6a');
    doc.font(font).fontSize(13).fillColor('#233c55').text(speakerInitial(line.speaker), doc.page.margins.left, rowTop + 5, { width: AVATAR, align: 'center', lineBreak: false });
    doc.restore();
  }
  doc.y = rowTop;
  writeWrapped(doc, line.speaker || '旁白', {
    font,
    fontSize: 9,
    color: '#8a6a20',
    indent,
    width: contentWidth,
  });
  writeHighlightedLine(doc, line.text_en || '', lemmas, seen, font, 10, indent);
  if (line.text_chs) {
    writeWrapped(doc, line.text_chs, {
      font,
      fontSize: 9,
      color: '#666666',
      indent,
      width: contentWidth,
    });
  }
  if (doc.page === rowPage && doc.y < rowTop + AVATAR + 6) {
    doc.y = rowTop + AVATAR + 6;
  }
  doc.moveDown(0.25);
}
export async function exportDialoguePdf(win: BrowserWindow | null, req: PdfRequest): Promise<PdfResult> {
  const bookId = req.bookId || getSetting('currentBook', '');
  const lemmas = new Set(
    bookId ? getBookWords(bookId, 'default').map((w) => w.lemma.toLowerCase()) : [],
  );
  const seen = new Set();
  const bookMeta = listBooks().find((b) => b.id === bookId);
  let title = 'GenshinWords Script';
  let subtitle = '';
  let headerCover = null;
  let blocks = [];
  if (req.scope === 'quest') {
    const hit = getQuestChapter(req.questId);
    if (!hit) return { ok: false, error: '任务不存在' };
    title = hit.quest.title_chs || hit.quest.title_en || `Quest ${req.questId}`;
    subtitle = `${hit.chapter.source_label} · ${hit.chapter.title_chs || hit.chapter.title_en}`;
    if (hit.chapter.variant_label) title += ' · ' + hit.chapter.variant_label;
    headerCover = hit.quest.cover_path || hit.chapter.cover_path;
    blocks = [
      {
        questTitle: title,
        source: hit.chapter.source_label,
        cover: null,
        lines: listDialogLines(req.questId),
      },
    ];
  } else {
    const ch = getChapter(req.chapterId);
    if (!ch) return { ok: false, error: '章节不存在' };
    title = ch.title_chs || ch.title_en || `Chapter ${req.chapterId}`;
    if (ch.variant_label) title += ' · ' + ch.variant_label;
    subtitle = ch.source_label;
    headerCover = ch.cover_path;
    blocks = listQuests(req.chapterId).map((q) => ({
      questTitle: q.title_chs || q.title_en,
      source: ch.source_label,
      cover: q.cover_path,
      lines: listDialogLines(q.id),
    }));
  }
  const defaultName = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.pdf`;
  const saveOpts = {
    title: '导出台词 PDF',
    defaultPath: path.join(os.homedir(), 'Documents', defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts);
  if (canceled || !filePath) return { ok: false, error: '已取消' };
  const images = new PdfImageLoader();
  const fontPath = findFont();
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: {
      Title: title,
      Author: 'GenshinWords',
      Subject: 'Genshin Impact dialogue (personal study, non-commercial)',
    },
  });
  const stream = fs.createWriteStream(filePath);
  // pipeline 从创建时监听两端错误；与排版并行等待，避免漏接早期写入失败。
  const writing = pipeline(doc, stream);
  const loadImage = async (relativePath) => {
    const image = await images.load(relativePath);
    if (doc.destroyed) throw doc.errored ?? stream.errored ?? new Error('PDF 导出已中止');
    return image;
  };
  const rendering = (async () => {
    let font = 'Helvetica';
    if (fontPath !== 'Helvetica') {
      try {
        doc.registerFont('CjkFont', fontPath);
        font = 'CjkFont';
        doc.font(font);
      } catch {
        try {
          doc.font(fontPath);
          font = fontPath;
        } catch {
          font = 'Helvetica';
          doc.font('Helvetica');
        }
      }
    }
    drawCover(doc, await loadImage(headerCover));
    doc.font(font).fontSize(18).fillColor('#1a2a40').text('GenshinWords 台词导出');
    doc.moveDown(0.25);
    doc.fontSize(14).fillColor('#333333').text(title);
    if (subtitle) doc.fontSize(10).fillColor('#666666').text(`来源：${subtitle}`);
    if (bookMeta) {
      doc
        .fontSize(10)
        .fillColor('#666666')
        .text(`词书高亮：${bookMeta.name_zh}（黄色底 = 本词书单词，仅首次出现）`);
    }
    if (font === 'Helvetica') {
      doc
        .fontSize(9)
        .fillColor('#c0392b')
        .text('中文字体资源未能读取，中文可能无法显示。');
    }
    doc
      .fontSize(8)
      .fillColor('#888888')
      .text('© All rights reserved by HoYoverse. Personal non-commercial study use only.');
    doc.moveDown(0.7);
    for (const block of blocks) {
      if (doc.y > doc.page.height - 140) doc.addPage();
      if (block.cover && block.cover !== headerCover) drawCover(doc, await loadImage(block.cover));
      doc.font(font).fontSize(12).fillColor('#8a6a20').text(`[${block.source}] ${block.questTitle}`);
      doc.moveDown(0.3);
      for (const line of block.lines) {
        const avatarBuf = await loadImage(line.speaker_image);
        drawDialogueLine(doc, line, avatarBuf, lemmas, seen, font);
      }
      doc.moveDown(0.35);
    }
    doc.end();
  })();
  try {
    await Promise.all([rendering, writing]);
    return { ok: true, path: filePath };
  } catch (error) {
    doc.destroy();
    stream.destroy();
    await Promise.allSettled([rendering, writing]);
    throw error;
  }
}
