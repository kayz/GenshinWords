import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { app, dialog, type BrowserWindow } from 'electron';
import PDFDocument from 'pdfkit';
import type { PdfResult } from '../shared/models';
import type { ReadingDocument, ReadingQuestion } from '../shared/reading';
import { READING_LEVELS } from '../shared/reading';
import { annotateReadingParagraphs } from '../shared/reading-text';
import { getReadingBannerBuffer } from './reading-artwork';
import {
  assertReadingAttempt,
  getReadingDocument,
  markReadingAnswersViewed,
} from './reading';

const INK = '#243b4b';
const BODY = '#26323a';
const MUTED = '#51616d';
const GOLD = '#8b6524';
const FONT = 'ReadingText';
const PAGE_MARGIN = 46;

/** Reuse the app's OFL font, including its hashed build output inside app.asar. */
export function findReadingFont(): string {
  const appRoot = app.getAppPath();
  const directories = [
    path.resolve(__dirname, '../renderer/assets'),
    path.resolve(__dirname, '../renderer/src/assets/fonts'),
    path.join(appRoot, 'out', 'renderer', 'assets'),
    path.join(appRoot, 'src', 'renderer', 'src', 'assets', 'fonts'),
  ];
  for (const directory of new Set(directories)) {
    if (!fs.existsSync(directory)) continue;
    const filename = fs.readdirSync(directory)
      .find((entry) => /^NotoSerifSC-Medium(?:-[\w-]+)?\.otf$/i.test(entry));
    if (filename) return path.join(directory, filename);
  }
  throw new Error('未找到应用内置中文字体，请重新构建应用后导出 PDF。');
}

function pageWidth(doc): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, height: number): void {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

// Official text can contain invisible separators absent from the bundled font.
// Omit them only when printing; the verified source and saved text stay intact.
function printableText(value: string): string {
  // Keep generated blank numbers attached to their letter/underline when wrapping.
  return value.replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/(\[\d+\]) (?=[A-Za-z]?_{8})/gu, '$1\u00A0');
}

function text(doc, value: string, size = 10.5, color = BODY, indent = 0): void {
  doc.font(FONT).fontSize(size).fillColor(color);
  doc.text(printableText(value), doc.page.margins.left + indent, doc.y, {
    width: pageWidth(doc) - indent,
    lineGap: size >= 10 ? 2.5 : 1.5,
    paragraphGap: 0,
    align: 'left',
  });
  doc.x = doc.page.margins.left;
}

function heading(doc, title: string): void {
  ensureSpace(doc, 65);
  doc.moveDown(0.35);
  text(doc, title, 13, INK);
  doc.moveDown(0.25);
}

function questionLabel(question: ReadingQuestion, index: number): string {
  return `第 ${index + 1} 题`;
}

function optionLabel(option: { id: string; text: string }): string {
  return option.id === option.text.trim() ? option.id : `${option.id}. ${option.text}`;
}

function isParagraphMatching(question: ReadingQuestion): boolean {
  return Boolean(question.options?.length && question.options.every((option) =>
    /^P\d+$/.test(option.id) && option.text.trim() === option.id));
}

function questionChoices(question: ReadingQuestion): string[] {
  if(question.pooled)return [];
  if (isParagraphMatching(question)) {
    return [`可选段落：${question.options!.map((option) => option.id).join('、')}`];
  }
  return (question.options ?? []).map(optionLabel);
}

function questionHeight(doc, question: ReadingQuestion, index: number): number {
  doc.font(FONT).fontSize(10.5);
  const width = pageWidth(doc);
  const blocks = [questionLabel(question, index), question.prompt,
    ...questionChoices(question)];
  return blocks.reduce((sum, block) => sum + doc.heightOfString(printableText(block), {
    width, lineGap: 2.5,
  }), 24) + (question.type === 'fill' ? 28 : 0);
}

function paragraphHeight(doc, value: string, size = 10.5, indent = 0): number {
  doc.font(FONT).fontSize(size);
  return doc.heightOfString(printableText(value), {
    width: pageWidth(doc) - indent,
    lineGap: size >= 10 ? 2.5 : 1.5,
  });
}

