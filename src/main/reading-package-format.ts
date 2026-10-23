import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import * as zlib from 'node:zlib';
import { TextDecoder } from 'node:util';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { BankQuestion, ReadingDefinition } from './reading-bank-types';
import type { IndependentReadingDefinition, PaperPassageDefinition, ReadingPaperDefinition } from './reading-paper-types';
import { composeIndependentReading, composeReadingPaper, composeReadingPassage, paperSections } from './reading-paper-compose';
import { annotateReadingParagraphs } from '../shared/reading-text';
import type { ReadingGloss } from '../shared/reading';
import type { ReadingPackageData, ReadingPackageParagraphs, ReadingPackageSource, ValidatedReadingPackage } from '../shared/reading-package';
export type { ReadingPackageData, ValidatedReadingPackage } from '../shared/reading-package';

/** These limits apply before materializing assets or activating any content. */
export const READING_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024, decompressedBytes: 160 * 1024 * 1024,
  units: 500, questions: 5000, sources: 1000, images: 256,
  imageBytes: 32 * 1024 * 1024, totalImageBytes: 96 * 1024 * 1024,
  imagePixels: 64 * 1024 * 1024, sourceCharacters: 2 * 1024 * 1024,
});
type Obj = Record<string, unknown>;
function fail(where: string, message: string): never { throw new Error(`阅读题库 ${where}：${message}`); }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const own = (value: Obj, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function obj(value: unknown, where: string, allowed: string[], required = allowed): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(where, '必须是 JSON 对象');
  const result = value as Obj;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(where, `不支持字段 ${key}`);
  for (const key of required) if (!own(result, key)) fail(where, `缺少 ${key}`);
  return result;
}
function str(value: unknown, where: string, max = 24000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(where, '文字为空、过长或含控制字符');
  return value as string;
}
function id(value: unknown, where: string): string {
  const text = str(value, where, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) || own(Object.prototype as Obj, text) || text === 'prototype') fail(where, '编号只允许字母、数字、点、冒号、下划线及连字符，且不能使用原型保留名称');
  return text;
}
function int(value: unknown, where: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(where, `整数必须在 ${min}–${max} 内`);
  return value as number;
}
function arr(value: unknown, where: string, min = 0, max = 5000): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(where, `数组长度必须在 ${min}–${max} 内`);
  return value as unknown[];
}
function unique(values: unknown[], where: string) { if (new Set(values).size !== values.length) fail(where, '存在重复值'); }
function url(value: unknown, where: string) {
  const text = str(value, where, 4096);
  let parsed: URL;
  try { parsed = new URL(text); } catch { return fail(where, '来源必须是完整的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(where, '来源必须是无凭据的 HTTP(S) 地址');
}
function sha(value: unknown, where: string) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(where, 'SHA-256 无效'); }
export function validateReadingPackagePath(value: unknown): string {
  const text = str(value, '资源路径', 240);
  if (text.includes('\\') || text.includes(':') || text.startsWith('/') || text.split('/').some(part => !part || part === '.' || part === '..') || !/^[A-Za-z0-9_./-]+$/.test(text)) fail('资源路径', '禁止绝对路径、反斜线、空段和路径跳转');
  if (!/\.(?:png|jpe?g|webp)$/i.test(text)) fail('资源路径', '只允许 PNG、JPEG 或 WebP 图片');
  return text;
}
function version(value: unknown, where: string): string {
  const text = str(value, where, 128);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(text)) fail(where, '版本须使用严格 SemVer');
  return text;
}
export function compareReadingPackageVersions(a: string, b: string): number {
  version(a, '版本'); version(b, '版本');
  const parse = (value: string) => { const bare = value.split('+')[0], dash = bare.indexOf('-'); return { core: (dash < 0 ? bare : bare.slice(0, dash)).split('.').map(BigInt), pre: dash < 0 ? undefined : bare.slice(dash + 1).split('.') }; };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index], y = right.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
