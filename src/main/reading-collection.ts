import type { CollectReadingRequest, CollectResult, ReadingCollectedSource } from '../shared/collection';
import { wordTokens } from '../shared/text';
import { lookupWordByLemma } from './content-db';
import { saveCollectedWord } from './collections';
import { getReadingParagraphForCollection } from './reading';

export function collectFromReading(request: CollectReadingRequest): CollectResult {
  if (!request || typeof request.attemptId !== 'string' || !Number.isSafeInteger(request.paragraph) ||
    !Number.isSafeInteger(request.start) || !Number.isSafeInteger(request.end) ||
    request.start < 0 || request.end <= request.start)
    throw new Error('请选择官方英文原文中的完整单词。');
  const paragraph = getReadingParagraphForCollection(request.attemptId, request.paragraph);
  const token = wordTokens(paragraph.textEn).find(part => part.start === request.start && part.end === request.end);
  if (!token) throw new Error('请选择官方英文原文中的完整单词。');
  const word = lookupWordByLemma(token.text);
  if (!word) throw new Error('本地词库未收录：' + token.text);
  const sentences = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph.textEn);
  const sentence = Array.from(sentences).find(
    part => part.index <= token.start && part.index + part.segment.length >= token.end,
  );
  if (!sentence) throw new Error('无法定位单词所在的原句。');
  const source: ReadingCollectedSource = {
    kind: 'collection', origin: 'reading', unitId: paragraph.unitId, paragraph: paragraph.paragraph, attemptId: request.attemptId,
    title: paragraph.title, sourceTitle: paragraph.sourceTitle, sourceUrl: paragraph.sourceUrl,
    coverPath: paragraph.coverPath, text: sentence.segment, start: token.start - sentence.index,
    end: token.end - sentence.index, surface: token.text,
    // 官方中译仅经人工核对到整段，不将整段伪装成点击句子的逐句对照译文。
    textChs: paragraph.textChs, collectedAt: new Date().toISOString(),
  };
  return saveCollectedWord(word, source);
}