function printQuestion(doc, question: ReadingQuestion, index: number): void {
  const estimated = questionHeight(doc, question, index);
  const pageBody = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  ensureSpace(doc, Math.min(estimated, pageBody));
  text(doc, questionLabel(question, index), 10.5, GOLD);
  text(doc, question.prompt);
  if (question.type === 'choice') {
    for (const choice of questionChoices(question)) text(doc, choice, 10.3, BODY, 10);
    text(doc, '答案：________', 9, MUTED);
  } else {
    const constraint = question.wordLimit ? `（最多 ${question.wordLimit} 个英文单词）` : '';
    text(doc, `答案：${question.firstLetter ? `${question.firstLetter}_______` : '________________'}${constraint}`, 9.5, MUTED);
  }
  doc.moveDown(0.45);
}

function printOptionPool(doc, options: Array<{id:string;text:string}>, wordBank: boolean): void {
  doc.moveDown(.35);
  if(!wordBank){for(const option of options)text(doc,optionLabel(option),10,INK);return;}
  const columns=3,gap=12,width=(pageWidth(doc)-(columns-1)*gap)/columns;
  for(let offset=0;offset<options.length;offset+=columns){
    const row=options.slice(offset,offset+columns);
    doc.font(FONT).fontSize(10);
    const height=Math.max(...row.map(option=>doc.heightOfString(optionLabel(option),{width,lineGap:2.5})))+8;
    ensureSpace(doc,height);
    const top=doc.y;
    row.forEach((option,index)=>doc.fillColor(INK).text(optionLabel(option),PAGE_MARGIN+index*(width+gap),top,{width,lineGap:2.5}));
    doc.x=PAGE_MARGIN;doc.y=top+height;
  }
  doc.moveDown(.35);
}

function addPageNumbers(doc, title: string): void {
  const range = doc.bufferedPageRange();
  for (let offset = 0; offset < range.count; offset++) {
    doc.switchToPage(range.start + offset);
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.strokeColor('#d6ddd9').lineWidth(0.5)
      .moveTo(PAGE_MARGIN, doc.page.height - 39)
      .lineTo(doc.page.width - PAGE_MARGIN, doc.page.height - 39).stroke();
    doc.font(FONT).fontSize(7.2).fillColor(MUTED).text(
      `GenshinWords · ${title} · ${offset + 1} / ${range.count}`,
      PAGE_MARGIN, doc.page.height - 31,
      { width: pageWidth(doc), align: 'center', lineBreak: false },
    );
    doc.restore();
    doc.page.margins.bottom = originalBottom;
  }
}

interface ReadingPdfOptions {
  fontPath?: string;
  banner?: Buffer | null;
  banners?: Record<string,Buffer|null>;
}