/** Stable key ordering makes digests independent of JSON formatting and object key order. */
export function canonicalReadingPackageJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalReadingPackageJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => (value as Obj)[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonicalReadingPackageJson((value as Obj)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function guardJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 300000 || depth > 32) fail('JSON', '结构过大或嵌套过深');
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > READING_PACKAGE_LIMITS.decompressedBytes) fail('JSON', '文字和嵌入资源总量超过限制');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) guardJson(child, depth + 1, budget); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('JSON', '禁止原型字段');
      budget.bytes += Buffer.byteLength(key, 'utf8'); if (budget.bytes > READING_PACKAGE_LIMITS.decompressedBytes) fail('JSON', '字段和资源总量超过限制');
      guardJson(child, depth + 1, budget);
    }
    return;
  }
  fail('JSON', '只允许 JSON 数据');
}
function level(value: unknown, where: string) { if (!['entry', 'sh_zhongkao', 'sh_gaokao', 'cet4', 'cet6'].includes(String(value))) fail(where, '阅读级别无效'); }
function focus(value: unknown, where: string) {
  const data = obj(value, where, ['x', 'y']);
  for (const key of ['x', 'y']) if (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || Number(data[key]) < 0 || Number(data[key]) > 1) fail(where, '图片焦点须在0至1之间');
}
function glosses(value: unknown, where: string) {
  arr(value, where, 0, 300).forEach((entry, index) => {
    const data = obj(entry, `${where}[${index}]`, ['term', 'explanation', 'kind']);
    str(data.term, where, 300); str(data.explanation, where, 4000);
    if (!['word', 'genshin'].includes(String(data.kind))) fail(where, '词注类型无效');
  });
}
function numbers(value: unknown, where: string, valid: number[], min = 1): number[] {
  const values = arr(value, where, min, 2000).map(n => int(n, where, 1, 100000)); unique(values, where);
  if (values.some(n => !valid.includes(n))) fail(where, '段号未被选取或超出原文');
  return values;
}
function options(value: unknown, where: string) {
  const values = arr(value, where, 2, 26).map(entry => {
    const data = obj(entry, where, ['id', 'text']); id(data.id, where); str(data.text, where, 8000); return data;
  });
  unique(values.map(entry => entry.id), where);
  return values;
}
function analysis(value: unknown, where: string, indices: number[], source: string[]) {
  const data = obj(value, where, ['overview', 'structure', 'sentences']); str(data.overview, where);
  arr(data.structure, where, 1, 1000).forEach(entry => { const part = obj(entry, where, ['paragraphs', 'description']); numbers(part.paragraphs, where, indices); str(part.description, where); });
  arr(data.sentences, where, 1, 1000).forEach(entry => {
    const part = obj(entry, where, ['paragraph', 'text', 'explanation']); const n = int(part.paragraph, where, 1, source.length);
    if (!indices.includes(n)) fail(where, '精读句不在选段内');
    const text = str(part.text, where); str(part.explanation, where);
    if (!source[n - 1].includes(text)) fail(where, `P${n} 精读引句不匹配原文`);
  });
}
function question(value: unknown, where: string, indices: number[], pool?: unknown): BankQuestion {
  const data = obj(value, where, ['id', 'type', 'format', 'prompt', 'skill', 'hint', 'options', 'firstLetter', 'wordLimit', 'expected', 'accepted', 'solution', 'passageId', 'pooled'], ['id', 'type', 'format', 'prompt', 'skill', 'hint', 'expected', 'solution']);
  id(data.id, where); for (const key of ['format', 'prompt', 'skill', 'expected']) str(data[key], `${where}.${key}`);
  if (data.hint !== '') str(data.hint, `${where}.hint`);
  if (!['choice', 'fill'].includes(String(data.type))) fail(where, '仅支持选择与填空判分');
  if (data.passageId !== undefined) id(data.passageId, where);
  if (data.pooled !== undefined && typeof data.pooled !== 'boolean') fail(where, 'pooled 必须是布尔值');
  if (data.wordLimit !== undefined) int(data.wordLimit, where, 1, 30);
  if (data.firstLetter !== undefined && (typeof data.firstLetter !== 'string' || !/^[A-Za-z]$/.test(data.firstLetter))) fail(where, '首字母无效');
  if (data.accepted !== undefined) { const values = arr(data.accepted, where, 0, 30); values.forEach(answer => str(answer, where, 1000)); unique(values, where); }
  let choices: Obj[] = [];
  if (data.type === 'choice') {
    if (data.firstLetter !== undefined || data.accepted !== undefined || data.wordLimit !== undefined) fail(where, '选择题不能设置填空判分字段');
    choices = options(data.options ?? pool, where);
    if (!choices.some(entry => entry.id === data.expected)) fail(where, '答案不在完整选项中');
  } else {
    if (data.options !== undefined) fail(where, '填空题不能设置选项');
    const answers = [data.expected, ...(data.accepted as unknown[] ?? [])];
    if (data.firstLetter && answers.some(answer => !String(answer).toLowerCase().startsWith(String(data.firstLetter).toLowerCase()))) fail(where, '首字母与答案或可接受变式不符');
    if (data.wordLimit && answers.some(answer => String(answer).trim().split(/\s+/u).length > Number(data.wordLimit))) fail(where, '可接受答案超出词数限制');
  }
  const solution = obj(data.solution, where, ['questionId', 'answer', 'answerId', 'explanation', 'evidence', 'optionExplanations'], ['questionId', 'answer', 'explanation', 'evidence']);
  if (solution.questionId !== data.id) fail(where, '解析题号不匹配'); str(solution.answer, where); str(solution.explanation, where); numbers(solution.evidence, where, indices);
  if (solution.answerId !== undefined && (data.type !== 'choice' || solution.answerId !== data.expected)) fail(where, '解析答案与判分不符');
  if (data.type === 'choice') {
    const displayed = String(solution.answer), prefix = displayed.match(/^([A-Z])[.、:：)]\s*/);
    if (prefix && prefix[1] !== data.expected || displayed.replace(/^[A-Z][.、:：)]\s*/, '') !== choices.find(entry => entry.id === data.expected)!.text) fail(where, '解析显示答案与正确选项不一致');
  }
  if (solution.optionExplanations !== undefined) {
    if (data.type !== 'choice') fail(where, '填空题不能设置选项解析');
    const explanations = arr(solution.optionExplanations, where, choices.length, choices.length).map(entry => { const part = obj(entry, where, ['id', 'text']); str(part.text, where); return part.id; });
    unique(explanations, where); if (choices.some(entry => !explanations.includes(entry.id))) fail(where, '选项解析未覆盖全部选项');
  }
  return value as BankQuestion;
}
const normalize = (value: string) => value.normalize('NFKC').replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ').toLowerCase();
function sourceFor(value: Obj, sources: Map<string, ReadingPackageSource>, where: string) {
  const source = sources.get(id(value.materialId, where));
  if (!source || value.textSha256 !== source.en.sha256 || value.chsTextSha256 !== source.chs.sha256 || value.bilingualAlignmentVerified !== true) fail(where, '双语原文缺失、哈希不符或未经配对核对');
  str(value.sourceTitle, where); url(value.sourceUrl, where);
  return source;
}
function passage(value: unknown, sources: Map<string, ReadingPackageSource>, imagePaths: Set<string>, where: string): IndependentReadingDefinition {
  const data = obj(value, where, ['id', 'title', 'type', 'instructions', 'materialId', 'textSha256', 'chsTextSha256', 'bilingualAlignmentVerified', 'paragraphMap', 'coverPath', 'coverFocus', 'sourceTitle', 'sourceUrl', 'questions', 'glossary', 'analysisGlossary', 'analysis', 'masks', 'optionPool', 'paragraphLabels', 'level', 'estimatedMinutes'], ['id', 'title', 'type', 'instructions', 'materialId', 'textSha256', 'chsTextSha256', 'bilingualAlignmentVerified', 'paragraphMap', 'coverPath', 'coverFocus', 'sourceTitle', 'sourceUrl', 'questions', 'glossary', 'analysis', 'level']);
  id(data.id, where); str(data.title, where, 300); str(data.instructions, where); level(data.level, where);
  if (data.estimatedMinutes !== undefined) int(data.estimatedMinutes, where, 0, 600);
  if (!['reading', 'cloze', 'initial-fill', 'word-bank', 'sentence-gap', 'matching', 'information'].includes(String(data.type))) fail(where, '题型不受当前引擎支持');
  const source = sourceFor(data, sources, where);
  if (!imagePaths.has(validateReadingPackagePath(data.coverPath))) fail(where, '未打包题图'); focus(data.coverFocus, where);
  const maps = arr(data.paragraphMap, where, 1, 2000).map(entry => {
    const pair = obj(entry, where, ['en', 'chs']); const en = int(pair.en, where, 1, source.en.paragraphs.length);
    const chs = numbers(pair.chs, where, source.chs.paragraphs.map((_, i) => i + 1));
    if (chs.some((n, i) => i > 0 && n <= chs[i - 1])) fail(where, '中文段号须递增');
    return { en, chs };
  });
  if (maps.some((pair, i) => i > 0 && pair.en <= maps[i - 1].en)) fail(where, '英文原段须按原文顺序且不能重复');
  if (maps.some((pair, i) => i > 0 && pair.chs[0] <= maps[i - 1].chs[maps[i - 1].chs.length - 1])) fail(where, '中文配对须按原文顺序且不能重复');
  const indices = maps.map(pair => pair.en);
  if (data.optionPool !== undefined) options(data.optionPool, where);
  const questions = arr(data.questions, where, 1, 100).map((entry, i) => question(entry, `${where}.questions[${i}]`, indices, data.optionPool)); unique(questions.map(q => q.id), where);
  if (data.paragraphLabels !== undefined) {
    const labels = arr(data.paragraphLabels, where, 1, 26).map(entry => { const label = obj(entry, where, ['label', 'paragraphs']); id(label.label, where); return { label: label.label, paragraphs: numbers(label.paragraphs, where, indices) }; });
    unique(labels.map(label => label.label), where); unique(labels.flatMap(label => label.paragraphs), where);
    if (data.type === 'matching' && labels.flatMap(label => label.paragraphs).length !== indices.length) fail(where, '匹配题分组必须覆盖每一选段');
    if (data.type === 'matching' && questions.some(q => q.type !== 'choice' || (q.options ?? data.optionPool as BankQuestion['options'])!.some(option => !labels.some(label => label.label === option.id)))) fail(where, '匹配题的每个选项必须引用已定义的自然段组');
  } else if (data.type === 'matching') fail(where, '匹配题缺少自然段分组');
  glosses(data.glossary, where); if (data.analysisGlossary !== undefined) glosses(data.analysisGlossary, where); analysis(data.analysis, where, indices, source.en.paragraphs);
  const masks = arr(data.masks ?? [], where, 0, 100).map(entry => {
    const mask = obj(entry, where, ['paragraph', 'start', 'end', 'questionId', 'expectedText']);
    const n = int(mask.paragraph, where, 1, source.en.paragraphs.length); if (!indices.includes(n)) fail(where, '挖空未在所选原段中');
    const original = source.en.paragraphs[n - 1], start = int(mask.start, where, 0, original.length), end = int(mask.end, where, start + 1, original.length);
    const target = str(mask.expectedText, where); if (original.slice(start, end) !== target) fail(where, 'UTF-16 挖空偏移与原文不匹配');
    if ((start > 0 && /[\uD800-\uDBFF]/.test(original[start - 1]) && /[\uDC00-\uDFFF]/.test(original[start])) || (end < original.length && /[\uD800-\uDBFF]/.test(original[end - 1]) && /[\uDC00-\uDFFF]/.test(original[end]))) fail(where, '挖空不能截断 UTF-16 字符');
    const q = questions.find(item => item.id === mask.questionId); if (!q) fail(where, '挖空题号不存在');
    const accepted = q.type === 'choice' ? [(q.options ?? data.optionPool as BankQuestion['options'])!.find(option => option.id === q.expected)!.text] : [q.expected, ...(q.accepted ?? [])];
    if (!accepted.some(answer => normalize(answer) === normalize(target))) fail(where, '挖空与标准答案不一致');
    return { paragraph: n, start, end, questionId: q.id, expectedText: target };
  });
  for (const mask of masks) if (masks.some(other => other !== mask && other.paragraph === mask.paragraph && other.start < mask.end && mask.start < other.end)) fail(where, '正文空位重叠');
  if (['cloze', 'initial-fill', 'word-bank', 'sentence-gap'].includes(String(data.type)) && questions.some(q => masks.filter(mask => mask.questionId === q.id).length !== 1)) fail(where, '每道挖空题须恰有一个正文空位');
  return value as IndependentReadingDefinition;
}
function classic(value: unknown, sources: Map<string, ReadingPackageSource>, imagePaths: Set<string>, where: string): ReadingDefinition {
  const data = obj(value, where, ['id', 'title', 'level', 'background', 'materialId', 'textSha256', 'chsTextSha256', 'bilingualAlignmentVerified', 'wordCount', 'paragraphCount', 'sourceTitle', 'sourceUrl', 'coverPath', 'coverFocus', 'glossary', 'questions', 'analysisGlossary', 'analysis', 'kind', 'estimatedMinutes', 'practiceType'], ['id', 'title', 'level', 'background', 'materialId', 'textSha256', 'chsTextSha256', 'bilingualAlignmentVerified', 'wordCount', 'paragraphCount', 'sourceTitle', 'sourceUrl', 'coverPath', 'coverFocus', 'glossary', 'questions', 'analysis']);
  id(data.id, where); str(data.title, where); str(data.background, where); level(data.level, where);
  if (data.kind !== undefined && data.kind !== 'single') fail(where, 'classic 只支持单篇历史题');
  if (data.estimatedMinutes !== undefined) int(data.estimatedMinutes, where, 0, 600);
  if (data.practiceType !== undefined && data.practiceType !== 'reading') fail(where, 'classic 题型无效');
  const source = sourceFor(data, sources, where), indices = source.en.paragraphs.map((_, i) => i + 1);
  if (source.chs.paragraphs.length !== indices.length) fail(where, '历史单篇缺少逐段对应的中文原文');
  int(data.wordCount, where, 1, 100000); if (data.paragraphCount !== indices.length) fail(where, '历史单篇原段数量不匹配');
  if (!imagePaths.has(validateReadingPackagePath(data.coverPath))) fail(where, '未打包题图'); focus(data.coverFocus, where);
  glosses(data.glossary, where); if (data.analysisGlossary !== undefined) glosses(data.analysisGlossary, where);
  const questions = arr(data.questions, where, 1, 100).map(entry => question(entry, where, indices)); unique(questions.map(q => q.id), where);
  analysis(data.analysis, where, indices, source.en.paragraphs);
  return value as ReadingDefinition;
}
function loadParagraphs(unit: ReadingDefinition, sources: Map<string, ReadingPackageSource>): ReadingPackageParagraphs {
  if (!unit.paper) { const source = sources.get(unit.materialId)!; return { en: [...source.en.paragraphs], chs: [...source.chs.paragraphs], masked: [...source.en.paragraphs] }; }
  const en: string[] = [], chs: string[] = [], masked: string[] = [], selected = new Set<string>();
  for (const p of unit.paper.passages) {
    const source = sources.get(p.materialId)!;
    for (const pair of p.paragraphMap) {
      const key = p.materialId + ':' + pair.en; if (selected.has(key)) fail(unit.id, '同卷重复原文可能泄露答案'); selected.add(key);
      const original = source.en.paragraphs[pair.en - 1]; let visible = original;
      for (const mask of [...(p.masks ?? [])].filter(mask => mask.paragraph === pair.en).sort((a, b) => b.start - a.start)) {
        const q = unit.questions.find(q => q.id === mask.questionId)!;
        visible = visible.slice(0, mask.start) + `[${unit.questions.indexOf(q) + 1}] ${q.firstLetter ?? ''}________` + visible.slice(mask.end);
      }
      en.push(original); chs.push(pair.chs.map(n => source.chs.paragraphs[n - 1]).join('\n')); masked.push(visible);
    }
  }
  // Check the actual inline notes after the same filtering used by the reader.
  const sections = paperSections(unit.paper, masked);
  for (let index = 0; index < sections.length; index++) {
    const p = unit.paper.passages[index], targets = [...(p.masks ?? []).map(mask => mask.expectedText), ...p.questions.filter(q => q.type === 'fill').flatMap(q => [q.expected, ...(q.accepted ?? [])])];
    for (const gloss of sections[index].glossary ?? [] as ReadingGloss[]) if (annotateReadingParagraphs(targets, [gloss]).some(parts => parts.some(part => part.note))) fail(p.id, '有效题面词注泄漏填空目标');
  }
  return { en, chs, masked };
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer) {
  const native = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
  if (native) return native(bytes);
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function imageDimensions(bytes: Buffer, mime: string, where: string): { width: number; height: number } {
  if (mime === 'image/png' && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13 && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) {
    let hasPixels = false, headerCount = 0;
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) fail(where, 'PNG 数据块不完整');
      const length = bytes.readUInt32BE(offset), end = offset + length + 12, kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (end > bytes.length || !/^[A-Za-z]{4}$/.test(kind) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail(where, 'PNG 数据块校验失败');
      if (kind === 'IHDR') headerCount++;
      if (kind === 'IDAT' && length) hasPixels = true;
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) fail(where, '题图不支持动画 PNG');
      if (kind === 'IEND' && (length !== 0 || end !== bytes.length)) fail(where, 'PNG 尾部无效');
      offset = end;
    }
    if (headerCount !== 1 || !hasPixels || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) fail(where, 'PNG 缺少有效像素数据');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let dimensions: { width: number; height: number } | undefined;
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) { if (dimensions && offset + 2 < bytes.length && bytes.readUInt16BE(offset) >= 6 && offset + bytes.readUInt16BE(offset) < bytes.length - 2) return dimensions; break; }
      if (marker === 0xd9) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 1) continue;
      if (offset + 2 > bytes.length) break; const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += length;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let hasPixels = false;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) fail(where, 'WebP 数据块不完整');
      const length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length + length % 2, kind = bytes.toString('ascii', offset, offset + 4);
      if (end > bytes.length) fail(where, 'WebP 数据块超出文件');
      if (kind === 'ANIM' || kind === 'ANMF') fail(where, '题图不支持动画 WebP');
      if (kind === 'VP8 ' && length >= 10 || kind === 'VP8L' && length >= 5) hasPixels = true;
      offset = end;
    }
    if (!hasPixels) fail(where, 'WebP 缺少像素数据');
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.readUInt32LE(16) === 10) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
  }
  return fail(where, '图片字节、类型或尺寸头无效');
}

