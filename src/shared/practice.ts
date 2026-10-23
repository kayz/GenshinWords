import type { WordRewardEntry } from './rewards';
export type SelfTestMode = 'meaning' | 'spelling';
export type PracticeKind = 'reading' | 'dialogue' | 'spelling' | 'collection' | 'recognition';

export interface PracticeWord {
  id: number;
  lemma: string;
  translation: string;
  phonetic?: string;
  phonetic_uk?: string;
  phonetic_us?: string;
  audio_uk?: string | null;
  audio_us?: string | null;
}

export interface PracticeSource {
  kind: PracticeKind;
  title: string;
  sourceTitle: string;
  sourceUrl: string | null;
  coverPath: string | null;
  speaker?: string;
  text: string;
  start: number;
  end: number;
}

export interface StudyExercise {
  id: string;
  bookId: string;
  kind: PracticeKind;
  title: string;
  sourceTitle: string;
  sourceUrl: string | null;
  coverPath: string | null;
  speaker?: string;
  prompt: string;
  letterBank?: string;
  options?: Array<{ id: string; text: string }>;
  parts: Array<{ text: string } | { blankId: string }>;
  blanks: Array<{
    id: string;
    wordId: number;
    firstLetter: string;
    translation: string;
    length: number;
    phonetic?: string;
  }>;
}

export interface ExerciseResult {
  answers: Array<{ id: string; correct: boolean; expected: string; lemma: string }>;
  earned: WordRewardEntry[];
  firstCorrect?: boolean;
  attempts?: number;
  total: number;
  alreadySubmitted: boolean;
}