/** File output is kept separate from dialog/learning state so failures cannot reveal answers. */
export async function writeReadingPdf(
  filename: string,
  document: ReadingDocument,
  options: ReadingPdfOptions = {},
): Promise<void> {
  const { unit, analysis } = document;
  const paperResult = unit.paperResult ?? null;
  if (analysis.bilingualParagraphs?.length !== unit.paragraphs.length
    || analysis.bilingualParagraphs.some((paragraph, index) =>
      paragraph.paragraph !== index + 1 || (!unit.sections && paragraph.textEn !== unit.paragraphs[index]) || !paragraph.textChs.trim())) {
    throw new Error('原文与官方译文的段落配对不完整，暂时无法导出 PDF。');
  }
  const fontPath = options.fontPath ?? findReadingFont();
  const doc = new PDFDocument({
    margin: PAGE_MARGIN,
    size: 'A4',
    bufferPages: true,
    info: {
      Title: `${unit.title} - 阅读题面与解析`,
      Author: 'GenshinWords',
      Subject: `${READING_LEVELS[unit.level]} · Genshin Impact reading practice`,
    },
  });
  const destination = fs.createWriteStream(filename);
  const writing = pipeline(doc, destination);
  const rendering = (async () => {
    doc.registerFont(FONT, fontPath);
    doc.font(FONT);
    if (options.banner && !unit.sections?.length) {
      const width = pageWidth(doc);
      doc.image(options.banner, PAGE_MARGIN, doc.y, { width, height: width / 4 });
      doc.y += width / 4 + 14;
    }
    text(doc, '提瓦特阅读 · 题面', 11, GOLD);
    text(doc, unit.title, 18, INK);
    text(doc, `${READING_LEVELS[unit.level]} · ${unit.wordCount} 词 · ${unit.questionCount} 题`, 9, MUTED);
    doc.moveDown(0.3);
    text(doc, `资料来源：${unit.sourceTitle}`, 8, MUTED);
    text(doc, unit.sourceUrl, 7.5, MUTED);
    doc.moveDown(0.4);
    text(doc, `请阅读下文，完成第 1-${unit.questionCount} 题。答案与解析见文后。`, 9, MUTED);

    if(unit.sections?.length){
      for(const section of unit.sections){
        ensureSpace(doc,230);
        const image=options.banners?.[section.id];
        if(image){const width=pageWidth(doc);doc.image(image,PAGE_MARGIN,doc.y,{width,height:width/4});doc.y+=width/4+12;}
        if (unit.sections.length > 1) heading(doc, section.title);
        else doc.moveDown(0.35);
        text(doc,section.instructions,10,MUTED);
        text(doc,section.sourceTitle+' · '+section.sourceUrl,7.5,MUTED);
        if(section.optionPool?.length){
          printOptionPool(doc,section.optionPool,section.type==='word-bank');
        }
        const annotated=annotateReadingParagraphs(section.paragraphIndices.map(n=>unit.paragraphs[n-1]),section.glossary??[]);
        for(const [localIndex,number] of section.paragraphIndices.entries()){
          ensureSpace(doc,44);
          const group=section.paragraphLabels?.find(group=>group.paragraphs.includes(number));
          const label=group?(group.paragraphs[0]===number?group.label:''):'P'+number;
          const paragraph=annotated[localIndex].map(part=>part.text+(part.note?`（${part.note}）`:'')).join('');
          text(doc,(label?`[${label}] `:'')+paragraph);doc.moveDown(.4);
        }
        for(const id of section.questionIds){const index=unit.questions.findIndex(q=>q.id===id);printQuestion(doc,unit.questions[index],index);}
      }
    }else{
    heading(doc, '一、阅读原文');
    const inlineGlossary = unit.level === 'entry' || unit.level === 'sh_zhongkao'
      ? unit.glossary.filter((entry) => entry.kind === 'word') : [];
    const paragraphs = annotateReadingParagraphs(unit.paragraphs, inlineGlossary);
    paragraphs.forEach((parts, index) => {
      ensureSpace(doc, 44);
      const annotated = parts.map((part) => part.text + (part.note ? `（${part.note}）` : '')).join('');
      text(doc, `[P${index + 1}] ${annotated}`);
      doc.moveDown(0.4);
    });
    if (unit.questions.length) ensureSpace(doc, 65 + questionHeight(doc, unit.questions[0], 0));
    heading(doc, '二、阅读题目');
    unit.questions.forEach((question, index) => printQuestion(doc, question, index));

    }

    // The solution section always starts on a new page for paper-based practice.
    doc.addPage();
    text(doc, '参考答案与讲解', 18, INK);
    text(doc, unit.title, 10.5, GOLD);
    if (paperResult) text(doc, `本轮得分：${paperResult.score}/${paperResult.maxScore}`, 10.5, INK);

    heading(doc, '三、答案解析');
    unit.questions.forEach((question, index) => {
      const explanation = analysis.questions.find((entry) => entry.questionId === question.id);
      if (!explanation) return;
      const result = paperResult?.questionResults[question.id];
      const questionTitle = questionLabel(question, index) + (result ? ` · ${result.correct ? '√' : '×'}` : '');
      const answerOption = explanation.answerId
        ? question.options?.find((option) => option.id === explanation.answerId) : undefined;
      const answerText = `参考答案：${answerOption ? optionLabel(answerOption) : explanation.answer}`;
      const submitted = paperResult?.answers[question.id];
      const submittedOption = question.options?.find((option) => option.id === submitted);
      const submittedText = submitted === undefined ? ''
        : `你的答案：${submittedOption ? optionLabel(submittedOption) : submitted || '（未填写）'}`;
      const evidenceText = `原文依据：${explanation.evidence.map((number) => `P${number}`).join('、')}`;
      const blockHeight = paragraphHeight(doc, questionTitle, 11)
        + (submittedText ? paragraphHeight(doc, submittedText, 9.5) : 0)
        + paragraphHeight(doc, answerText) + paragraphHeight(doc, explanation.explanation)
        + (explanation.evidence.length ? paragraphHeight(doc, evidenceText, 9.5) : 0)
        + (explanation.optionExplanations ?? []).reduce((height, option) =>
          height + paragraphHeight(doc, `${option.id}：${option.text}`, 9.5, 10), 0)
        + 12;
      const bodyHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      ensureSpace(doc, Math.min(blockHeight, bodyHeight));
      text(doc, questionTitle, 11, GOLD);
      if (submittedText) text(doc, submittedText, 9.5, MUTED);
      text(doc, answerText, 10.5, INK);
      text(doc, explanation.explanation);
      if (explanation.evidence.length) {
        text(doc, evidenceText, 9.5, MUTED);
      }
      for (const option of explanation.optionExplanations ?? []) {
        text(doc, `${option.id}：${option.text}`, 9.5, BODY, 10);
      }
      doc.moveDown(0.5);
    });

    const firstPair = analysis.bilingualParagraphs[0];
    if (firstPair) {
      ensureSpace(doc, 85
        + paragraphHeight(doc, `[P${firstPair.paragraph}] ${firstPair.textEn}`, 10.5)
        + paragraphHeight(doc, firstPair.textChs, 10));
    }
    heading(doc, '四、原文与译文');
    for (const paragraph of analysis.bilingualParagraphs) {
      const section=unit.sections?.find(s=>s.paragraphIndices[0]===paragraph.paragraph);
      if(section && unit.sections!.length > 1)heading(doc,section.title);
      const english = `[P${paragraph.paragraph}] ${paragraph.textEn}`;
      const translation = paragraph.textChs;
      const pairHeight = paragraphHeight(doc, english, 10.5)
        + paragraphHeight(doc, translation, 10) + 20;
      const pageBody = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      ensureSpace(doc, Math.min(pairHeight, pageBody));
      text(doc, english, 10.5, INK);
      doc.moveDown(0.15);
      text(doc, translation, 10, BODY);
      doc.moveDown(0.65);
    }

    heading(doc, '五、文本解析');
    text(doc, analysis.overview);
    for (const section of analysis.structure) {
      ensureSpace(doc, 36);
      text(doc, `${section.paragraphs.map((number) => `P${number}`).join('、')}：${section.description}`, 10);
    }
    if (analysis.sentences.length) {
      heading(doc, '重点句理解');
      for (const sentence of analysis.sentences) {
        ensureSpace(doc, 64);
        text(doc, `[P${sentence.paragraph}] ${sentence.text}`, 10, INK);
        text(doc, sentence.explanation, 10);
        doc.moveDown(0.4);
      }
    }

    heading(doc, '单词解释');
    if (!analysis.glossary.length) text(doc, '本篇无额外词汇注释。');
    for (const entry of analysis.glossary) {
      ensureSpace(doc, 28);
      text(doc, `${entry.term}：${entry.explanation}`, 10);
    }
    doc.moveDown(0.6);
    text(doc, '原文、官方中文译文与题图版权归 HoYoverse 所有。题目与解析由 GenshinWords 编写。', 8, MUTED);
    addPageNumbers(doc, unit.title);
    doc.end();
  })();
  try {
    await Promise.all([rendering, writing]);
  } catch (error) {
    doc.destroy();
    destination.destroy();
    await Promise.allSettled([rendering, writing]);
    throw error;
  }
}

export async function exportReadingPdf(
  win: BrowserWindow | null,
  unitId: string,
  attemptId: string,
): Promise<PdfResult> {
  assertReadingAttempt(attemptId, unitId);
  const document = getReadingDocument(unitId, attemptId);
  const fontPath = findReadingFont();
  const banner = await getReadingBannerBuffer(unitId, undefined, attemptId);
  const banners=Object.fromEntries(await Promise.all((document.unit.sections??[]).map(async section=>[section.id,await getReadingBannerBuffer(unitId,section.id,attemptId)] as const)));
  const filename = `${document.unit.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}-阅读与解析.pdf`;
  const saveOptions = {
    title: '导出阅读题面与解析',
    defaultPath: path.join(os.homedir(), 'Documents', filename),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions);
  if (canceled || !filePath) return { ok: false, error: '已取消' };
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeReadingPdf(temporaryPath, document, {
      fontPath, banner, banners,
    });
    // Replace the selected destination only after a complete, closed PDF has been written.
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // A cancelled or failed write must never alter the current exercise round.
  markReadingAnswersViewed(attemptId, unitId);
  return { ok: true, path: filePath };
}