interface ImageToDecode { bytes: Buffer; key: string; where: string; width: number; height: number }
// Digests enter this bounded cache only after hashing the supplied bytes and fully decoding them.
// It avoids decoding unchanged immutable artwork again for preview/commit/archive in one process.
const imageCacheKey = Symbol.for('genshinwords.reading.decoded-images.v2');
const imageCacheHost = globalThis as unknown as Record<symbol, Map<string, Readonly<{ width: number; height: number }>> | undefined>;
const decodedImages: Map<string, Readonly<{ width: number; height: number }>> = imageCacheHost[imageCacheKey] ?? (imageCacheHost[imageCacheKey] = new Map());
const IMAGE_DECODER_WORKER = String.raw`
const { workerData } = require('node:worker_threads');
const state = new Int32Array(workerData.state);
const errorBytes = new Uint8Array(workerData.error);
(async () => {
  const sharp = require(workerData.sharpPath);
  for (let index = 0; index < workerData.images.length; index++) {
    Atomics.store(state, 1, index);
    const image = workerData.images[index];
    const decoder = sharp(Buffer.from(image.bytes), { failOn: 'warning', limitInputPixels: workerData.limit, sequentialRead: true });
    const metadata = await decoder.metadata();
    if ((metadata.pages || 1) !== 1) throw Error('Animated artwork is unsupported');
    const { info } = await decoder.raw().toBuffer({ resolveWithObject: true });
    if (info.width !== image.width || info.height !== image.height) throw Error('Decoded dimensions differ from the image container');
  }
  Atomics.store(state, 0, 1);
})().catch(error => {
  const text = new TextEncoder().encode(error instanceof Error ? error.message : String(error));
  errorBytes.set(text.subarray(0, errorBytes.length));
  Atomics.store(state, 0, -1);
}).finally(() => { Atomics.notify(state, 0); });
`;
/** Decode compressed pixels in trusted Node code; no author file is ever evaluated. */
function validateImagePixels(images: ImageToDecode[]) {
  const pending = images.filter(image => !decodedImages.has(image.key));
  if (!pending.length) return;
  const stateBuffer = new SharedArrayBuffer(8), state = new Int32Array(stateBuffer), errorBuffer = new SharedArrayBuffer(2048);
  let worker: Worker;
  try {
    worker = new Worker(IMAGE_DECODER_WORKER, { eval: true, workerData: {
      sharpPath: createRequire(__filename).resolve('sharp'), state: stateBuffer, error: errorBuffer,
      images: pending.map(({ bytes, width, height }) => ({ bytes, width, height })), limit: READING_PACKAGE_LIMITS.imagePixels,
    }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
  } catch { return fail('images', '无法启动可信图片解码器'); }
  // Startup failures are reported through the shared state when possible. An unexpected
  // worker failure or native decoder stall still fails closed at the bounded timeout.
  worker.on('error', () => {});
  try {
    if (Atomics.load(state, 0) === 0) Atomics.wait(state, 0, 0, 30000);
    const index = Math.min(pending.length - 1, Math.max(0, Atomics.load(state, 1)));
    if (Atomics.load(state, 0) !== 1) {
      const raw = new Uint8Array(errorBuffer), end = raw.indexOf(0), message = new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end));
      fail(pending[index].where, message ? '图片像素流无法完整解码：' + message : '图片像素解码失败或超时');
    }
    for (const image of pending) {
      if (decodedImages.size >= 512) decodedImages.delete(decodedImages.keys().next().value!);
      decodedImages.set(image.key, Object.freeze({ width: image.width, height: image.height }));
    }
  } finally { void worker.terminate(); }
}

