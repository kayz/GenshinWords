import crypto from 'node:crypto';
import type { PracticeWord, SelfTestMode, StudyExercise } from '../shared/practice';
import { getLearningWords } from './learning-list';
import { equivalentSpellings, normalizeAnswer } from './spelling';

type TestWord = PracticeWord & { pos?: string };
type Solution = { id: string; wordId: number; expected: string; lemma: string; accepted: string[] };
function shuffled<T>(values: T[]): T[] {
  const items = [...values];
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function meaningTokens(translation: string): string[] {
  return translation.split(/[;；,，、/|]/).map(part => part.replace(/[a-z]+\./gi, '').replace(/\([^)]*\)|（[^）]*）/g, '').replace(/\s/g, '').trim()).filter(Boolean);
}
/** 排除共享词义、包含关系和重复选项；资料不足时使用拼写，避免硬凑干扰项。 */
function overlaps(a: string[], b: string[]): boolean {
  return a.some(left => b.some(right => left === right || left.includes(right) || right.includes(left)));
}
export function createWordSelfTest(bookId: string, word: TestWord, mode: SelfTestMode = 'meaning') {
  const phonetic = word.phonetic || word.phonetic_uk || word.phonetic_us || '';
  const exercise: StudyExercise = {
    id: crypto.randomUUID(), bookId, kind: 'spelling', title: '重点拼写自测',
    sourceTitle: '本地词典 · 单词自测', sourceUrl: null, coverPath: null,
    prompt: '根据释义或发音填写单词；自测通过后仍需按记忆曲线复习。',
    parts: [{ blankId: 'answer' }],
    blanks: [{ id: 'answer', wordId: word.id, firstLetter: Array.from(word.lemma)[0] || '',
      translation: word.translation || '', length: Array.from(word.lemma).length, phonetic }],
  };
  let solutions: Solution[] = [{ id: 'answer', wordId: word.id, expected: word.lemma, lemma: word.lemma,
    accepted: [...new Set([normalizeAnswer(word.lemma), ...equivalentSpellings(word.lemma, word.lemma)])] }];
  if (mode === 'meaning' && word.translation?.trim()) {
    const candidates: TestWord[] = getLearningWords(bookId);
    const pool = shuffled(candidates.filter(candidate => candidate.id !== word.id && candidate.translation?.trim()));
    pool.sort((a, b) => Number(b.pos === word.pos) - Number(a.pos === word.pos));
    const meanings = [word.translation.trim()];
    const tokens = [meaningTokens(word.translation)];
    for (const candidate of pool) {
      const candidateTokens = meaningTokens(candidate.translation);
      if (!candidateTokens.length || tokens.some(parts => overlaps(parts, candidateTokens))) continue;
      meanings.push(candidate.translation.trim());
      tokens.push(candidateTokens);
      if (meanings.length === 4) break;
    }
    if (meanings.length === 4) {
      const options = shuffled(meanings.map(text => ({ id: crypto.randomUUID(), text })));
      const correct = options.find(option => option.text === word.translation.trim())!;
      exercise.kind = 'recognition';
      exercise.title = '英文认义自测';
      exercise.prompt = '选择这个词在本地词典中收录的释义。答题时不显示词卡答案。';
      exercise.options = options;
      exercise.parts = [{ text: word.lemma }];
      exercise.blanks = [{ id: 'answer', wordId: word.id, firstLetter: '', translation: '', length: 0 }];
      solutions = [{ id: 'answer', wordId: word.id, expected: correct.text, lemma: word.lemma,
        accepted: [normalizeAnswer(correct.id)] }];
    }
  }
  if (exercise.kind === 'spelling' && !word.translation?.trim() && !phonetic && !word.audio_uk && !word.audio_us)
    exercise.letterBank = Array.from(word.lemma).sort().join(' ');
  return { exercise, solutions };
}
