import type { ReadingRewardEntry } from './rewards';
export const READING_LEVELS = {
  entry: '初中基础', sh_zhongkao: '上海中考', sh_gaokao: '上海高考', cet4: '四级', cet6: '六级',
} as const;
export type ReadingLevel = keyof typeof READING_LEVELS;
export interface ReadingLocationRequest { questionId?: string; paragraph?: number; attemptId?: string }
export interface ReadingLocation { unitId: string; questionId?: string; paragraph?: number; attemptId?: string }
export interface ReadingGloss { term: string; explanation: string; kind: 'word' | 'genshin' }
export interface ReadingQuestion {
  passageId?: string; pooled?: boolean; id: string; type: 'choice' | 'fill'; format: string; prompt: string; skill: string; hint: string;
  options?: Array<{ id: string; text: string }>; firstLetter?: string; wordLimit?: number;
}
export type ReadingCompletionStatus = 'unsubmitted' | 'completed' | 'perfect';
export interface ReadingUnitSummary {
  contentVersion?: string; packageName?: string; updateAvailable?: boolean;
  practiceType?: ReadingPassage['type'];
  kind?: 'single' | 'paper'; passageCount?: number; estimatedMinutes?: number; id: string; title: string; level: ReadingLevel; wordCount: number; questionCount: number;
  answered: number; firstCorrect: number; rewarded: number; background: string;
  completionStatus: ReadingCompletionStatus;
}
export interface ReadingUnit extends ReadingUnitSummary {
  answers?: Record<string, string>; answerResults?: Record<string, ReadingAnswerResult>; answersViewed?: boolean;
  paperResult?: ReadingPaperResult | null; rewardAnimationPending?: boolean;
  sections?: ReadingPassage[]; attemptId: string; sourceTitle: string; sourceUrl: string; coverPath: string | null;
  coverFocus: { x: number; y: number }; paragraphs: string[];
  glossary: ReadingGloss[]; questions: ReadingQuestion[];
}
export interface ReadingAnswerResult {
  questionId: string; correct: boolean; firstCorrect: boolean; attempts: number;
  earned: ReadingRewardEntry[]; total: number; rewarded: boolean; duplicate: boolean;
  assisted: boolean; hintUsed?: boolean;
}
export interface ReadingExplanation {
  questionId: string; answer: string; answerId?: string; explanation: string;
  evidence: number[]; optionExplanations?: Array<{ id: string; text: string }>;
}
export interface ReadingBilingualParagraph { paragraph: number; textEn: string; textChs: string }
export interface ReadingPaperResult {
  attemptId: string; score: number; maxScore: number; correct: number; total: number;
  answers: Record<string, string>; questionResults: Record<string, ReadingAnswerResult>;
  earned: ReadingRewardEntry[]; earnedCount: number; rewardAnimationPending: boolean;
  duplicate: boolean; submittedAt: string; assisted: boolean;
}
export interface ReadingAnalysis {
  bilingualParagraphs: ReadingBilingualParagraph[];
  overview: string; structure: Array<{ paragraphs: number[]; description: string }>;
  sentences: Array<{ paragraph: number; text: string; explanation: string }>;
  glossary: ReadingGloss[]; questions: ReadingExplanation[];
}
export interface ReadingDocument {
  unit: Omit<ReadingUnit, 'attemptId'>; analysis: ReadingAnalysis;
}

export interface ReadingPassage {
  id: string; title: string; type: string; instructions: string;
  sourceTitle: string; sourceUrl: string; coverPath: string; coverFocus: { x: number; y: number };
  paragraphIndices: number[]; questionIds: string[];
  glossary?: ReadingGloss[];
  optionPool?: Array<{id: string; text: string}>;
  paragraphLabels?: Array<{label: string; paragraphs: number[]}>;
}