export function validateReadingPackage(input: unknown, options: { appVersion?: string } = {}): ValidatedReadingPackage {
  guardJson(input);
  const root = obj(input, '根对象', ['format', 'formatVersion', 'manifest', 'units', 'legacyGroups', 'sources', 'images']);
  if (root.format !== 'genshinwords.reading' || root.formatVersion !== 1) fail('格式', '不支持的题库格式或格式版本');
  const manifest = obj(root.manifest, 'manifest', ['id', 'name', 'version', 'minAppVersion', 'maxAppVersion', 'engineVersion', 'createdAt', 'description'], ['id', 'name', 'version', 'minAppVersion', 'engineVersion', 'createdAt']);
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(id(manifest.id, 'manifest.id'))) fail('manifest.id', '题库ID须为小写字母、数字、点及连字符');
  str(manifest.name, 'manifest.name', 200); version(manifest.version, 'manifest.version'); version(manifest.minAppVersion, 'manifest.minAppVersion');
  if (manifest.maxAppVersion !== undefined) { version(manifest.maxAppVersion, 'manifest.maxAppVersion'); if (compareReadingPackageVersions(String(manifest.maxAppVersion), String(manifest.minAppVersion)) < 0) fail('manifest', '最大应用版本小于最低版本'); }
  if (manifest.engineVersion !== 1) fail('manifest.engineVersion', '不支持该题型引擎版本');
  const created = str(manifest.createdAt, 'manifest.createdAt', 40); if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(created) || !Number.isFinite(Date.parse(created)) || new Date(created).toISOString().slice(0, 10) !== created.slice(0, 10)) fail('manifest.createdAt', '须为有效 ISO 日期或 UTC 时间');
  if (manifest.description !== undefined) str(manifest.description, 'manifest.description', 4000);
  if (options.appVersion !== undefined) {
    version(options.appVersion, '应用版本');
    if (compareReadingPackageVersions(options.appVersion, String(manifest.minAppVersion)) < 0 || manifest.maxAppVersion !== undefined && compareReadingPackageVersions(options.appVersion, String(manifest.maxAppVersion)) > 0) fail('manifest', '当前应用版本不满足题库要求');
  }
  const sourceMap = new Map<string, ReadingPackageSource>();
  for (const [index, entry] of arr(root.sources, 'sources', 1, READING_PACKAGE_LIMITS.sources).entries()) {
    const where = `sources[${index}]`, data = obj(entry, where, ['id', 'title', 'url', 'en', 'chs']); const key = id(data.id, where);
    if (sourceMap.has(key)) fail(where, '重复原文ID'); str(data.title, where, 1000); url(data.url, where);
    for (const locale of ['en', 'chs']) {
      const text = obj(data[locale], where, ['text', 'sha256', 'paragraphs']); const full = str(text.text, where, READING_PACKAGE_LIMITS.sourceCharacters); sha(text.sha256, where);
      if (hash(full) !== text.sha256) fail(where, `${locale} 原文 SHA-256 不匹配`);
      const rows = arr(text.paragraphs, where, 1, 10000).map(line => str(line, where, READING_PACKAGE_LIMITS.sourceCharacters));
      const original = full.split('\n').filter(line => line.trim());
      if (rows.length !== original.length || rows.some((line, i) => line !== original[i])) fail(where, `${locale} 段落与完整原文不匹配`);
    }
    sourceMap.set(key, entry as ReadingPackageSource);
  }
  const imagePaths = new Set<string>(), imagesToDecode: ImageToDecode[] = []; let totalImageBytes = 0;
  for (const [index, entry] of arr(root.images, 'images', 1, READING_PACKAGE_LIMITS.images).entries()) {
    const where = `images[${index}]`, data = obj(entry, where, ['path', 'mimeType', 'sha256', 'sourceTitle', 'sourceUrl', 'dataBase64']); const name = validateReadingPackagePath(data.path);
    if (imagePaths.has(name.toLowerCase())) fail(where, '重复图片路径'); imagePaths.add(name.toLowerCase());
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(data.mimeType))) fail(where, '不支持的资源类型');
    const expectedMime = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg'; if (data.mimeType !== expectedMime) fail(where, '文件扩展名与 MIME 不符');
    sha(data.sha256, where); str(data.sourceTitle, where, 1000); url(data.sourceUrl, where);
    const base64 = str(data.dataBase64, where, Math.ceil(READING_PACKAGE_LIMITS.imageBytes / 3) * 4);
    if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail(where, 'base64 图片编码无效');
    const bytes = Buffer.from(base64, 'base64'); if (!bytes.length || bytes.length > READING_PACKAGE_LIMITS.imageBytes || bytes.toString('base64') !== base64 || hash(bytes) !== data.sha256) fail(where, '图片长度、编码或 SHA-256 无效');
    totalImageBytes += bytes.length; if (totalImageBytes > READING_PACKAGE_LIMITS.totalImageBytes) fail(where, '图片总量超过限制');
    const key = String(data.mimeType) + ':' + String(data.sha256);
    const size = decodedImages.get(key) ?? imageDimensions(bytes, String(data.mimeType), where); if (!size.width || !size.height || size.width * size.height > READING_PACKAGE_LIMITS.imagePixels) fail(where, '图片像素数量超过限制');
    imagesToDecode.push({ bytes, key, where, ...size });
  }
  validateImagePixels(imagesToDecode);
  // Actual references are case sensitive; duplicate detection above also rejects Windows aliases.
  const exactImages = new Set((root.images as Obj[]).map(entry => String(entry.path)));
  const json = canonicalReadingPackageJson(root); if (Buffer.byteLength(json, 'utf8') > READING_PACKAGE_LIMITS.decompressedBytes) fail('JSON', '解压后数据超过限制');
  const data = JSON.parse(json) as ReadingPackageData;
  const definitions = new Map<string, IndependentReadingDefinition>(), classicUnits = new Map<string, ReadingDefinition>();
  const unitRecords = arr(data.units, 'units', 1, READING_PACKAGE_LIMITS.units);
  for (const [index, entry] of unitRecords.entries()) {
    const where = `units[${index}]`, record = obj(entry, where, ['kind', 'definition', 'composition', 'legacyGroupId'], ['kind', 'definition']);
    let unitId: string;
    if (record.kind === 'passage') {
      const p = passage(record.definition, sourceMap, exactImages, where); unitId = p.id;
      if (record.composition !== undefined && !['independent', 'split'].includes(String(record.composition))) fail(where, '组合方式无效');
      if (record.composition === 'split') id(record.legacyGroupId, where); else if (record.legacyGroupId !== undefined) fail(where, '独立篇目不能指定历史容器');
      definitions.set(unitId, p);
    } else if (record.kind === 'classic') {
      if (record.composition !== undefined || record.legacyGroupId !== undefined) fail(where, 'classic 不能指定组合字段');
      const unit = classic(record.definition, sourceMap, exactImages, where); unitId = unit.id; classicUnits.set(unitId, unit);
    } else fail(where, '篇目种类无效');
    if (unitRecords.slice(0, index).some(prior => (prior as { definition: { id: string } }).definition.id === unitId)) fail(where, '重复篇目ID');
  }
  const groups = new Map<string, ReadingPaperDefinition>();
  for (const [index, entry] of arr(data.legacyGroups, 'legacyGroups', 0, 100).entries()) {
    const where = `legacyGroups[${index}]`, group = obj(entry, where, ['id', 'title', 'level', 'background', 'estimatedMinutes', 'passages']);
    const groupId = id(group.id, where); if (groups.has(groupId) || definitions.has(groupId) || classicUnits.has(groupId)) fail(where, '重复容器ID');
    str(group.title, where); str(group.background, where); level(group.level, where); int(group.estimatedMinutes, where, 0, 600);
    const passages = arr(group.passages, where, 1, 30).map(ref => {
      const part = obj(ref, where, ['unitId', 'title'], ['unitId']); const p = definitions.get(id(part.unitId, where)); if (!p) fail(where, '历史容器引用不存在的篇目');
      if (part.title !== undefined) str(part.title, where); const { level: _level, estimatedMinutes: _minutes, ...raw } = p;
      return { ...raw, ...(part.title !== undefined ? { title: String(part.title) } : {}) } as PaperPassageDefinition;
    }); unique(passages.map(p => p.id), where);
    groups.set(groupId, { id: groupId, title: String(group.title), level: group.level as ReadingPaperDefinition['level'], background: String(group.background), estimatedMinutes: Number(group.estimatedMinutes), passages });
  }
  const units: ReadingDefinition[] = data.units.map(record => {
    if (record.kind === 'classic') return record.definition;
    if (record.composition === 'split') { const group = groups.get(record.legacyGroupId!); if (!group || !group.passages.some(p => p.id === record.definition.id)) fail(record.definition.id, '历史组合引用不匹配'); const { level: _level, estimatedMinutes: _minutes, ...p } = record.definition; return composeReadingPassage(group, p); }
    return composeIndependentReading(record.definition);
  });
  const legacyUnits = [...groups.values()].map(composeReadingPaper), paragraphs: Record<string, ReadingPackageParagraphs> = Object.create(null), questionFingerprints: Record<string, string> = Object.create(null), unitFingerprints: Record<string, string> = Object.create(null);
  let questionCount = 0;
  for (const record of data.units) {
    const d = record.definition, source = sourceMap.get(d.materialId)!;
    const pool = record.kind === 'passage' ? record.definition.optionPool : undefined;
    for (const q of d.questions) {
      if (++questionCount > READING_PACKAGE_LIMITS.questions) fail('questions', '题目数量超过限制');
      const labelContext = record.kind === 'passage' && record.definition.type === 'matching'
        ? { labelContext: (q.options ?? pool)!.map(option => ({ label: option.id, paragraphs: record.definition.paragraphLabels!.find(label => label.label === option.id)!.paragraphs })) }
        : {};
      const fingerprint = hash(canonicalReadingPackageJson({ type: q.type, prompt: q.prompt, options: q.options ?? pool ?? null, expected: q.expected, accepted: q.accepted ?? [], firstLetter: q.firstLetter ?? null, wordLimit: q.wordLimit ?? null, sourceSha256: source.en.sha256, masks: record.kind === 'passage' ? (record.definition.masks ?? []).filter(mask => mask.questionId === q.id).map(({ questionId: _id, ...mask }) => mask) : [], ...labelContext }));
      if (questionFingerprints[q.id] && questionFingerprints[q.id] !== fingerprint) fail(q.id, '同一逻辑题号存在不同的判分或英文上下文'); questionFingerprints[q.id] = fingerprint;
    }
  }
  for (const unit of [...units, ...legacyUnits]) {
    paragraphs[unit.id] = loadParagraphs(unit, sourceMap);
    unitFingerprints[unit.id] = hash(canonicalReadingPackageJson({ unit, paragraphs: paragraphs[unit.id], images: (data.images.filter(image => image.path === unit.coverPath || unit.paper?.passages.some(p => p.coverPath === image.path))).map(({ dataBase64: _bytes, ...image }) => image) }));
  }
  return { data, digest: hash(json), units, legacyUnits, paragraphs, questionFingerprints, unitFingerprints };
}
export function encodeReadingPackage(data: ReadingPackageData): Buffer {
  const valid = validateReadingPackage(data), bytes = gzipSync(Buffer.from(canonicalReadingPackageJson(valid.data), 'utf8'), { level: 9 });
  if (bytes.length > READING_PACKAGE_LIMITS.compressedBytes) fail('文件', '压缩后数据超过限制'); return bytes;
}
export function decodeReadingPackage(bytes: Buffer, options: { appVersion?: string } = {}): ValidatedReadingPackage {
  if (!Buffer.isBuffer(bytes) || bytes.length < 18 || bytes.length > READING_PACKAGE_LIMITS.compressedBytes || bytes[0] !== 31 || bytes[1] !== 139) fail('文件', '不是受支持的 gzip 题库或超过大小限制');
  let raw: Buffer;
  try { raw = gunzipSync(bytes, { maxOutputLength: READING_PACKAGE_LIMITS.decompressedBytes }); } catch { return fail('文件', 'gzip 数据损坏或解压后超过大小限制'); }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return fail('JSON', '必须是有效的 UTF-8 JSON 数据'); }
  return validateReadingPackage(input, options);
}
